use std::sync::atomic::Ordering::Relaxed;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use anyhow::Result;
use futures_util::{SinkExt, StreamExt};
use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender, unbounded_channel};
use tokio::task::{JoinHandle, spawn_blocking};
use tokio::time::{MissedTickBehavior, interval, sleep_until, timeout};
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::{Error as WsError, Message};
use webrtc::api::APIBuilder;
use webrtc::api::interceptor_registry::{configure_nack, configure_rtcp_reports};
use webrtc::api::media_engine::{MIME_TYPE_H264, MIME_TYPE_OPUS, MediaEngine};
use webrtc::ice_transport::ice_candidate::RTCIceCandidateInit;
use webrtc::ice_transport::ice_connection_state::RTCIceConnectionState;
use webrtc::ice_transport::ice_server::RTCIceServer;
use webrtc::interceptor::registry::Registry;
use webrtc::peer_connection::RTCPeerConnection;
use webrtc::peer_connection::configuration::RTCConfiguration;
use webrtc::peer_connection::offer_answer_options::RTCOfferOptions;
use webrtc::peer_connection::sdp::session_description::RTCSessionDescription;
use webrtc::peer_connection::signaling_state::RTCSignalingState;
use webrtc::rtcp::payload_feedbacks::full_intra_request::FullIntraRequest;
use webrtc::rtcp::payload_feedbacks::picture_loss_indication::PictureLossIndication;
use webrtc::rtcp::payload_feedbacks::receiver_estimated_maximum_bitrate::ReceiverEstimatedMaximumBitrate;
use webrtc::rtcp::receiver_report::ReceiverReport;
use webrtc::rtp_transceiver::RTCPFeedback;
use webrtc::rtp_transceiver::rtp_codec::{RTCRtpCodecCapability, RTCRtpCodecParameters, RTPCodecType};
use webrtc::stats::StatsReportType;
use webrtc::track::track_local::TrackLocal;

use crate::media::{self, H264_FMTP, OPUS_FMTP, Pipes, SR, lock};
use crate::net::{self, Msg};

const PING: &str = r#"{"type":"ping"}"#;
const H264_BASE_FMTP: &str = "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42001f";
const HEARTBEAT: Duration = Duration::from_secs(2);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(8);
const SOCKET_DEAD: Duration = Duration::from_millis(6_500);
const RETRY_BASE_MS: u64 = 500;
const RETRY_MAX_MS: u64 = 4_000;
const FULL_POLL: Duration = Duration::from_secs(3);
const ICE_GRACE: Duration = Duration::from_secs(3);
const RECOVERY_MS: u64 = 15_000;
const MAX_RECOVERY_SHIFT: u32 = 2;
const MIN_BPS: u32 = 100_000;
const MAX_BPS: u32 = 2_500_000;

pub fn rt() -> &'static tokio::runtime::Runtime {
    static RT: OnceLock<tokio::runtime::Runtime> = OnceLock::new();
    RT.get_or_init(|| {
        tokio::runtime::Builder::new_multi_thread().enable_all().thread_name("rt").build().expect("tokio runtime")
    })
}

fn sid() -> &'static str {
    static SID: OnceLock<String> = OnceLock::new();
    SID.get_or_init(|| uuid::Uuid::new_v4().to_string())
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Status {
    Connecting,
    Waiting,
    Joining,
    Connected,
    Reconnecting,
    Full,
    Replaced,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Quality {
    Good,
    Fair,
    Poor,
}

#[derive(Clone, Copy, Debug)]
pub struct View {
    pub status: Status,
    pub quality: Quality,
    pub since: Option<Instant>,
}

enum In {
    Opened(u64, UnboundedSender<Message>),
    Text(u64, String),
    Closed(u64, Option<u16>),
    Cand(u64, RTCIceCandidateInit),
    Ice(u64, RTCIceConnectionState),
    Stop,
}

pub struct Call {
    view: Arc<Mutex<View>>,
    tx: UnboundedSender<In>,
}

impl Call {
    pub fn start(room: String, p: Arc<Pipes>) -> Self {
        let view = Arc::new(Mutex::new(View { status: Status::Connecting, quality: Quality::Good, since: None }));
        let (tx, rx) = unbounded_channel();
        let a = Actor {
            room,
            p,
            view: view.clone(),
            tx: tx.clone(),
            wsg: 0,
            ws: None,
            reader: None,
            joined: false,
            retries: 0,
            retry_at: None,
            last_rx: Instant::now(),
            ponged: false,
            pc: None,
            pcgen: 0,
            offerer: false,
            pending: Vec::new(),
            grace_at: None,
            recover_at: None,
            renegs: 0,
            connected: false,
        };
        rt().spawn(a.run(rx));
        Self { view, tx }
    }

    pub fn view(&self) -> View {
        *lock(&self.view)
    }
}

impl Drop for Call {
    fn drop(&mut self) {
        let _ = self.tx.send(In::Stop);
    }
}

async fn at(t: Option<Instant>) {
    match t {
        Some(t) => sleep_until(t.into()).await,
        None => std::future::pending().await,
    }
}

struct Actor {
    room: String,
    p: Arc<Pipes>,
    view: Arc<Mutex<View>>,
    tx: UnboundedSender<In>,
    wsg: u64,
    ws: Option<UnboundedSender<Message>>,
    reader: Option<JoinHandle<()>>,
    joined: bool,
    retries: u32,
    retry_at: Option<Instant>,
    last_rx: Instant,
    ponged: bool,
    pc: Option<Arc<RTCPeerConnection>>,
    pcgen: u64,
    offerer: bool,
    pending: Vec<RTCIceCandidateInit>,
    grace_at: Option<Instant>,
    recover_at: Option<Instant>,
    renegs: u32,
    connected: bool,
}

impl Actor {
    async fn run(mut self, mut rx: UnboundedReceiver<In>) {
        self.connect();
        let mut tick = interval(HEARTBEAT);
        tick.set_missed_tick_behavior(MissedTickBehavior::Delay);
        loop {
            tokio::select! {
                m = rx.recv() => match m {
                    None | Some(In::Stop) => break,
                    Some(m) => self.handle(m).await,
                },
                _ = tick.tick() => self.tick().await,
                _ = at(self.retry_at) => {
                    self.retry_at = None;
                    self.retry().await;
                }
                _ = at(self.grace_at) => {
                    self.grace_at = None;
                    self.restart().await;
                }
                _ = at(self.recover_at) => {
                    self.recover_at = None;
                    self.renegs += 1;
                    self.rejoin();
                }
            }
        }
        self.close_pc();
        self.drop_ws();
    }

    fn status(&self) -> Status {
        lock(&self.view).status
    }

    fn set(&self, s: Status) {
        {
            let mut v = lock(&self.view);
            v.status = s;
            if matches!(s, Status::Waiting | Status::Joining | Status::Full | Status::Replaced) {
                v.since = None;
            }
            if s == Status::Connected {
                v.since.get_or_insert_with(Instant::now);
            }
        }
        self.p.ctx.request_repaint();
    }

    fn send(&self, m: &Msg) {
        if let (Some(ws), Ok(s)) = (&self.ws, serde_json::to_string(m)) {
            let _ = ws.send(Message::text(s));
        }
    }

    fn drop_ws(&mut self) {
        self.ws = None;
        if let Some(r) = self.reader.take() {
            r.abort();
        }
    }

    fn connect(&mut self) {
        self.drop_ws();
        self.wsg += 1;
        let (g, tx, url) = (self.wsg, self.tx.clone(), net::ws_url(&self.room, sid()));
        self.reader = Some(tokio::spawn(async move {
            let ws = match timeout(CONNECT_TIMEOUT, connect_async(url.as_str())).await {
                Ok(Ok((ws, _))) => ws,
                Ok(Err(WsError::Http(r))) if r.status() == 409 => {
                    let _ = tx.send(In::Closed(g, Some(409)));
                    return;
                }
                _ => {
                    let _ = tx.send(In::Closed(g, None));
                    return;
                }
            };
            let (mut sink, mut stream) = ws.split();
            let (wtx, mut wrx) = unbounded_channel::<Message>();
            let writer = tokio::spawn(async move {
                while let Some(m) = wrx.recv().await {
                    if sink.send(m).await.is_err() {
                        return;
                    }
                }
                let _ = sink.close().await;
            });
            let _ = tx.send(In::Opened(g, wtx));
            let mut code = None;
            while let Some(m) = stream.next().await {
                match m {
                    Ok(Message::Text(t)) => {
                        let _ = tx.send(In::Text(g, t.to_string()));
                    }
                    Ok(Message::Close(f)) => {
                        code = f.map(|f| u16::from(f.code));
                        break;
                    }
                    Ok(_) => {}
                    Err(_) => break,
                }
            }
            writer.abort();
            let _ = tx.send(In::Closed(g, code));
        }));
    }

    fn rejoin(&mut self) {
        self.set(Status::Reconnecting);
        self.connect();
    }

    async fn retry(&mut self) {
        if self.status() == Status::Full {
            let room = self.room.clone();
            let n = spawn_blocking(move || net::room_count(&room, sid())).await.ok().and_then(Result::ok);
            if n.is_some_and(|n| n >= 2) {
                self.retry_at = Some(Instant::now() + FULL_POLL);
                return;
            }
        }
        self.connect();
    }

    async fn handle(&mut self, m: In) {
        match m {
            In::Opened(g, ws) if g == self.wsg => self.on_open(ws),
            In::Text(g, t) if g == self.wsg => {
                self.last_rx = Instant::now();
                if let Ok(m) = serde_json::from_str::<Msg>(&t) {
                    self.on_msg(m).await;
                }
            }
            In::Closed(g, code) if g == self.wsg => self.on_close(code),
            In::Cand(g, c) if g == self.pcgen => self.send(&Msg::IceCandidate {
                candidate: c.candidate,
                sdp_mid: Some(c.sdp_mid.filter(|m| !m.is_empty()).unwrap_or_else(|| "0".into())),
                sdp_m_line_index: Some(c.sdp_mline_index.unwrap_or(0)),
            }),
            In::Ice(g, s) if g == self.pcgen => self.on_ice(s).await,
            _ => {}
        }
    }

    fn on_open(&mut self, ws: UnboundedSender<Message>) {
        let _ = ws.send(Message::text(PING));
        self.ws = Some(ws);
        self.retries = 0;
        self.last_rx = Instant::now();
        self.ponged = false;
        if self.joined {
            self.close_pc();
        }
        self.joined = true;
        self.set(Status::Waiting);
    }

    fn on_close(&mut self, code: Option<u16>) {
        let opened = self.ws.take().is_some();
        self.reader = None;
        if code == Some(4001) {
            self.close_pc();
            self.set(Status::Replaced);
            return;
        }
        if !opened && code == Some(409) {
            self.close_pc();
            self.set(Status::Full);
            self.retry_at = Some(Instant::now() + FULL_POLL);
            return;
        }
        if self.joined {
            self.set(Status::Reconnecting);
        }
        self.retries += 1;
        let ms = (RETRY_BASE_MS << (self.retries - 1).min(8)).min(RETRY_MAX_MS);
        self.retry_at = Some(Instant::now() + Duration::from_millis(ms));
    }

    async fn tick(&mut self) {
        if let Some(ws) = &self.ws {
            if self.ponged && self.last_rx.elapsed() > SOCKET_DEAD {
                return self.rejoin();
            }
            let _ = ws.send(Message::text(PING));
        }
        let Some(pc) = self.pc.clone().filter(|_| self.connected) else { return };
        let (mut loss, mut rtt) = (0f64, 0f64);
        for r in pc.get_stats().await.reports.values() {
            if let StatsReportType::RemoteInboundRTP(s) = r {
                loss = loss.max(s.fraction_lost);
                rtt = rtt.max(s.round_trip_time.unwrap_or(0.0));
            }
        }
        let q = if loss > 0.08 || rtt > 0.4 {
            Quality::Poor
        } else if loss > 0.02 || rtt > 0.2 {
            Quality::Fair
        } else {
            Quality::Good
        };
        let changed = {
            let mut v = lock(&self.view);
            std::mem::replace(&mut v.quality, q) != q
        };
        if changed {
            self.p.ctx.request_repaint();
        }
    }

    async fn on_msg(&mut self, m: Msg) {
        match m {
            Msg::Pong => self.ponged = true,
            Msg::Ping => {}
            Msg::PeerJoined { role } => {
                self.close_pc();
                self.offerer = role == "offerer";
                self.set(Status::Joining);
                if self.ensure_pc().await.is_ok() && self.offerer {
                    self.offer(false).await;
                }
            }
            Msg::Offer { sdp } => {
                let _ = self.on_offer(sdp).await;
            }
            Msg::Answer { sdp } => {
                let _ = self.on_answer(sdp).await;
            }
            Msg::IceCandidate { candidate, sdp_mid, sdp_m_line_index } => {
                let c = RTCIceCandidateInit { candidate, sdp_mid, sdp_mline_index: sdp_m_line_index, username_fragment: None };
                match &self.pc {
                    Some(pc) if pc.remote_description().await.is_some() => {
                        let _ = pc.add_ice_candidate(c).await;
                    }
                    _ => self.pending.push(c),
                }
            }
            Msg::PeerLeft => {
                self.close_pc();
                self.set(Status::Waiting);
            }
        }
        if self.pc.is_some() && !self.connected {
            self.arm_recovery();
        }
    }

    async fn on_offer(&mut self, sdp: String) -> Result<()> {
        let pc = self.ensure_pc().await?;
        pc.set_remote_description(RTCSessionDescription::offer(sdp)?).await?;
        self.flush(&pc).await;
        let a = pc.create_answer(None).await?;
        pc.set_local_description(a.clone()).await?;
        let sdp = pc.local_description().await.map_or(a.sdp, |d| d.sdp);
        self.send(&Msg::Answer { sdp });
        Ok(())
    }

    async fn on_answer(&mut self, sdp: String) -> Result<()> {
        let Some(pc) = self.pc.clone() else { return Ok(()) };
        if pc.signaling_state() != RTCSignalingState::HaveLocalOffer {
            return Ok(());
        }
        pc.set_remote_description(RTCSessionDescription::answer(sdp)?).await?;
        self.flush(&pc).await;
        Ok(())
    }

    async fn flush(&mut self, pc: &RTCPeerConnection) {
        for c in std::mem::take(&mut self.pending) {
            let _ = pc.add_ice_candidate(c).await;
        }
    }

    async fn offer(&mut self, restart: bool) {
        let Some(pc) = self.pc.clone() else { return };
        if pc.signaling_state() != RTCSignalingState::Stable {
            return;
        }
        let opts = restart.then(|| RTCOfferOptions { ice_restart: true, ..Default::default() });
        let Ok(o) = pc.create_offer(opts).await else { return };
        if pc.set_local_description(o.clone()).await.is_err() {
            return;
        }
        let sdp = pc.local_description().await.map_or(o.sdp, |d| d.sdp);
        self.send(&Msg::Offer { sdp });
    }

    async fn on_ice(&mut self, s: RTCIceConnectionState) {
        match s {
            RTCIceConnectionState::Connected | RTCIceConnectionState::Completed => {
                self.grace_at = None;
                self.recover_at = None;
                self.renegs = 0;
                self.connected = true;
                self.set(Status::Connected);
            }
            RTCIceConnectionState::Disconnected => {
                self.connected = false;
                self.set(Status::Reconnecting);
                self.grace_at.get_or_insert(Instant::now() + ICE_GRACE);
            }
            RTCIceConnectionState::Failed => self.restart().await,
            _ => {}
        }
    }

    async fn restart(&mut self) {
        if self.pc.is_none() {
            return;
        }
        self.connected = false;
        self.set(Status::Reconnecting);
        self.arm_recovery();
        if self.offerer {
            self.offer(true).await;
        }
    }

    fn arm_recovery(&mut self) {
        let ms = RECOVERY_MS * (1 << self.renegs.min(MAX_RECOVERY_SHIFT)) * if self.offerer { 1 } else { 2 };
        self.recover_at.get_or_insert(Instant::now() + Duration::from_millis(ms));
    }

    fn close_pc(&mut self) {
        self.pcgen += 1;
        self.pending.clear();
        self.grace_at = None;
        self.recover_at = None;
        self.connected = false;
        if let Some(pc) = self.pc.take() {
            tokio::spawn(async move {
                let _ = pc.close().await;
            });
        }
        self.p.reset_remote();
    }

    async fn ensure_pc(&mut self) -> Result<Arc<RTCPeerConnection>> {
        if let Some(pc) = &self.pc {
            return Ok(pc.clone());
        }
        let ice = spawn_blocking(net::ice_servers).await.unwrap_or_default();
        let pc = new_pc(ice, &self.p, self.tx.clone(), self.pcgen).await?;
        self.pc = Some(pc.clone());
        Ok(pc)
    }
}

fn codec(mime: &str, clock_rate: u32, channels: u16, fmtp: &str, fb: &[(&str, &str)], pt: u8) -> RTCRtpCodecParameters {
    RTCRtpCodecParameters {
        capability: RTCRtpCodecCapability {
            mime_type: mime.into(),
            clock_rate,
            channels,
            sdp_fmtp_line: fmtp.into(),
            rtcp_feedback: fb.iter().map(|(t, p)| RTCPFeedback { typ: (*t).into(), parameter: (*p).into() }).collect(),
        },
        payload_type: pt,
        stats_id: String::new(),
    }
}

fn watch_rtcp(sender: Arc<webrtc::rtp_transceiver::rtp_sender::RTCRtpSender>, p: Arc<Pipes>, audio: bool) {
    tokio::spawn(async move {
        while let Ok((pkts, _)) = sender.read_rtcp().await {
            for k in pkts {
                let a = k.as_any();
                if a.is::<PictureLossIndication>() || a.is::<FullIntraRequest>() {
                    p.key.store(true, Relaxed);
                } else if let Some(r) = a.downcast_ref::<ReceiverEstimatedMaximumBitrate>() {
                    p.bps.store((r.bitrate as u32).clamp(MIN_BPS, MAX_BPS), Relaxed);
                } else if let Some(rr) = a.downcast_ref::<ReceiverReport>().and_then(|r| r.reports.first()) {
                    let pct = u32::from(rr.fraction_lost) * 100 / 256;
                    if audio {
                        p.loss.store(pct.clamp(3, 30) as u8, Relaxed);
                    } else {
                        let b = f64::from(p.bps.load(Relaxed));
                        let next = match pct {
                            0..2 => b * 1.08,
                            2..=10 => b,
                            _ => b * (1.0 - f64::from(pct) / 200.0),
                        };
                        p.bps.store((next as u32).clamp(MIN_BPS, MAX_BPS), Relaxed);
                    }
                }
            }
        }
    });
}

async fn new_pc(ice: Vec<RTCIceServer>, p: &Arc<Pipes>, tx: UnboundedSender<In>, g: u64) -> Result<Arc<RTCPeerConnection>> {
    let mut me = MediaEngine::default();
    let vfb = [("goog-remb", ""), ("ccm", "fir")];
    me.register_codec(codec(MIME_TYPE_OPUS, SR, 2, OPUS_FMTP, &[], 111), RTPCodecType::Audio)?;
    me.register_codec(codec(MIME_TYPE_H264, 90_000, 0, H264_FMTP, &vfb, 125), RTPCodecType::Video)?;
    me.register_codec(codec(MIME_TYPE_H264, 90_000, 0, H264_BASE_FMTP, &vfb, 102), RTPCodecType::Video)?;
    let reg = configure_rtcp_reports(configure_nack(Registry::new(), &mut me));
    let api = APIBuilder::new().with_media_engine(me).with_interceptor_registry(reg).build();
    let pc = Arc::new(api.new_peer_connection(RTCConfiguration { ice_servers: ice, ..Default::default() }).await?);
    let tracks: [(Arc<dyn TrackLocal + Send + Sync>, bool); 2] = [(p.audio.clone(), true), (p.video.clone(), false)];
    for (t, audio) in tracks {
        watch_rtcp(pc.add_track(t).await?, p.clone(), audio);
    }
    let (wp, tp) = (Arc::downgrade(&pc), p.clone());
    pc.on_track(Box::new(move |track, _, _| {
        let (p, wp) = (tp.clone(), wp.clone());
        match track.kind() {
            RTPCodecType::Audio => media::play_audio(p, track),
            RTPCodecType::Video => media::play_video(p, track, move |ssrc| {
                let Some(pc) = wp.upgrade() else { return };
                rt().spawn(async move {
                    let _ = pc.write_rtcp(&[Box::new(PictureLossIndication { sender_ssrc: 0, media_ssrc: ssrc })]).await;
                });
            }),
            _ => {}
        }
        Box::pin(async {})
    }));
    let ct = tx.clone();
    pc.on_ice_candidate(Box::new(move |c| {
        if let Some(init) = c.and_then(|c| c.to_json().ok()) {
            let _ = ct.send(In::Cand(g, init));
        }
        Box::pin(async {})
    }));
    pc.on_ice_connection_state_change(Box::new(move |s| {
        let _ = tx.send(In::Ice(g, s));
        Box::pin(async {})
    }));
    p.key.store(true, Relaxed);
    Ok(pc)
}
