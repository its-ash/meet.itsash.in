use std::sync::atomic::{AtomicBool, Ordering::Relaxed};
use std::sync::mpsc::{self, Receiver};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use anyhow::Result;
use eframe::egui::{
    self, Align2, Button, Color32, ColorImage, ComboBox, Context, CursorIcon, FontId, Frame, Id, Image, Key, Margin,
    Modal, Rect, RichText, Role, Sense, Stroke, TextEdit, TextureHandle, TextureId, TextureOptions, Ui, UiBuilder, Vec2,
    WidgetInfo, pos2, vec2,
};

use crate::call::{Call, Quality, Status};
use crate::icons::{self, Icon};
use crate::media::{self, Capture, Handle, Kind, Pipes, Slot, lock};
use crate::net;
use crate::perm::{self, Access, Dev};

const LIGHT_BG: Color32 = Color32::from_rgb(246, 247, 249);
const INK: Color32 = Color32::from_rgb(17, 24, 39);
const MUTED: Color32 = Color32::from_rgb(107, 114, 128);
const ACCENT: Color32 = Color32::from_rgb(37, 99, 235);
const DARK_BG: Color32 = Color32::from_rgb(11, 13, 18);
const TILE: Color32 = Color32::from_rgb(24, 28, 37);
const CTRL: Color32 = Color32::from_rgb(42, 47, 58);
const RED: Color32 = Color32::from_rgb(234, 67, 53);
const GREEN: Color32 = Color32::from_rgb(52, 168, 83);
const AMBER: Color32 = Color32::from_rgb(251, 188, 4);
const STALE: Duration = Duration::from_secs(3);
const NOTICE_FOR: Duration = Duration::from_secs(5);
const COPIED_FOR: Duration = Duration::from_millis(1_600);
const PERM_POLL: Duration = Duration::from_secs(1);
const SETTINGS: &str = if cfg!(target_os = "macos") { "System Settings" } else { "Settings" };
const CTL_W: f32 = 72.0;
const CTL_GAP: f32 = 10.0;
const CTL_R: f32 = 26.0;

pub struct App {
    code: String,
    err: Option<String>,
    busy: Option<Receiver<Result<String>>>,
    s: Option<Session>,
}

impl App {
    pub fn new(cc: &eframe::CreationContext<'_>) -> Self {
        cc.egui_ctx.set_visuals(egui::Visuals::light());
        egui_extras::install_image_loaders(&cc.egui_ctx);
        Self { code: String::new(), err: None, busy: None, s: None }
    }

    fn join(&mut self, ctx: &Context, room: String) {
        self.err = None;
        self.code.clear();
        self.s = Some(Session::new(ctx, room));
    }

    fn home(&mut self, ui: &mut Ui) {
        let ctx = ui.ctx().clone();
        if let Some(rx) = &self.busy
            && let Ok(r) = rx.try_recv()
        {
            self.busy = None;
            match r {
                Ok(room) => return self.join(&ctx, room),
                Err(e) => self.err = Some(format!("Could not create a meeting: {e}")),
            }
        }
        let busy = self.busy.is_some();
        egui::CentralPanel::no_frame().frame(Frame::NONE.fill(LIGHT_BG)).show(ui, |ui| {
            ui.vertical_centered(|ui| {
                ui.add_space((ui.available_height() * 0.5 - 140.0).max(24.0));
                ui.label(RichText::new("Meet").size(44.0).strong().color(INK));
                ui.add_space(28.0);
                let room = net::normalize_room(&self.code);
                let mut go = false;
                ui.horizontal(|ui| {
                    ui.add_space(((ui.available_width() - 368.0) / 2.0).max(0.0));
                    let r = ui.add(
                        TextEdit::singleline(&mut self.code)
                            .hint_text("Enter code or link")
                            .char_limit(200)
                            .font(FontId::proportional(18.0))
                            .margin(Margin::symmetric(12, 11))
                            .desired_width(260.0),
                    );
                    let join = ui.add_enabled(
                        room.is_some() && !busy,
                        Button::new((
                            RichText::new("Join").size(17.0).color(Color32::WHITE),
                            icons::ARROW.img(18.0).tint(Color32::WHITE),
                        ))
                        .fill(ACCENT)
                        .corner_radius(10)
                        .min_size(vec2(100.0, 44.0)),
                    );
                    go = join.clicked() || (r.lost_focus() && ui.input(|i| i.key_pressed(Key::Enter)));
                });
                if go && let Some(room) = room {
                    return self.join(&ctx, room);
                }
                ui.add_space(14.0);
                ui.label(RichText::new("or").color(MUTED));
                ui.add_space(14.0);
                let label = if busy { "Creating…" } else { "New meeting" };
                let new = ui.add_enabled(
                    !busy,
                    Button::new((icons::NEW.img(20.0).tint(INK), RichText::new(label).size(17.0).color(INK)))
                        .fill(Color32::WHITE)
                        .stroke(Stroke::new(1.0, Color32::from_rgb(209, 213, 219)))
                        .corner_radius(10)
                        .min_size(vec2(368.0, 44.0)),
                );
                if new.clicked() {
                    let (tx, rx) = mpsc::channel();
                    let c = ctx.clone();
                    let spawned = thread::Builder::new().name("new-room".into()).spawn(move || {
                        let _ = tx.send(net::new_room());
                        c.request_repaint();
                    });
                    match spawned {
                        Ok(_) => self.busy = Some(rx),
                        Err(e) => self.err = Some(format!("Could not create a meeting: {e}")),
                    }
                }
                if let Some(e) = &self.err {
                    ui.add_space(16.0);
                    ui.label(RichText::new(e).color(RED));
                }
            });
        });
    }
}

impl eframe::App for App {
    fn ui(&mut self, ui: &mut Ui, _: &mut eframe::Frame) {
        let Some(s) = self.s.as_mut() else { return self.home(ui) };
        match s.frame(ui) {
            Next::Stay => {}
            Next::Leave => self.s = None,
            Next::Replaced => {
                self.s = None;
                self.err = Some("This meeting was opened in another window.".into());
            }
        }
    }
}

enum Next {
    Stay,
    Leave,
    Replaced,
}

struct Perms {
    mic: Access,
    cam: Access,
    asking: bool,
}

fn ask(perms: &Arc<Mutex<Perms>>, ctx: &Context, want_cam: &Arc<AtomicBool>) {
    lock(perms).asking = true;
    let (pm, c, wc) = (perms.clone(), ctx.clone(), want_cam.clone());
    perm::request(Dev::Mic, move |a| {
        lock(&pm).mic = a;
        c.request_repaint();
        let (pc, cc, w) = (pm.clone(), c.clone(), wc.clone());
        perm::request(Dev::Camera, move |a| {
            {
                let mut g = lock(&pc);
                g.cam = a;
                g.asking = false;
            }
            if a != Access::Granted {
                w.store(false, Relaxed);
            }
            cc.request_repaint();
        });
    });
}

#[derive(Default)]
struct Tex {
    h: Option<TextureHandle>,
    seq: u64,
}

impl Tex {
    fn sync(&mut self, ctx: &Context, name: &str, slot: &Slot) -> Option<(TextureId, Vec2, Instant)> {
        slot.with(|f| {
            let f = f.filter(|f| f.w > 0 && f.h > 0 && f.rgba.len() == f.w * f.h * 4)?;
            if f.seq != self.seq || self.h.is_none() {
                let img = ColorImage::from_rgba_unmultiplied([f.w, f.h], &f.rgba);
                match &mut self.h {
                    Some(h) => h.set(img, TextureOptions::LINEAR),
                    None => self.h = Some(ctx.load_texture(name, img, TextureOptions::LINEAR)),
                }
                self.seq = f.seq;
            }
            Some((self.h.as_ref()?.id(), vec2(f.w as f32, f.h as f32), f.at))
        })
    }
}

type Lists = (Vec<String>, Vec<String>, Vec<(u32, String)>);

struct Session {
    room: String,
    p: Arc<Pipes>,
    call: Call,
    started: bool,
    spk: Option<Handle>,
    mic: Option<Handle>,
    mic_failed: bool,
    cap: Option<Capture>,
    perms: Arc<Mutex<Perms>>,
    want_cam: Arc<AtomicBool>,
    dlg: bool,
    dlg_seen: bool,
    polled: Instant,
    remote: Tex,
    local: Tex,
    devs: bool,
    lists: Option<Lists>,
    mic_name: Option<String>,
    spk_name: Option<String>,
    cam_idx: Option<u32>,
    notice: Option<(String, Instant)>,
    copied: Option<Instant>,
}

impl Session {
    fn new(ctx: &Context, room: String) -> Self {
        let p = Pipes::new(ctx.clone());
        let call = Call::start(room.clone(), p.clone());
        Self {
            room,
            p,
            call,
            started: false,
            spk: None,
            mic: None,
            mic_failed: false,
            cap: None,
            perms: Arc::new(Mutex::new(Perms {
                mic: perm::status(Dev::Mic),
                cam: perm::status(Dev::Camera),
                asking: false,
            })),
            want_cam: Arc::new(AtomicBool::new(false)),
            dlg: false,
            dlg_seen: false,
            polled: Instant::now(),
            remote: Tex::default(),
            local: Tex::default(),
            devs: false,
            lists: None,
            mic_name: None,
            spk_name: None,
            cam_idx: None,
            notice: None,
            copied: None,
        }
    }

    fn start(&mut self, ctx: &Context) {
        self.started = true;
        self.start_speaker();
        ask(&self.perms, ctx, &self.want_cam);
    }

    fn start_speaker(&mut self) {
        self.spk = None;
        match media::start_speaker(self.p.clone(), self.spk_name.clone()) {
            Ok(h) => self.spk = Some(h),
            Err(e) => self.p.notify(format!("Speaker unavailable: {e}")),
        }
    }

    fn start_mic(&mut self) {
        self.mic = None;
        match media::start_mic(self.p.clone(), self.mic_name.clone()) {
            Ok(h) => {
                self.mic = Some(h);
                self.mic_failed = false;
            }
            Err(e) => {
                self.mic_failed = true;
                self.p.notify(format!("Microphone unavailable: {e}"));
            }
        }
    }

    fn start_capture(&mut self, kind: Kind) {
        self.cap = None;
        match media::capture(self.p.clone(), kind, self.cam_idx) {
            Ok(c) => self.cap = Some(c),
            Err(e) => self.p.notify(format!("Could not start capture: {e}")),
        }
    }

    fn sharing(&self, kind: Kind) -> bool {
        self.cap.as_ref().is_some_and(|c| c.kind == kind && c.alive())
    }

    fn sync_perms(&mut self, ctx: &Context) {
        let (mic, cam, asking) = {
            let g = lock(&self.perms);
            (g.mic, g.cam, g.asking)
        };
        let blocked = !asking && (mic != Access::Granted || cam != Access::Granted);
        if blocked && self.polled.elapsed() >= PERM_POLL {
            self.polled = Instant::now();
            let mut g = lock(&self.perms);
            g.mic = perm::status(Dev::Mic);
            g.cam = perm::status(Dev::Camera);
        }
        if blocked {
            if !self.dlg_seen {
                self.dlg = true;
                self.dlg_seen = true;
            }
            ctx.request_repaint_after(PERM_POLL);
        } else if !asking {
            self.dlg = false;
            self.dlg_seen = false;
        }
        if mic == Access::Granted && self.mic.is_none() && !self.mic_failed {
            self.start_mic();
        }
        if cam == Access::Granted && self.want_cam.swap(false, Relaxed) {
            self.start_capture(Kind::Camera);
        }
    }

    fn toggle_mic(&mut self) {
        if self.mic.is_some() {
            self.p.muted.fetch_xor(true, Relaxed);
        } else if lock(&self.perms).mic == Access::Granted {
            self.start_mic();
        } else {
            self.dlg = true;
        }
    }

    fn toggle_cam(&mut self, ctx: &Context) {
        if self.sharing(Kind::Camera) {
            self.cap = None;
            self.p.local.clear();
            return;
        }
        let cam = lock(&self.perms).cam;
        match cam {
            Access::Granted => self.start_capture(Kind::Camera),
            Access::Prompt => {
                self.want_cam.store(true, Relaxed);
                ask(&self.perms, ctx, &self.want_cam);
            }
            Access::Denied => self.dlg = true,
        }
    }

    fn toggle_screen(&mut self) {
        if self.sharing(Kind::Screen) {
            self.cap = None;
            self.p.local.clear();
        } else {
            self.start_capture(Kind::Screen);
        }
    }

    fn frame(&mut self, ui: &mut Ui) -> Next {
        let ctx = ui.ctx().clone();
        let v = self.call.view();
        if v.status == Status::Replaced {
            return Next::Replaced;
        }
        if !self.started && !matches!(v.status, Status::Connecting | Status::Full) {
            self.start(&ctx);
        }
        if self.started {
            self.sync_perms(&ctx);
        }
        if let Some(n) = lock(&self.p.notice).take() {
            self.notice = Some((n, Instant::now()));
        }
        if self.cap.as_ref().is_some_and(|c| !c.alive()) {
            self.cap = None;
            self.p.local.clear();
        }
        let mut next = Next::Stay;
        egui::CentralPanel::no_frame().frame(Frame::NONE.fill(DARK_BG)).show(ui, |ui| {
            let full = ui.max_rect();
            let top = Rect::from_min_max(full.min, pos2(full.max.x, full.min.y + 56.0));
            let bottom = Rect::from_min_max(pos2(full.min.x, full.max.y - 100.0), full.max);
            let stage = Rect::from_min_max(pos2(full.min.x + 16.0, top.max.y), pos2(full.max.x - 16.0, bottom.min.y));
            self.top_bar(ui, top, v);
            if v.status == Status::Full {
                self.full_view(ui, stage);
            } else if v.status == Status::Waiting {
                self.waiting(ui, stage);
            } else {
                self.remote_tile(ui, stage, v.status);
            }
            self.local_tile(ui, stage);
            if self.controls(ui, bottom, v.status) {
                next = Next::Leave;
            }
            self.toast(ui, top);
        });
        self.devices(&ctx);
        self.perm_dialog(&ctx);
        ctx.request_repaint_after(Duration::from_millis(500));
        next
    }

    fn top_bar(&self, ui: &mut Ui, r: Rect, v: crate::call::View) {
        let p = ui.painter();
        let y = r.center().y;
        p.text(pos2(r.min.x + 20.0, y), Align2::LEFT_CENTER, format!("Meet · {}", self.room), FontId::proportional(16.0), Color32::WHITE);
        let text = match v.status {
            Status::Connecting => "Connecting…".to_owned(),
            Status::Waiting => "Waiting for others to join".to_owned(),
            Status::Joining => "Joining…".to_owned(),
            Status::Reconnecting => "Reconnecting…".to_owned(),
            Status::Full => "Meeting is full".to_owned(),
            Status::Replaced => String::new(),
            Status::Connected => v.since.map_or_else(String::new, |s| clock(s.elapsed())),
        };
        let x = r.max.x - 20.0;
        let font = FontId::proportional(15.0);
        if v.status == Status::Connected {
            let color = match v.quality {
                Quality::Good => GREEN,
                Quality::Fair => AMBER,
                Quality::Poor => RED,
            };
            let w = p.layout_no_wrap(text.clone(), font.clone(), Color32::WHITE).size().x;
            p.circle_filled(pos2(x - w - 12.0, y), 4.5, color);
        }
        p.text(pos2(x, y), Align2::RIGHT_CENTER, text, font, Color32::from_gray(200));
    }

    fn waiting(&mut self, ui: &mut Ui, stage: Rect) {
        let link = net::share_link(&self.room);
        let card = Rect::from_center_size(stage.center(), vec2(420.0_f32.min(stage.width()), 210.0));
        ui.painter().rect_filled(card, 16, TILE);
        ui.scope_builder(UiBuilder::new().max_rect(card.shrink(24.0)), |ui| {
            ui.vertical_centered(|ui| {
                ui.label(RichText::new("You're the only one here").size(20.0).strong().color(Color32::WHITE));
                ui.add_space(6.0);
                ui.label(RichText::new("Share this link to invite someone").color(Color32::from_gray(170)));
                ui.add_space(14.0);
                ui.label(RichText::new(&link).monospace().size(15.0).color(Color32::WHITE));
                ui.add_space(14.0);
                let copied = self.copied.is_some_and(|c| c.elapsed() < COPIED_FOR);
                let (icon, text) = if copied { (icons::CHECK, "Copied") } else { (icons::COPY, "Copy link") };
                let b = Button::new((icon.img(16.0).tint(Color32::WHITE), RichText::new(text).size(15.0).color(Color32::WHITE)))
                    .fill(ACCENT)
                    .corner_radius(10)
                    .min_size(vec2(140.0, 38.0));
                if ui.add(b).clicked() {
                    ui.ctx().copy_text(link.clone());
                    self.copied = Some(Instant::now());
                }
            });
        });
    }

    fn full_view(&self, ui: &mut Ui, stage: Rect) {
        let p = ui.painter();
        let c = stage.center();
        p.text(c - vec2(0.0, 16.0), Align2::CENTER_CENTER, "This meeting is full", FontId::proportional(22.0), Color32::WHITE);
        p.text(
            c + vec2(0.0, 16.0),
            Align2::CENTER_CENTER,
            "You will join when a spot opens.",
            FontId::proportional(15.0),
            Color32::from_gray(170),
        );
    }

    fn remote_tile(&mut self, ui: &mut Ui, stage: Rect, status: Status) {
        let ctx = ui.ctx().clone();
        let frame = self.remote.sync(&ctx, "remote", &self.p.remote).filter(|f| f.2.elapsed() < STALE);
        match frame {
            Some((id, size, _)) => {
                let r = fit(stage, size);
                ui.put(r, Image::new((id, r.size())).corner_radius(14));
            }
            None => {
                ui.painter().rect_filled(stage, 14, TILE);
                let text = match status {
                    Status::Connected => "Camera off",
                    Status::Reconnecting => "Reconnecting…",
                    _ => "Connecting…",
                };
                ui.painter().text(stage.center(), Align2::CENTER_CENTER, text, FontId::proportional(18.0), Color32::from_gray(170));
            }
        }
    }

    fn local_tile(&mut self, ui: &mut Ui, stage: Rect) {
        let Some(kind) = self.cap.as_ref().filter(|c| c.alive()).map(|c| c.kind) else { return };
        let ctx = ui.ctx().clone();
        let Some((id, size, _)) = self.local.sync(&ctx, "local", &self.p.local) else { return };
        let w = (stage.width() * 0.22).clamp(140.0, 280.0);
        let h = w * size.y / size.x.max(1.0);
        let r = Rect::from_min_size(stage.max - vec2(w + 16.0, h + 16.0), vec2(w, h));
        let uv = if kind == Kind::Camera {
            Rect::from_min_max(pos2(1.0, 0.0), pos2(0.0, 1.0))
        } else {
            Rect::from_min_max(pos2(0.0, 0.0), pos2(1.0, 1.0))
        };
        ui.put(r, Image::new((id, r.size())).uv(uv).corner_radius(12));
        ui.painter().rect_stroke(r, 12, Stroke::new(1.0, Color32::from_white_alpha(40)), egui::StrokeKind::Inside);
    }

    fn controls(&mut self, ui: &mut Ui, r: Rect, status: Status) -> bool {
        let ctx = ui.ctx().clone();
        let mut leave = false;
        let full = status == Status::Full;
        let muted = self.p.muted.load(Relaxed) || self.mic.is_none();
        let cam = self.sharing(Kind::Camera);
        let screen = self.sharing(Kind::Screen);
        let state = |on: bool| if on { (Color32::WHITE, INK) } else { (CTRL, Color32::WHITE) };
        let n = if full { 1.0 } else { 5.0 };
        ui.scope_builder(UiBuilder::new().max_rect(r), |ui| {
            ui.horizontal_centered(|ui| {
                ui.add_space(((r.width() - n * CTL_W - (n - 1.0) * CTL_GAP) / 2.0).max(16.0));
                ui.spacing_mut().item_spacing.x = CTL_GAP;
                if !full {
                    let (f, c) = if muted { (RED, Color32::WHITE) } else { state(false) };
                    let label = if self.mic.is_none() { "Mic off" } else if muted { "Unmute" } else { "Mute" };
                    if ctl(ui, if muted { icons::MIC_OFF } else { icons::MIC }, label, f, c) {
                        self.toggle_mic();
                    }
                    let (f, c) = state(cam);
                    if ctl(ui, if cam { icons::CAM } else { icons::CAM_OFF }, if cam { "Stop video" } else { "Camera" }, f, c) {
                        self.toggle_cam(&ctx);
                    }
                    let (f, c) = state(screen);
                    if ctl(ui, icons::SHARE, if screen { "Stop share" } else { "Share" }, f, c) {
                        self.toggle_screen();
                    }
                    let (f, c) = state(self.devs);
                    if ctl(ui, icons::DEVICES, "Devices", f, c) {
                        self.devs = !self.devs;
                    }
                }
                leave = ctl(ui, icons::LEAVE, "Leave", RED, Color32::WHITE);
            });
        });
        leave
    }

    fn toast(&mut self, ui: &mut Ui, top: Rect) {
        let Some((msg, at)) = &self.notice else { return };
        if at.elapsed() >= NOTICE_FOR {
            self.notice = None;
            return;
        }
        let p = ui.painter();
        let g = p.layout(msg.clone(), FontId::proportional(14.0), Color32::WHITE, 520.0);
        let r = Rect::from_center_size(pos2(top.center().x, top.max.y + 26.0), g.size() + vec2(28.0, 16.0));
        p.rect_filled(r, 10, Color32::from_rgba_unmultiplied(40, 44, 54, 240));
        p.galley(r.min + vec2(14.0, 8.0), g, Color32::WHITE);
    }

    fn devices(&mut self, ctx: &Context) {
        if !self.devs {
            return;
        }
        if self.lists.is_none() {
            let cams = if lock(&self.perms).cam == Access::Granted { media::cameras() } else { Vec::new() };
            self.lists = Some((media::inputs(), media::outputs(), cams));
        }
        let Some((ins, outs, cams)) = self.lists.clone() else { return };
        let (mut mic, mut spk, mut cam) = (self.mic_name.clone(), self.spk_name.clone(), self.cam_idx);
        let mut open = true;
        egui::Window::new("Devices")
            .open(&mut open)
            .collapsible(false)
            .resizable(false)
            .anchor(Align2::CENTER_BOTTOM, vec2(0.0, -100.0))
            .show(ctx, |ui| {
                ui.set_min_width(300.0);
                pick(ui, "Microphone", &mut mic, &ins);
                pick(ui, "Speaker", &mut spk, &outs);
                ui.label("Camera");
                let cur = cam.and_then(|i| cams.iter().find(|c| c.0 == i)).map_or("Default".to_owned(), |c| c.1.clone());
                ComboBox::from_id_salt("cam").selected_text(cur).width(280.0).show_ui(ui, |ui| {
                    ui.selectable_value(&mut cam, None, "Default");
                    for (i, n) in &cams {
                        ui.selectable_value(&mut cam, Some(*i), n);
                    }
                });
                ui.add_space(6.0);
                if ui.button("Refresh").clicked() {
                    self.lists = None;
                }
            });
        self.devs = open;
        if mic != self.mic_name {
            self.mic_name = mic;
            if self.mic.is_some() || self.mic_failed {
                self.start_mic();
            }
        }
        if spk != self.spk_name {
            self.spk_name = spk;
            if self.started {
                self.start_speaker();
            }
        }
        if cam != self.cam_idx {
            self.cam_idx = cam;
            if self.sharing(Kind::Camera) {
                self.start_capture(Kind::Camera);
            }
        }
    }

    fn perm_dialog(&mut self, ctx: &Context) {
        if !self.dlg {
            return;
        }
        let (mic, cam) = {
            let g = lock(&self.perms);
            (g.mic, g.cam)
        };
        let denied = mic == Access::Denied || cam == Access::Denied;
        let mut close = false;
        let frame = Frame::popup(&ctx.global_style()).inner_margin(28).corner_radius(16).fill(Color32::WHITE);
        let r = Modal::new(Id::unique("perm")).frame(frame).show(ctx, |ui| {
            ui.set_width(380.0);
            ui.vertical_centered(|ui| {
                ui.label(RichText::new("Allow microphone and camera").size(20.0).strong().color(INK));
                ui.add_space(10.0);
                let body = if denied {
                    format!("Access is blocked. Open {SETTINGS} → Privacy & Security, turn on Meet for the items below, then come back.")
                } else {
                    "Meet uses your microphone for the call. Your camera stays off until you turn it on.".to_owned()
                };
                ui.label(RichText::new(body).size(14.5).color(MUTED));
                ui.add_space(14.0);
                for (name, a) in [("Microphone", mic), ("Camera", cam)] {
                    let (t, c) = match a {
                        Access::Granted => ("Allowed", GREEN),
                        Access::Prompt => ("Not asked yet", AMBER),
                        Access::Denied => ("Blocked", RED),
                    };
                    ui.label(RichText::new(format!("{name}: {t}")).size(14.0).color(c));
                }
                ui.add_space(18.0);
                let label = if denied { format!("Open {SETTINGS}") } else { "Allow access".to_owned() };
                let b = Button::new((icons::SHIELD.img(18.0).tint(Color32::WHITE), RichText::new(label).size(15.0).color(Color32::WHITE)))
                    .fill(ACCENT)
                    .corner_radius(10)
                    .min_size(vec2(220.0, 42.0));
                if ui.add(b).clicked() {
                    if denied {
                        perm::open_settings(if mic == Access::Denied { Dev::Mic } else { Dev::Camera });
                    } else {
                        ask(&self.perms, ctx, &self.want_cam);
                    }
                }
                ui.add_space(6.0);
                let later = Button::new(RichText::new("Not now").size(14.0).color(MUTED)).frame(false).sense(Sense::click());
                close = ui.add(later).clicked();
            });
        });
        if close || r.should_close() {
            self.dlg = false;
        }
    }
}

fn ctl(ui: &mut Ui, icon: Icon, label: &str, fill: Color32, fg: Color32) -> bool {
    let (r, resp) = ui.allocate_exact_size(vec2(CTL_W, 2.0 * CTL_R + 24.0), Sense::click());
    resp.widget_info(|| WidgetInfo::labeled(Role::Button, true, label));
    let c = pos2(r.center().x, r.min.y + CTL_R);
    let fill = if resp.hovered() {
        fill.lerp_to_gamma(if fill == Color32::WHITE { Color32::GRAY } else { Color32::WHITE }, 0.15)
    } else {
        fill
    };
    let p = ui.painter();
    p.circle_filled(c, CTL_R, fill);
    if resp.has_focus() {
        p.circle_stroke(c, CTL_R + 3.0, Stroke::new(2.0, ACCENT));
    }
    icon.img(22.0).tint(fg).paint_at(ui, Rect::from_center_size(c, vec2(22.0, 22.0)));
    p.text(pos2(c.x, r.max.y - 8.0), Align2::CENTER_CENTER, label, FontId::proportional(12.5), Color32::from_gray(210));
    resp.on_hover_cursor(CursorIcon::PointingHand).clicked()
}

fn pick(ui: &mut Ui, label: &str, sel: &mut Option<String>, list: &[String]) {
    ui.label(label);
    let cur = sel.clone().unwrap_or_else(|| "Default".to_owned());
    ComboBox::from_id_salt(label).selected_text(cur).width(280.0).show_ui(ui, |ui| {
        ui.selectable_value(sel, None, "Default");
        for n in list {
            ui.selectable_value(sel, Some(n.clone()), n);
        }
    });
    ui.add_space(6.0);
}

fn fit(area: Rect, size: Vec2) -> Rect {
    let s = (area.width() / size.x.max(1.0)).min(area.height() / size.y.max(1.0));
    Rect::from_center_size(area.center(), size * s)
}

fn clock(d: Duration) -> String {
    let s = d.as_secs();
    let (h, m, s) = (s / 3600, s % 3600 / 60, s % 60);
    if h > 0 { format!("{h}:{m:02}:{s:02}") } else { format!("{m:02}:{s:02}") }
}
