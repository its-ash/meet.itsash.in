import init, { normalize_room_id } from "./wasm/wasm_signal.js";
import { SIGNAL_NEW_ROOM_URL, SIGNAL_ROOM_STATUS_URL } from "./config";
import { CallSession, type CallEvent } from "./call";
import {
  bindCameraToggle,
  bindCopyLink,
  bindEndCall,
  bindMicToggle,
  bindStartNewFromFull,
  setCallRoomCode,
  setEndedMessage,
  setLandingError,
  setLocalPreview,
  setLocalVideoStream,
  setRemoteVideoStream,
  setRoomLink,
  showView,
  startCallDurationTimer,
  stopCallDurationTimer,
} from "./ui";

let activeSession: CallSession | null = null;

function currentRoomIdFromPath(): string | null {
  const stored = sessionStorage.getItem("meet:redirect-path");
  const path = stored ?? location.pathname;
  sessionStorage.removeItem("meet:redirect-path");
  const match = path.match(/^\/([a-z0-9]{4})\/?$/i);
  return match ? match[1].toLowerCase() : null;
}

async function createRoom(): Promise<void> {
  setLandingError(null);
  try {
    const res = await fetch(SIGNAL_NEW_ROOM_URL);
    if (!res.ok) throw new Error("failed to allocate room");
    const { roomId } = (await res.json()) as { roomId: string };
    history.pushState({}, "", `/${roomId}`);
    void enterRoom(roomId);
  } catch {
    setLandingError("Could not start a meeting. Please try again.");
  }
}

function joinRoom(rawInput: string): void {
  setLandingError(null);
  const roomId = normalize_room_id(rawInput);
  if (!roomId) {
    setLandingError("Enter a valid 4-character meeting code.");
    return;
  }
  history.pushState({}, "", `/${roomId}`);
  void enterRoom(roomId);
}

function handleCallEvent(event: CallEvent): void {
  switch (event.type) {
    case "local-stream":
      setLocalPreview(event.stream);
      setLocalVideoStream(event.stream);
      break;
    case "remote-stream":
      setRemoteVideoStream(event.stream);
      break;
    case "waiting":
      stopCallDurationTimer();
      showView("waiting");
      break;
    case "connected":
      showView("call");
      startCallDurationTimer();
      break;
    case "discarded":
      stopCallDurationTimer();
      setEndedMessage("Session ended", "You were disconnected.");
      showView("ended");
      break;
    case "peer-left":
      // The "waiting" event that follows drives the UI back to the waiting view.
      break;
    case "failed":
      stopCallDurationTimer();
      setEndedMessage("Connection failed", "Could not establish a connection. Please try again.");
      showView("ended");
      break;
  }
}

async function isRoomFull(roomId: string): Promise<boolean> {
  try {
    const res = await fetch(`${SIGNAL_ROOM_STATUS_URL}/${roomId}`);
    if (!res.ok) return false;
    const { count } = (await res.json()) as { count: number };
    return count >= 2;
  } catch {
    return false;
  }
}

async function enterRoom(roomId: string): Promise<void> {
  if (await isRoomFull(roomId)) {
    showView("full");
    return;
  }

  setRoomLink(roomId);
  setCallRoomCode(roomId);
  showView("waiting");

  activeSession = new CallSession(roomId, handleCallEvent);
  try {
    await activeSession.start();
  } catch {
    setEndedMessage("Camera/microphone required", "Please allow camera and microphone access, then try again.");
    showView("ended");
  }
}

function bindLandingForm(): void {
  document.getElementById("btn-create-room")?.addEventListener("click", () => void createRoom());

  const form = document.getElementById("form-join-room") as HTMLFormElement;
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const input = document.getElementById("input-room-id") as HTMLInputElement;
    joinRoom(input.value);
  });
}

function bindCallControls(): void {
  bindMicToggle((enabled) => {
    // Track enable/disable is wired via the local stream captured in main-scope session.
    activeSession?.setMicEnabled(enabled);
  });
  bindCameraToggle((enabled) => {
    activeSession?.setCameraEnabled(enabled);
  });
  bindEndCall(() => {
    activeSession?.stop();
    location.href = "/";
  });
  bindCopyLink();
  bindStartNewFromFull(() => void createRoom());
}

async function main(): Promise<void> {
  await init();
  bindLandingForm();
  bindCallControls();

  const roomId = currentRoomIdFromPath();
  if (roomId) {
    await enterRoom(roomId);
  } else {
    showView("landing");
  }
}

void main();
