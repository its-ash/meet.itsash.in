use std::borrow::Cow;
use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicU8, AtomicU32, AtomicU64, Ordering::Relaxed};
use std::sync::mpsc::{self, Receiver, SyncSender, TrySendError};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread;
use std::time::{Duration, Instant, SystemTime};

use anyhow::{Context as _, Result, anyhow, bail};
use bytes::Bytes;
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{FromSample, Sample as _, SampleFormat, SizedSample};
use eframe::egui;
use nokhwa::Camera;
use nokhwa::pixel_format::RgbAFormat;
use nokhwa::utils::{ApiBackend, CameraIndex, FrameFormat, RequestedFormat, RequestedFormatType};
use openh264::OpenH264API;
use openh264::decoder::Decoder;
use openh264::encoder::{BitRate, Encoder, EncoderConfig, FrameRate, IntraFramePeriod, RateControlMode, UsageType};
use openh264::formats::{RgbaSliceU8, YUVBuffer, YUVSource};
use sonora::{AudioProcessing, Config, StreamConfig as ApmConfig};
use wasm_audio::Enhancer;
use webrtc::api::media_engine::{MIME_TYPE_H264, MIME_TYPE_OPUS};
use webrtc::media::Sample;
use webrtc::media::io::sample_builder::SampleBuilder;
use webrtc::rtp::codecs::h264::H264Packet;
use webrtc::rtp_transceiver::rtp_codec::RTCRtpCodecCapability;
use webrtc::track::track_local::track_local_static_sample::TrackLocalStaticSample;
use webrtc::track::track_remote::TrackRemote;

use crate::call::rt;

pub const SR: u32 = 48_000;
pub const OPUS_FMTP: &str = "minptime=10;useinbandfec=1";
pub const H264_FMTP: &str = "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f";
const FRAME: usize = 480;
const PACKET: usize = 960;
const MAX_PCM: usize = 5760;
const PRIME: usize = 1920;
const PLAY_MAX: usize = 12_000;
const PLAY_TRIM: usize = 3_840;
const FAR_MAX: usize = 9_600;
const MIC_MAX: usize = 24_000;
const AEC_DELAY_MS: i32 = 60;

pub fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

pub struct Frame {
    pub w: usize,
    pub h: usize,
    pub rgba: Vec<u8>,
    pub seq: u64,
    pub at: Instant,
}

static SEQ: AtomicU64 = AtomicU64::new(1);

#[derive(Default)]
pub struct Slot(Mutex<Option<Frame>>);

impl Slot {
    pub fn put(&self, w: usize, h: usize, rgba: Vec<u8>) -> Option<Vec<u8>> {
        let f = Frame { w, h, rgba, seq: SEQ.fetch_add(1, Relaxed), at: Instant::now() };
        lock(&self.0).replace(f).map(|o| o.rgba)
    }

    pub fn clear(&self) {
        lock(&self.0).take();
    }

    pub fn with<R>(&self, f: impl FnOnce(Option<&Frame>) -> R) -> R {
        f(lock(&self.0).as_ref())
    }
}

pub struct Pipes {
    pub audio: Arc<TrackLocalStaticSample>,
    pub video: Arc<TrackLocalStaticSample>,
    pub key: AtomicBool,
    pub bps: AtomicU32,
    pub loss: AtomicU8,
    pub muted: AtomicBool,
    pub play: Mutex<VecDeque<f32>>,
    pub far: Mutex<VecDeque<f32>>,
    pub remote: Slot,
    pub local: Slot,
    pub notice: Mutex<Option<String>>,
    pub ctx: egui::Context,
}

impl Pipes {
    pub fn new(ctx: egui::Context) -> Arc<Self> {
        let cap = |mime: &str, clock_rate, channels, fmtp: &str| RTCRtpCodecCapability {
            mime_type: mime.into(),
            clock_rate,
            channels,
            sdp_fmtp_line: fmtp.into(),
            rtcp_feedback: vec![],
        };
        let track = |c, id: &str| Arc::new(TrackLocalStaticSample::new(c, id.into(), "meet".into()));
        Arc::new(Self {
            audio: track(cap(MIME_TYPE_OPUS, SR, 2, OPUS_FMTP), "audio"),
            video: track(cap(MIME_TYPE_H264, 90_000, 0, H264_FMTP), "video"),
            key: AtomicBool::new(true),
            bps: AtomicU32::new(1_200_000),
            loss: AtomicU8::new(5),
            muted: AtomicBool::new(false),
            play: Mutex::default(),
            far: Mutex::default(),
            remote: Slot::default(),
            local: Slot::default(),
            notice: Mutex::default(),
            ctx,
        })
    }

    pub fn notify(&self, msg: impl Into<String>) {
        *lock(&self.notice) = Some(msg.into());
        self.ctx.request_repaint();
    }

    pub fn reset_remote(&self) {
        self.remote.clear();
        lock(&self.play).clear();
    }
}

struct Linear {
    step: f64,
    pos: f64,
    prev: f32,
}

impl Linear {
    fn new(from: u32, to: u32) -> Self {
        Self { step: f64::from(from.max(1)) / f64::from(to.max(1)), pos: 0.0, prev: 0.0 }
    }

    fn run(&mut self, input: &[f32], out: &mut Vec<f32>) {
        if (self.step - 1.0).abs() < 1e-9 {
            out.extend_from_slice(input);
            return;
        }
        let Some(&last) = input.last() else { return };
        let prev = self.prev;
        let v = |i: usize| if i == 0 { prev } else { input[i - 1] };
        let n = input.len() as f64;
        while self.pos < n {
            let i = self.pos as usize;
            let f = (self.pos - i as f64) as f32;
            out.push(v(i) + (v(i + 1) - v(i)) * f);
            self.pos += self.step;
        }
        self.pos -= n;
        self.prev = last;
    }
}

pub struct Handle {
    _stop: mpsc::Sender<()>,
}

fn hold(name: &str, build: impl FnOnce() -> Result<cpal::Stream> + Send + 'static) -> Result<Handle> {
    let (stop, wait) = mpsc::channel::<()>();
    let (tx, rx) = mpsc::sync_channel::<Result<()>>(1);
    thread::Builder::new().name(name.into()).spawn(move || {
        let r = build().and_then(|s| s.play().map(|_| s).context("Audio device did not start"));
        match r {
            Ok(s) => {
                let _ = tx.send(Ok(()));
                let _ = wait.recv();
                drop(s);
            }
            Err(e) => {
                let _ = tx.send(Err(e));
            }
        }
    })?;
    rx.recv().map_err(|_| anyhow!("Audio thread stopped"))??;
    Ok(Handle { _stop: stop })
}

fn names(list: Result<impl Iterator<Item = cpal::Device>, cpal::Error>) -> Vec<String> {
    list.map(|l| l.filter_map(|d| d.description().ok().map(|x| x.name().to_owned())).collect()).unwrap_or_default()
}

pub fn inputs() -> Vec<String> {
    names(cpal::default_host().input_devices())
}

pub fn outputs() -> Vec<String> {
    names(cpal::default_host().output_devices())
}

fn pick(
    list: Result<impl Iterator<Item = cpal::Device>, cpal::Error>,
    name: Option<&str>,
    fallback: Option<cpal::Device>,
) -> Option<cpal::Device> {
    name.and_then(|n| list.ok()?.find(|d| d.description().is_ok_and(|x| x.name() == n))).or(fallback)
}

macro_rules! by_format {
    ($fmt:expr, $f:ident, $($a:expr),*) => {
        match $fmt {
            SampleFormat::F32 => $f::<f32>($($a),*),
            SampleFormat::F64 => $f::<f64>($($a),*),
            SampleFormat::I16 => $f::<i16>($($a),*),
            SampleFormat::I32 => $f::<i32>($($a),*),
            SampleFormat::I8 => $f::<i8>($($a),*),
            SampleFormat::U16 => $f::<u16>($($a),*),
            SampleFormat::U8 => $f::<u8>($($a),*),
            f => bail!("Unsupported audio format {f:?}"),
        }
    };
}

pub fn start_mic(p: Arc<Pipes>, name: Option<String>) -> Result<Handle> {
    let (tx, rx) = mpsc::sync_channel::<Vec<f32>>(64);
    let e = p.clone();
    let h = hold("mic", move || {
        let h = cpal::default_host();
        let d = pick(h.input_devices(), name.as_deref(), h.default_input_device()).context("No microphone found")?;
        let c = d.default_input_config()?;
        by_format!(c.sample_format(), input, &d, c.config(), tx, e)
    })?;
    thread::Builder::new().name("send".into()).spawn(move || send_loop(p, rx))?;
    Ok(h)
}

fn input<T>(d: &cpal::Device, cfg: cpal::StreamConfig, tx: SyncSender<Vec<f32>>, p: Arc<Pipes>) -> Result<cpal::Stream>
where
    T: SizedSample,
    f32: FromSample<T>,
{
    let ch = usize::from(cfg.channels.max(1));
    let mut rs = Linear::new(cfg.sample_rate, SR);
    let mut mono = Vec::new();
    let s = d.build_input_stream(
        cfg,
        move |data: &[T], _: &_| {
            mono.clear();
            mono.extend(data.chunks(ch).map(|f| f.iter().map(|&s| f32::from_sample(s)).sum::<f32>() / f.len() as f32));
            let mut out = Vec::with_capacity(mono.len() * 2 + 2);
            rs.run(&mono, &mut out);
            let _ = tx.try_send(out);
        },
        move |err| p.notify(format!("Microphone error: {err}")),
        None,
    )?;
    Ok(s)
}

fn send_loop(p: Arc<Pipes>, rx: Receiver<Vec<f32>>) {
    let mut apm = AudioProcessing::builder()
        .config(Config { echo_canceller: Some(Default::default()), ..Default::default() })
        .capture_config(ApmConfig::new(SR, 1))
        .render_config(ApmConfig::new(SR, 1))
        .build();
    let mut enh = Enhancer::boxed(SR as f32);
    let mut enc = match OpusEnc::new() {
        Ok(e) => e,
        Err(e) => return p.notify(format!("Audio encoder failed: {e}")),
    };
    let mut acc: VecDeque<f32> = VecDeque::with_capacity(MIC_MAX);
    let mut pkt: Vec<f32> = Vec::with_capacity(PACKET);
    let (mut frame, mut out, mut sink) = ([0f32; FRAME], [0f32; FRAME], [0f32; FRAME]);
    let mut buf = [0u8; 1500];
    let mut loss = 0u8;
    while let Ok(chunk) = rx.recv() {
        acc.extend(chunk);
        if acc.len() > MIC_MAX {
            acc.drain(..acc.len() - FRAME * 4);
        }
        while acc.len() >= FRAME {
            frame.iter_mut().zip(acc.drain(..FRAME)).for_each(|(d, s)| *d = s);
            let far: Vec<f32> = {
                let mut f = lock(&p.far);
                let n = f.len() / FRAME * FRAME;
                f.drain(..n).collect()
            };
            for c in far.chunks_exact(FRAME) {
                let _ = apm.process_render_f32(&[c], &mut [&mut sink]);
            }
            let _ = apm.set_stream_delay_ms(AEC_DELAY_MS);
            if apm.process_capture_f32(&[&frame], &mut [&mut out]).is_err() {
                out = frame;
            }
            enh.run(&mut out);
            pkt.extend_from_slice(&out);
            if pkt.len() < PACKET {
                continue;
            }
            if p.muted.load(Relaxed) {
                pkt.fill(0.0);
            }
            let l = p.loss.load(Relaxed);
            if l != loss {
                loss = l;
                enc.loss(l);
            }
            if let Ok(n @ 1..) = enc.encode(&pkt[..PACKET], &mut buf) {
                let s = Sample {
                    data: Bytes::copy_from_slice(&buf[..n]),
                    duration: Duration::from_millis(20),
                    timestamp: SystemTime::now(),
                    ..Default::default()
                };
                let _ = rt().block_on(p.audio.write_sample(&s));
            }
            pkt.clear();
        }
    }
}

struct OpusEnc(*mut opus::OpusEncoder);

unsafe impl Send for OpusEnc {}

impl OpusEnc {
    fn new() -> Result<Self> {
        let mut err = 0i32;
        let st = unsafe { opus::opus_encoder_create(SR as i32, 1, opus::OPUS_APPLICATION_VOIP, &mut err) };
        if st.is_null() || err != opus::OPUS_OK {
            bail!("opus error {err}");
        }
        let e = Self(st);
        unsafe {
            opus::opus_encoder_ctl!(st, opus::OPUS_SET_BITRATE_REQUEST, 32_000i32);
            opus::opus_encoder_ctl!(st, opus::OPUS_SET_INBAND_FEC_REQUEST, 1i32);
            opus::opus_encoder_ctl!(st, opus::OPUS_SET_PACKET_LOSS_PERC_REQUEST, 5i32);
        }
        Ok(e)
    }

    fn loss(&mut self, pct: u8) {
        unsafe {
            opus::opus_encoder_ctl!(self.0, opus::OPUS_SET_PACKET_LOSS_PERC_REQUEST, i32::from(pct));
        }
    }

    fn encode(&mut self, pcm: &[f32], out: &mut [u8]) -> Result<usize> {
        let n = unsafe { opus::opus_encode_float(self.0, pcm.as_ptr(), pcm.len() as i32, out.as_mut_ptr(), out.len() as i32) };
        usize::try_from(n).map_err(|_| anyhow!("opus encode error {n}"))
    }
}

impl Drop for OpusEnc {
    fn drop(&mut self) {
        unsafe { opus::opus_encoder_destroy(self.0) }
    }
}

struct OpusDec(*mut opus::OpusDecoder);

unsafe impl Send for OpusDec {}

impl OpusDec {
    fn new() -> Result<Self> {
        let mut err = 0i32;
        let st = unsafe { opus::opus_decoder_create(SR as i32, 1, &mut err) };
        if st.is_null() || err != opus::OPUS_OK {
            bail!("opus error {err}");
        }
        Ok(Self(st))
    }

    fn decode(&mut self, data: Option<&[u8]>, fec: bool, out: &mut [f32], frame: usize) -> usize {
        let (ptr, len) = data.map_or((std::ptr::null(), 0), |d| (d.as_ptr(), d.len() as i32));
        let frame = frame.min(out.len()) as i32;
        let n = unsafe { opus::opus_decode_float(self.0, ptr, len, out.as_mut_ptr(), frame, i32::from(fec)) };
        usize::try_from(n).unwrap_or(0)
    }
}

impl Drop for OpusDec {
    fn drop(&mut self) {
        unsafe { opus::opus_decoder_destroy(self.0) }
    }
}

pub fn start_speaker(p: Arc<Pipes>, name: Option<String>) -> Result<Handle> {
    hold("speaker", move || {
        let h = cpal::default_host();
        let d = pick(h.output_devices(), name.as_deref(), h.default_output_device()).context("No speaker found")?;
        let c = d.default_output_config()?;
        by_format!(c.sample_format(), output, &d, c.config(), p)
    })
}

fn output<T>(d: &cpal::Device, cfg: cpal::StreamConfig, p: Arc<Pipes>) -> Result<cpal::Stream>
where
    T: SizedSample + FromSample<f32>,
{
    let ch = usize::from(cfg.channels.max(1));
    let mut rs = Linear::new(SR, cfg.sample_rate);
    let mut ready: VecDeque<f32> = VecDeque::new();
    let mut primed = false;
    let mut chunk = [0f32; FRAME];
    let mut tmp = Vec::with_capacity(FRAME * 8);
    let e = p.clone();
    let s = d.build_output_stream(
        cfg,
        move |data: &mut [T], _: &_| {
            let need = data.len() / ch;
            while ready.len() < need {
                {
                    let mut q = lock(&p.play);
                    if q.len() > PLAY_MAX {
                        let n = q.len() - PLAY_TRIM;
                        q.drain(..n);
                    }
                    primed |= q.len() >= PRIME;
                    let n = if primed { q.len().min(FRAME) } else { 0 };
                    chunk.iter_mut().zip(q.drain(..n)).for_each(|(d, s)| *d = s);
                    chunk[n..].fill(0.0);
                    primed &= n == FRAME;
                }
                {
                    let mut f = lock(&p.far);
                    f.extend(chunk);
                    if f.len() > FAR_MAX {
                        let n = f.len() - FAR_MAX;
                        f.drain(..n);
                    }
                }
                tmp.clear();
                rs.run(&chunk, &mut tmp);
                ready.extend(&tmp);
            }
            for (fr, s) in data.chunks_mut(ch).zip(ready.drain(..need)) {
                fr.fill(T::from_sample(s));
            }
        },
        move |err| e.notify(format!("Speaker error: {err}")),
        None,
    )?;
    Ok(s)
}

pub fn play_audio(p: Arc<Pipes>, track: Arc<TrackRemote>) {
    rt().spawn(async move {
        let Ok(mut dec) = OpusDec::new() else { return p.notify("Audio decoder failed") };
        let mut pcm = vec![0f32; MAX_PCM];
        let mut out = Vec::with_capacity(MAX_PCM * 2);
        let mut last: Option<u16> = None;
        while let Ok((pkt, _)) = track.read_rtp().await {
            let seq = pkt.header.sequence_number;
            let gap = last.map_or(1, |l| seq.wrapping_sub(l));
            if gap == 0 || gap > 0x8000 || pkt.payload.is_empty() {
                continue;
            }
            last = Some(seq);
            out.clear();
            if (3..=6).contains(&gap) {
                for _ in 0..gap - 2 {
                    let n = dec.decode(None, false, &mut pcm, PACKET);
                    out.extend_from_slice(&pcm[..n]);
                }
            }
            if (2..=6).contains(&gap) {
                let n = dec.decode(Some(&pkt.payload), true, &mut pcm, PACKET);
                out.extend_from_slice(&pcm[..n]);
            }
            let n = dec.decode(Some(&pkt.payload), false, &mut pcm, MAX_PCM);
            out.extend_from_slice(&pcm[..n]);
            lock(&p.play).extend(out.iter().copied());
        }
    });
}

pub fn play_video(p: Arc<Pipes>, track: Arc<TrackRemote>, pli: impl Fn(u32) + Send + Sync + 'static) {
    let (tx, rx) = mpsc::sync_channel::<Vec<u8>>(8);
    let need = Arc::new(AtomicBool::new(true));
    let (dp, dn) = (p.clone(), need.clone());
    if thread::Builder::new().name("vdec".into()).spawn(move || decode_loop(dp, rx, dn)).is_err() {
        return p.notify("Video decoder failed");
    }
    rt().spawn(async move {
        let mut sb = SampleBuilder::new(256, H264Packet::default(), 90_000);
        let ssrc = track.ssrc();
        let mut asked: Option<Instant> = None;
        loop {
            match tokio::time::timeout(Duration::from_secs(1), track.read_rtp()).await {
                Ok(Ok((pkt, _))) => {
                    sb.push(pkt);
                    while let Some(s) = sb.pop() {
                        match tx.try_send(s.data.to_vec()) {
                            Ok(()) => {}
                            Err(TrySendError::Full(_)) => need.store(true, Relaxed),
                            Err(TrySendError::Disconnected(_)) => return,
                        }
                    }
                }
                Ok(Err(_)) => return,
                Err(_) => {}
            }
            if need.load(Relaxed) && asked.is_none_or(|a| a.elapsed() >= Duration::from_secs(1)) {
                asked = Some(Instant::now());
                pli(ssrc);
            }
        }
    });
}

fn decode_loop(p: Arc<Pipes>, rx: Receiver<Vec<u8>>, need: Arc<AtomicBool>) {
    let mut dec = match Decoder::new() {
        Ok(d) => d,
        Err(e) => return p.notify(format!("Video decoder failed: {e}")),
    };
    let mut rgba = Vec::new();
    while let Ok(au) = rx.recv() {
        match dec.decode(&au) {
            Ok(Some(yuv)) => {
                let (w, h) = yuv.dimensions();
                if w == 0 || h == 0 {
                    continue;
                }
                rgba.resize(w * h * 4, 0);
                yuv.write_rgba8(&mut rgba);
                rgba = p.remote.put(w, h, std::mem::take(&mut rgba)).unwrap_or_default();
                need.store(false, Relaxed);
                p.ctx.request_repaint();
            }
            Ok(None) => {}
            Err(_) => need.store(true, Relaxed),
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Kind {
    Camera,
    Screen,
}

pub struct Capture {
    pub kind: Kind,
    stop: Arc<AtomicBool>,
    alive: Arc<AtomicBool>,
}

impl Capture {
    pub fn alive(&self) -> bool {
        self.alive.load(Relaxed)
    }
}

impl Drop for Capture {
    fn drop(&mut self) {
        self.stop.store(true, Relaxed);
    }
}

pub fn capture(p: Arc<Pipes>, kind: Kind, cam: Option<u32>) -> Result<Capture> {
    let stop = Arc::new(AtomicBool::new(false));
    let alive = Arc::new(AtomicBool::new(true));
    let (s, a) = (stop.clone(), alive.clone());
    p.local.clear();
    p.key.store(true, Relaxed);
    thread::Builder::new().name("capture".into()).spawn(move || {
        let r = match kind {
            Kind::Camera => camera_loop(&p, cam, &s),
            Kind::Screen => screen_loop(&p, &s),
        };
        a.store(false, Relaxed);
        match r {
            Err(e) if !s.load(Relaxed) => p.notify(match kind {
                Kind::Camera => format!("Camera stopped: {e}"),
                Kind::Screen => format!("Screen share stopped: {e}"),
            }),
            _ => p.ctx.request_repaint(),
        }
    })?;
    Ok(Capture { kind, stop, alive })
}

fn fit(src: &[u8], w: usize, h: usize, mw: usize, mh: usize) -> (usize, usize, Cow<'_, [u8]>) {
    let s = (mw as f32 / w as f32).min(mh as f32 / h as f32).min(1.0);
    let tw = (((w as f32 * s) as usize) & !1).max(2);
    let th = (((h as f32 * s) as usize) & !1).max(2);
    if tw == w && th == h {
        return (w, h, Cow::Borrowed(&src[..w * h * 4]));
    }
    let mut out = vec![0u8; tw * th * 4];
    for (y, row) in out.chunks_exact_mut(tw * 4).enumerate() {
        let sy = y * h / th;
        for (x, px) in row.chunks_exact_mut(4).enumerate() {
            let si = (sy * w + x * w / tw) * 4;
            px.copy_from_slice(&src[si..si + 4]);
        }
    }
    (tw, th, Cow::Owned(out))
}

fn emit(p: &Pipes, enc: &mut VideoEnc, rgba: &[u8], w: usize, h: usize, max: (usize, usize)) -> Result<()> {
    if w < 2 || h < 2 || rgba.len() < w * h * 4 {
        return Ok(());
    }
    let (fw, fh, data) = fit(rgba, w, h, max.0, max.1);
    let (pw, ph, pv) = fit(&data, fw, fh, 480, 270);
    p.local.put(pw, ph, pv.into_owned());
    p.ctx.request_repaint();
    enc.push(p, &data, fw, fh)
}

fn camera_loop(p: &Pipes, idx: Option<u32>, stop: &AtomicBool) -> Result<()> {
    let index = CameraIndex::Index(idx.unwrap_or(0));
    let req = || RequestedFormat::new::<RgbAFormat>(RequestedFormatType::None);
    let mut cam = (0..5)
        .find_map(|i| {
            if i > 0 {
                thread::sleep(Duration::from_millis(200));
            }
            Camera::new(index.clone(), req()).ok()
        })
        .context("Camera unavailable")?;
    let best = cam.compatible_camera_formats().ok().and_then(|l| {
        l.into_iter()
            .filter(|f| f.width() <= 1920 && f.frame_rate() >= 24 && f.format() != FrameFormat::GRAY)
            .min_by_key(|f| {
                let d = (i64::from(f.width()) - 1280).abs() + (i64::from(f.height()) - 720).abs();
                (d, f.format() == FrameFormat::MJPEG, (i64::from(f.frame_rate()) - 30).abs())
            })
    });
    if let Some(f) = best {
        let _ = cam.set_camera_requset(RequestedFormat::new::<RgbAFormat>(RequestedFormatType::Exact(f)));
    }
    cam.open_stream()?;
    let mut enc = VideoEnc::new(UsageType::CameraVideoRealTime);
    let r = (|| {
        while !stop.load(Relaxed) {
            let img = cam.frame()?.decode_image::<RgbAFormat>()?;
            let (w, h) = (img.width() as usize, img.height() as usize);
            emit(p, &mut enc, img.as_raw(), w, h, (1280, 720))?;
        }
        Ok(())
    })();
    let _ = cam.stop_stream();
    r
}

fn screen_loop(p: &Pipes, stop: &AtomicBool) -> Result<()> {
    let all = xcap::Monitor::all()?;
    let m = all.iter().find(|m| m.is_primary().unwrap_or(false)).or(all.first()).context("No screen found")?;
    let mut enc = VideoEnc::new(UsageType::ScreenContentRealTime);
    while !stop.load(Relaxed) {
        let t = Instant::now();
        let img = m.capture_image()?;
        let (w, h) = (img.width() as usize, img.height() as usize);
        emit(p, &mut enc, img.as_raw(), w, h, (1920, 1080))?;
        if let Some(r) = Duration::from_millis(100).checked_sub(t.elapsed()) {
            thread::sleep(r);
        }
    }
    Ok(())
}

struct VideoEnc {
    usage: UsageType,
    enc: Option<Encoder>,
    bps: u32,
    built: Instant,
    last: Option<Instant>,
    buf: Vec<u8>,
}

impl VideoEnc {
    fn new(usage: UsageType) -> Self {
        Self { usage, enc: None, bps: 0, built: Instant::now(), last: None, buf: Vec::new() }
    }

    fn push(&mut self, p: &Pipes, rgba: &[u8], w: usize, h: usize) -> Result<()> {
        let want = p.bps.load(Relaxed).clamp(100_000, 2_500_000);
        let drift = (f64::from(want) - f64::from(self.bps)).abs() / f64::from(self.bps.max(1));
        if self.enc.is_none() || (drift > 0.25 && self.built.elapsed() >= Duration::from_secs(3)) {
            let fps = if matches!(self.usage, UsageType::ScreenContentRealTime) { 10.0 } else { 30.0 };
            let cfg = EncoderConfig::new()
                .bitrate(BitRate::from_bps(want))
                .max_frame_rate(FrameRate::from_hz(fps))
                .usage_type(self.usage)
                .rate_control_mode(RateControlMode::Bitrate)
                .intra_frame_period(IntraFramePeriod::from_num_frames(60))
                .skip_frames(true);
            self.enc = Some(Encoder::with_api_config(OpenH264API::from_source(), cfg)?);
            self.bps = want;
            self.built = Instant::now();
        }
        let enc = self.enc.as_mut().context("Video encoder missing")?;
        if p.key.swap(false, Relaxed) {
            enc.force_intra_frame();
        }
        let yuv = YUVBuffer::from_rgb8_source(RgbaSliceU8::new(rgba, (w, h)));
        self.buf.clear();
        enc.encode(&yuv)?.write_vec(&mut self.buf);
        if self.buf.is_empty() {
            return Ok(());
        }
        let now = Instant::now();
        let duration = self.last.map_or(Duration::from_millis(33), |l| (now - l).clamp(Duration::from_millis(10), Duration::from_millis(200)));
        self.last = Some(now);
        let s = Sample { data: Bytes::copy_from_slice(&self.buf), duration, timestamp: SystemTime::now(), ..Default::default() };
        let _ = rt().block_on(p.video.write_sample(&s));
        Ok(())
    }
}

pub fn cameras() -> Vec<(u32, String)> {
    nokhwa::query(ApiBackend::Auto)
        .map(|l| l.into_iter().filter_map(|c| c.index().as_index().ok().map(|i| (i, c.human_name()))).collect())
        .unwrap_or_default()
}
