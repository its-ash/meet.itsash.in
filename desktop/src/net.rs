use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use anyhow::{Result, bail};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use webrtc::ice_transport::ice_server::RTCIceServer;

pub const HOST: &str = "meet-signal.its-ash.workers.dev";
pub const PUBLIC_ORIGIN: &str = "https://meet.itsash.in";
const FALLBACK_STUN: [&str; 2] = ["stun:stun.cloudflare.com:3478", "stun:stun.l.google.com:19302"];
const ICE_CACHE: Duration = Duration::from_secs(30 * 60);

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum Msg {
    Offer { sdp: String },
    Answer { sdp: String },
    IceCandidate { candidate: String, sdp_mid: Option<String>, sdp_m_line_index: Option<u16> },
    PeerJoined { role: String },
    PeerLeft,
    Ping,
    Pong,
}

pub fn ws_url(room: &str, sid: &str) -> String {
    format!("wss://{HOST}/ws/{room}?sid={sid}")
}

pub fn share_link(room: &str) -> String {
    format!("{PUBLIC_ORIGIN}/{room}")
}

/// Accepts a bare code or a pasted link; returns the 4-character room code.
pub fn normalize_room(input: &str) -> Option<String> {
    let s = input.trim().trim_end_matches('/');
    let code = s.rsplit('/').next().unwrap_or(s).to_ascii_lowercase();
    (code.len() == 4 && code.bytes().all(|b| b.is_ascii_alphanumeric())).then_some(code)
}

fn agent() -> &'static ureq::Agent {
    static AGENT: OnceLock<ureq::Agent> = OnceLock::new();
    AGENT.get_or_init(|| ureq::Agent::config_builder().timeout_global(Some(Duration::from_secs(8))).build().into())
}

fn get<T: DeserializeOwned>(path: &str) -> Result<T> {
    Ok(agent().get(&format!("https://{HOST}{path}")).call()?.body_mut().read_json()?)
}

pub fn new_room() -> Result<String> {
    #[derive(Deserialize)]
    struct R {
        #[serde(rename = "roomId")]
        room_id: String,
    }
    let id = get::<R>("/new-room")?.room_id;
    match normalize_room(&id) {
        Some(id) => Ok(id),
        None => bail!("bad room id"),
    }
}

pub fn room_count(room: &str, sid: &str) -> Result<u32> {
    #[derive(Deserialize)]
    struct R {
        count: u32,
    }
    Ok(get::<R>(&format!("/room-status/{room}?sid={sid}"))?.count)
}

#[derive(Deserialize)]
#[serde(untagged)]
enum Urls {
    One(String),
    Many(Vec<String>),
}

#[derive(Deserialize)]
struct IceEntry {
    urls: Urls,
    username: Option<String>,
    credential: Option<String>,
}

#[derive(Deserialize)]
struct IceReply {
    #[serde(rename = "iceServers")]
    ice_servers: Vec<IceEntry>,
}

/// webrtc-rs gathers over UDP only: TURN over TCP/TLS URLs are dropped.
fn usable(url: &str) -> bool {
    url.starts_with("stun:") || (url.starts_with("turn:") && !url.contains("transport=tcp"))
}

fn fetch_ice() -> Option<Vec<RTCIceServer>> {
    let reply: IceReply = get("/turn-credentials").ok()?;
    let servers: Vec<RTCIceServer> = reply
        .ice_servers
        .into_iter()
        .filter_map(|e| {
            let urls: Vec<String> = match e.urls {
                Urls::One(u) => vec![u],
                Urls::Many(v) => v,
            }
            .into_iter()
            .filter(|u| usable(u))
            .collect();
            (!urls.is_empty()).then(|| RTCIceServer {
                urls,
                username: e.username.unwrap_or_default(),
                credential: e.credential.unwrap_or_default(),
            })
        })
        .collect();
    (!servers.is_empty()).then_some(servers)
}

/// TURN credentials live 1 h (worker); reuse them for 30 min.
pub fn ice_servers() -> Vec<RTCIceServer> {
    static CACHE: Mutex<Option<(Instant, Vec<RTCIceServer>)>> = Mutex::new(None);
    if let Ok(c) = CACHE.lock()
        && let Some((at, s)) = c.as_ref()
        && at.elapsed() < ICE_CACHE
    {
        return s.clone();
    }
    match fetch_ice() {
        Some(s) => {
            if let Ok(mut c) = CACHE.lock() {
                *c = Some((Instant::now(), s.clone()));
            }
            s
        }
        None => vec![RTCIceServer { urls: FALLBACK_STUN.iter().map(|s| s.to_string()).collect(), ..Default::default() }],
    }
}
