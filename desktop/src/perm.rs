#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Access {
    Granted,
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    Prompt,
    Denied,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Dev {
    Camera,
    Mic,
}

#[cfg(target_os = "macos")]
mod os {
    use super::{Access, Dev};
    use block2::RcBlock;
    use objc2::runtime::Bool;
    use objc2_av_foundation::{AVCaptureDevice, AVMediaType, AVMediaTypeAudio, AVMediaTypeVideo};

    fn media(d: Dev) -> Option<&'static AVMediaType> {
        unsafe {
            match d {
                Dev::Camera => AVMediaTypeVideo,
                Dev::Mic => AVMediaTypeAudio,
            }
        }
    }

    pub fn status(d: Dev) -> Access {
        let Some(m) = media(d) else { return Access::Granted };
        match unsafe { AVCaptureDevice::authorizationStatusForMediaType(m) }.0 {
            3 => Access::Granted,
            0 => Access::Prompt,
            _ => Access::Denied,
        }
    }

    pub fn request(d: Dev, done: impl Fn(Access) + Send + Sync + 'static) {
        let Some(m) = media(d).filter(|_| status(d) == Access::Prompt) else { return done(status(d)) };
        let block = RcBlock::new(move |ok: Bool| done(if ok.as_bool() { Access::Granted } else { Access::Denied }));
        unsafe { AVCaptureDevice::requestAccessForMediaType_completionHandler(m, &block) };
    }

    pub fn open_settings(d: Dev) {
        let pane = match d {
            Dev::Camera => "Privacy_Camera",
            Dev::Mic => "Privacy_Microphone",
        };
        let _ = std::process::Command::new("open")
            .arg(format!("x-apple.systempreferences:com.apple.preference.security?{pane}"))
            .spawn();
    }
}

#[cfg(windows)]
mod os {
    use super::{Access, Dev};
    use winreg::RegKey;
    use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE};

    const BASE: &str = r"Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore";

    fn name(d: Dev) -> &'static str {
        match d {
            Dev::Camera => "webcam",
            Dev::Mic => "microphone",
        }
    }

    fn denied(root: &RegKey, path: &str) -> bool {
        root.open_subkey(path)
            .and_then(|k| k.get_value::<String, _>("Value"))
            .is_ok_and(|v| v.eq_ignore_ascii_case("Deny"))
    }

    pub fn status(d: Dev) -> Access {
        let key = format!(r"{BASE}\{}", name(d));
        let (lm, cu) = (RegKey::predef(HKEY_LOCAL_MACHINE), RegKey::predef(HKEY_CURRENT_USER));
        if denied(&lm, &key) || denied(&cu, &key) || denied(&cu, &format!(r"{key}\NonPackaged")) {
            Access::Denied
        } else {
            Access::Granted
        }
    }

    pub fn request(d: Dev, done: impl Fn(Access) + Send + Sync + 'static) {
        done(status(d))
    }

    pub fn open_settings(d: Dev) {
        let _ = std::process::Command::new("explorer").arg(format!("ms-settings:privacy-{}", name(d))).spawn();
    }
}

#[cfg(not(any(target_os = "macos", windows)))]
mod os {
    use super::{Access, Dev};

    pub fn status(_: Dev) -> Access {
        Access::Granted
    }

    pub fn request(_: Dev, done: impl Fn(Access) + Send + Sync + 'static) {
        done(Access::Granted)
    }

    pub fn open_settings(_: Dev) {}
}

pub use os::{open_settings, request, status};
