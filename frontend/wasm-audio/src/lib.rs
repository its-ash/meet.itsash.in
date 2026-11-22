//! Real-time voice enhancer for an AudioWorklet.
//!
//! Chain: 90 Hz high-pass → RNNoise denoise (48 kHz) → VAD-driven gate →
//! slow speech leveler → presence EQ → soft-knee compressor → peak limiter.
//! Plain C ABI with no imports, so the worklet can instantiate the module
//! synchronously without wasm-bindgen glue.

use nnnoiseless::DenoiseState;

const FRAME: usize = DenoiseState::FRAME_SIZE;
const RNN_RATE: f32 = 48_000.0;
const MAX_BLOCK: usize = 1024;
const RING: usize = 4096;
const I16: f32 = 32_768.0;

const HPF_HZ: f32 = 90.0;
const PRESENCE_HZ: f32 = 3_200.0;
const PRESENCE_DB: f32 = 2.5;

const GATE_FLOOR: f32 = 0.18;
const GATE_HOLD_S: f32 = 0.25;
const GATE_OPEN_MS: f32 = 4.0;
const GATE_CLOSE_MS: f32 = 160.0;
const VAD_OPEN: f32 = 0.5;
const VAD_LEARN: f32 = 0.8;

const LEVEL_TARGET_DB: f32 = -23.0;
const LEVEL_MIN_DB: f32 = -6.0;
const LEVEL_MAX_DB: f32 = 15.0;
const LEVEL_TAU_S: f32 = 1.2;

const COMP_THRESHOLD_DB: f32 = -24.0;
const COMP_RATIO: f32 = 3.0;
const COMP_KNEE_DB: f32 = 6.0;
const COMP_MAKEUP_DB: f32 = 5.0;
const COMP_ATTACK_MS: f32 = 5.0;
const COMP_RELEASE_MS: f32 = 150.0;

const LIMIT_CEILING: f32 = 0.891;
const LIMIT_RELEASE_MS: f32 = 60.0;

const NOISE_RISE_DB: f32 = 0.05;
const ENERGY_VAD_MARGIN_DB: f32 = 9.0;

#[inline]
fn db_to_lin(db: f32) -> f32 {
    10f32.powf(db / 20.0)
}

#[inline]
fn pow_to_db(p: f32) -> f32 {
    10.0 * (p + 1e-12).log10()
}

#[inline]
fn smooth(sr: f32, ms: f32) -> f32 {
    (-1.0 / (ms * 0.001 * sr)).exp()
}

struct Biquad {
    b0: f32,
    b1: f32,
    b2: f32,
    a1: f32,
    a2: f32,
    z1: f32,
    z2: f32,
}

impl Biquad {
    fn new(b: [f32; 3], a: [f32; 3]) -> Self {
        Self { b0: b[0] / a[0], b1: b[1] / a[0], b2: b[2] / a[0], a1: a[1] / a[0], a2: a[2] / a[0], z1: 0.0, z2: 0.0 }
    }

    fn highpass(sr: f32, hz: f32) -> Self {
        let w = std::f32::consts::TAU * hz / sr;
        let (s, c) = w.sin_cos();
        let alpha = s / (2.0 * std::f32::consts::FRAC_1_SQRT_2);
        Self::new([(1.0 + c) / 2.0, -(1.0 + c), (1.0 + c) / 2.0], [1.0 + alpha, -2.0 * c, 1.0 - alpha])
    }

    fn peaking(sr: f32, hz: f32, q: f32, db: f32) -> Self {
        let a = 10f32.powf(db / 40.0);
        let w = std::f32::consts::TAU * hz / sr;
        let (s, c) = w.sin_cos();
        let alpha = s / (2.0 * q);
        Self::new([1.0 + alpha * a, -2.0 * c, 1.0 - alpha * a], [1.0 + alpha / a, -2.0 * c, 1.0 - alpha / a])
    }

    #[inline]
    fn run(&mut self, x: f32) -> f32 {
        let y = self.b0 * x + self.z1;
        self.z1 = self.b1 * x - self.a1 * y + self.z2;
        self.z2 = self.b2 * x - self.a2 * y;
        // Flush denormals: wasm has no FTZ mode and they stall the FPU.
        if self.z1.abs() < 1e-20 {
            self.z1 = 0.0;
        }
        if self.z2.abs() < 1e-20 {
            self.z2 = 0.0;
        }
        y
    }
}

struct Ring {
    buf: Vec<f32>,
    r: usize,
    w: usize,
}

impl Ring {
    fn new() -> Self {
        Self { buf: vec![0.0; RING], r: 0, w: 0 }
    }

    #[inline]
    fn len(&self) -> usize {
        self.w.wrapping_sub(self.r)
    }

    #[inline]
    fn push(&mut self, x: f32) {
        self.buf[self.w & (RING - 1)] = x;
        self.w = self.w.wrapping_add(1);
    }

    #[inline]
    fn pop(&mut self) -> f32 {
        let x = self.buf[self.r & (RING - 1)];
        self.r = self.r.wrapping_add(1);
        x
    }
}

pub struct Enhancer {
    input: [f32; MAX_BLOCK],
    output: [f32; MAX_BLOCK],
    frame_in: [f32; FRAME],
    frame_out: [f32; FRAME],
    fin: Ring,
    fout: Ring,
    rnn: Option<Box<DenoiseState<'static>>>,
    hpf: Biquad,
    presence: Biquad,
    noise_db: f32,
    hold: u32,
    hold_len: u32,
    gate: f32,
    level_db: f32,
    env: f32,
    lim: f32,
    k_level: f32,
    a_open: f32,
    a_close: f32,
    a_attack: f32,
    a_release: f32,
    a_lim: f32,
    makeup: f32,
}

impl Enhancer {
    fn new(sr: f32) -> Self {
        let mut fout = Ring::new();
        // Pre-roll one frame so every render quantum can be served while
        // the next 10 ms frame is still filling (constant 10 ms latency).
        for _ in 0..FRAME {
            fout.push(0.0);
        }
        Self {
            input: [0.0; MAX_BLOCK],
            output: [0.0; MAX_BLOCK],
            frame_in: [0.0; FRAME],
            frame_out: [0.0; FRAME],
            fin: Ring::new(),
            fout,
            rnn: ((sr - RNN_RATE).abs() < 1.0).then(DenoiseState::new),
            hpf: Biquad::highpass(sr, HPF_HZ),
            presence: Biquad::peaking(sr, PRESENCE_HZ, 1.0, PRESENCE_DB),
            noise_db: -60.0,
            hold: 0,
            hold_len: (GATE_HOLD_S * sr) as u32,
            gate: GATE_FLOOR,
            level_db: 0.0,
            env: 0.0,
            lim: 1.0,
            k_level: 1.0 - (-(FRAME as f32) / (LEVEL_TAU_S * sr)).exp(),
            a_open: smooth(sr, GATE_OPEN_MS),
            a_close: smooth(sr, GATE_CLOSE_MS),
            a_attack: smooth(sr, COMP_ATTACK_MS),
            a_release: smooth(sr, COMP_RELEASE_MS),
            a_lim: smooth(sr, LIMIT_RELEASE_MS),
            makeup: db_to_lin(COMP_MAKEUP_DB),
        }
    }

    /// Denoises `frame_in` into `frame_out`; returns speech probability.
    fn denoise(&mut self) -> f32 {
        if let Some(rnn) = self.rnn.as_mut() {
            for x in self.frame_in.iter_mut() {
                *x *= I16;
            }
            let vad = rnn.process_frame(&mut self.frame_out, &self.frame_in);
            for x in self.frame_out.iter_mut() {
                *x /= I16;
            }
            return vad;
        }
        // No RNNoise at this sample rate: energy VAD over a tracked noise floor.
        self.frame_out = self.frame_in;
        let db = pow_to_db(self.frame_in.iter().map(|x| x * x).sum::<f32>() / FRAME as f32);
        self.noise_db = if db < self.noise_db { db } else { self.noise_db + NOISE_RISE_DB };
        if db > self.noise_db + ENERGY_VAD_MARGIN_DB { 1.0 } else { 0.0 }
    }

    #[inline]
    fn compress_db(db: f32) -> f32 {
        let over = db - COMP_THRESHOLD_DB;
        let slope = 1.0 / COMP_RATIO - 1.0;
        if 2.0 * over <= -COMP_KNEE_DB {
            0.0
        } else if 2.0 * over >= COMP_KNEE_DB {
            slope * over
        } else {
            let k = over + COMP_KNEE_DB / 2.0;
            slope * k * k / (2.0 * COMP_KNEE_DB)
        }
    }

    fn run_frame(&mut self) {
        let vad = self.denoise();

        if vad >= VAD_OPEN {
            self.hold = self.hold_len;
        }
        if vad >= VAD_LEARN {
            let db = pow_to_db(self.frame_out.iter().map(|x| x * x).sum::<f32>() / FRAME as f32);
            let want = (LEVEL_TARGET_DB - db).clamp(LEVEL_MIN_DB, LEVEL_MAX_DB);
            self.level_db += (want - self.level_db) * self.k_level;
        }
        let level = db_to_lin(self.level_db);

        for i in 0..FRAME {
            let mut x = self.frame_out[i];

            let target = if self.hold > 0 { 1.0 } else { GATE_FLOOR };
            self.hold = self.hold.saturating_sub(1);
            let a = if target > self.gate { self.a_open } else { self.a_close };
            self.gate = target + (self.gate - target) * a;
            x *= self.gate * level;

            x = self.presence.run(x);

            let p = x * x;
            let a = if p > self.env { self.a_attack } else { self.a_release };
            self.env = p + (self.env - p) * a;
            x *= db_to_lin(Self::compress_db(pow_to_db(self.env))) * self.makeup;

            let peak = x.abs();
            let want = if peak > LIMIT_CEILING { LIMIT_CEILING / peak } else { 1.0 };
            self.lim = if want < self.lim { want } else { want + (self.lim - want) * self.a_lim };
            x *= self.lim;

            self.fout.push(x.clamp(-1.0, 1.0));
        }
    }

    fn process(&mut self, n: usize) {
        let n = n.min(MAX_BLOCK);
        for i in 0..n {
            let x = self.input[i];
            let x = if x.is_finite() { x } else { 0.0 };
            let y = self.hpf.run(x);
            self.fin.push(y);
        }
        while self.fin.len() >= FRAME {
            for i in 0..FRAME {
                self.frame_in[i] = self.fin.pop();
            }
            self.run_frame();
        }
        for i in 0..n {
            self.output[i] = if self.fout.len() > 0 { self.fout.pop() } else { 0.0 };
        }
    }
}

/// Returns an owned handle; release it with `destroy`.
#[no_mangle]
pub extern "C" fn create(sample_rate: f32) -> *mut Enhancer {
    let sr = if sample_rate.is_finite() && sample_rate >= 8_000.0 { sample_rate } else { RNN_RATE };
    Box::into_raw(Box::new(Enhancer::new(sr)))
}

/// # Safety
/// `e` must come from `create` and not be destroyed.
#[no_mangle]
pub unsafe extern "C" fn input_ptr(e: *mut Enhancer) -> *mut f32 {
    e.as_mut().map_or(std::ptr::null_mut(), |e| e.input.as_mut_ptr())
}

/// # Safety
/// `e` must come from `create` and not be destroyed.
#[no_mangle]
pub unsafe extern "C" fn output_ptr(e: *mut Enhancer) -> *const f32 {
    e.as_ref().map_or(std::ptr::null(), |e| e.output.as_ptr())
}

/// Number of samples one call can take.
#[no_mangle]
pub extern "C" fn max_block() -> usize {
    MAX_BLOCK
}

/// # Safety
/// `e` must come from `create` and not be destroyed.
#[no_mangle]
pub unsafe extern "C" fn process(e: *mut Enhancer, n: usize) {
    if let Some(e) = e.as_mut() {
        e.process(n);
    }
}

/// # Safety
/// `e` must come from `create`; it is invalid afterwards.
#[no_mangle]
pub unsafe extern "C" fn destroy(e: *mut Enhancer) {
    if !e.is_null() {
        drop(Box::from_raw(e));
    }
}
