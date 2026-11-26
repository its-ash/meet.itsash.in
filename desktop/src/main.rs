#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod app;
mod call;
mod media;
mod net;
mod perm;

use eframe::egui;

fn main() -> eframe::Result {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let mut vp = egui::ViewportBuilder::default()
        .with_title("Meet")
        .with_inner_size([1100.0, 720.0])
        .with_min_inner_size([420.0, 520.0]);
    if let Ok(icon) = eframe::icon_data::from_png_bytes(include_bytes!("../icons/icon.png")) {
        vp = vp.with_icon(icon);
    }
    let opts = eframe::NativeOptions { viewport: vp, ..Default::default() };
    eframe::run_native("Meet", opts, Box::new(|cc| Ok(Box::new(app::App::new(cc)))))
}
