use eframe::egui::{Image, vec2};

#[derive(Clone, Copy)]
pub struct Icon {
    uri: &'static str,
    svg: &'static [u8],
}

impl Icon {
    pub fn img(self, size: f32) -> Image<'static> {
        Image::from_bytes(self.uri, self.svg).fit_to_exact_size(vec2(size, size))
    }
}

macro_rules! icons {
    ($($name:ident: $body:literal),* $(,)?) => {
        $(pub const $name: Icon = Icon {
            uri: concat!("bytes://", stringify!($name), ".svg"),
            svg: concat!(
                r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">"##,
                $body,
                "</svg>"
            )
            .as_bytes(),
        };)*
    };
}

icons! {
    MIC: r#"<rect x="9" y="2.5" width="6" height="11.5" rx="3"/><path d="M5 10a7 7 0 0 0 14 0M12 17v4M8.5 21h7"/>"#,
    MIC_OFF: r#"<path d="M9 9v3a3 3 0 0 0 5.12 2.12M12.9 4.16A3 3 0 0 1 15 7v2M5 10a7 7 0 0 0 10.54 6.04M17.9 14.02A7 7 0 0 0 19 10M12 17v4M8.5 21h7M3 3l18 18"/>"#,
    CAM: r#"<rect x="2.5" y="6" width="13" height="12" rx="2"/><path d="M15.5 10.5l6-3.5v10l-6-3.5"/>"#,
    CAM_OFF: r#"<path d="M9 6h4.5a2 2 0 0 1 2 2v4.5M15.5 16a2 2 0 0 1-2 2h-9a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2M15.5 10.5l6-3.5v10l-4-2.3M3 3l18 18"/>"#,
    SHARE: r#"<rect x="2.5" y="4" width="19" height="13" rx="1.5"/><path d="M8 21h8M12 17v4M9 10.5l3-3 3 3M12 7.5v6"/>"#,
    DEVICES: r#"<path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/>"#,
    LEAVE: r#"<path d="M3 14.5c5-4.6 13-4.6 18 0l-2.4 2.6-3.4-1.4v-2.5a11 11 0 0 0-6.4 0v2.5l-3.4 1.4z"/>"#,
    COPY: r#"<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>"#,
    CHECK: r#"<path d="M5 12.5l4.5 4.5L19 7.5"/>"#,
    ARROW: r#"<path d="M5 12h14M13 6l6 6-6 6"/>"#,
    NEW: r#"<rect x="2.5" y="6" width="13" height="12" rx="2"/><path d="M15.5 10.5l6-3.5v10l-6-3.5M9 9.5v5M6.5 12h5"/>"#,
    SHIELD: r#"<path d="M12 3l7.5 3v5.5c0 4.6-3.2 8.3-7.5 9.5-4.3-1.2-7.5-4.9-7.5-9.5V6z"/><path d="M8.8 12.2l2.2 2.2 4.2-4.4"/>"#,
}
