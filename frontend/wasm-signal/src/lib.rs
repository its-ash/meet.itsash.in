use serde::{Deserialize, Serialize};
use wasm_bindgen::prelude::*;

#[derive(Serialize, Deserialize, Clone)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum SignalMessage {
    Offer { sdp: String },
    Answer { sdp: String },
    IceCandidate { candidate: String, sdp_mid: Option<String>, sdp_m_line_index: Option<u16> },
    PeerJoined,
    PeerLeft,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[wasm_bindgen]
pub enum SessionState {
    Idle,
    WaitingForPeer,
    Signaling,
    Connected,
    Failed,
}

#[derive(Clone, Debug)]
#[wasm_bindgen(getter_with_clone)]
pub struct PendingAction {
    pub kind: String,
    pub payload: String,
}

fn is_valid_room_id(room_id: &str) -> bool {
    room_id.len() == 4 && room_id.chars().all(|c| c.is_ascii_alphanumeric())
}

#[wasm_bindgen]
pub struct SignalSession {
    room_id: String,
    state: SessionState,
    queue: Vec<PendingAction>,
}

#[wasm_bindgen]
impl SignalSession {
    #[wasm_bindgen(constructor)]
    pub fn new(room_id: &str) -> Result<SignalSession, JsValue> {
        let normalized = room_id.to_ascii_lowercase();
        if !is_valid_room_id(&normalized) {
            return Err(JsValue::from_str("room id must be 4 alphanumeric characters"));
        }
        Ok(SignalSession {
            room_id: normalized,
            state: SessionState::WaitingForPeer,
            queue: Vec::new(),
        })
    }

    #[wasm_bindgen(getter)]
    pub fn room_id(&self) -> String {
        self.room_id.clone()
    }

    #[wasm_bindgen(getter)]
    pub fn state(&self) -> SessionState {
        self.state
    }

    /// Feed a raw JSON signaling message received over the WebSocket.
    pub fn handle_message(&mut self, json: &str) -> Result<(), JsValue> {
        let message: SignalMessage =
            serde_json::from_str(json).map_err(|e| JsValue::from_str(&e.to_string()))?;

        match message {
            SignalMessage::PeerJoined => {
                self.state = SessionState::Signaling;
                self.queue.push(PendingAction {
                    kind: "create-offer".into(),
                    payload: String::new(),
                });
            }
            SignalMessage::PeerLeft => {
                self.state = SessionState::WaitingForPeer;
                self.queue.push(PendingAction {
                    kind: "peer-left".into(),
                    payload: String::new(),
                });
            }
            SignalMessage::Offer { sdp } => {
                self.state = SessionState::Signaling;
                self.queue.push(PendingAction { kind: "apply-offer".into(), payload: sdp });
            }
            SignalMessage::Answer { sdp } => {
                self.state = SessionState::Signaling;
                self.queue.push(PendingAction { kind: "apply-answer".into(), payload: sdp });
            }
            SignalMessage::IceCandidate { candidate, sdp_mid, sdp_m_line_index } => {
                let payload = serde_json::json!({
                    "candidate": candidate,
                    "sdpMid": sdp_mid,
                    "sdpMLineIndex": sdp_m_line_index,
                })
                .to_string();
                self.queue.push(PendingAction { kind: "apply-ice".into(), payload });
            }
        }
        Ok(())
    }

    pub fn mark_connected(&mut self) {
        self.state = SessionState::Connected;
    }

    pub fn mark_failed(&mut self) {
        self.state = SessionState::Failed;
    }

    pub fn build_offer_message(sdp: &str) -> String {
        serde_json::to_string(&SignalMessage::Offer { sdp: sdp.to_string() }).unwrap_or_default()
    }

    pub fn build_answer_message(sdp: &str) -> String {
        serde_json::to_string(&SignalMessage::Answer { sdp: sdp.to_string() }).unwrap_or_default()
    }

    pub fn build_ice_message(
        candidate: &str,
        sdp_mid: Option<String>,
        sdp_m_line_index: Option<u16>,
    ) -> String {
        serde_json::to_string(&SignalMessage::IceCandidate {
            candidate: candidate.to_string(),
            sdp_mid,
            sdp_m_line_index,
        })
        .unwrap_or_default()
    }

    /// Pop the next queued action for the JS glue layer to execute, if any.
    pub fn next_action(&mut self) -> Option<PendingAction> {
        if self.queue.is_empty() {
            None
        } else {
            Some(self.queue.remove(0))
        }
    }
}

#[wasm_bindgen]
pub fn normalize_room_id(input: &str) -> Option<String> {
    let trimmed = input.trim().to_ascii_lowercase();
    if is_valid_room_id(&trimmed) {
        Some(trimmed)
    } else {
        None
    }
}
