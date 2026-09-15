import init, { SignalSession, SessionState } from "./wasm/wasm_signal.js";
import { SIGNAL_WS_URL, PAIR_TIMEOUT_MS, HEARTBEAT_INTERVAL_MS } from "./config";
import { applyCodecPreferences, createPeerConnection, getLocalStream } from "./rtc";

const PING_MESSAGE = JSON.stringify({ type: "ping" });

export type CallEvent =
  | { type: "waiting"; msRemaining: number }
  | { type: "discarded" }
  | { type: "peer-left" }
  | { type: "connected" }
  | { type: "failed"; reason: string }
  | { type: "local-stream"; stream: MediaStream }
  | { type: "remote-stream"; stream: MediaStream };

export type CallEventHandler = (event: CallEvent) => void;

let wasmReady: Promise<unknown> | null = null;
function ensureWasm(): Promise<unknown> {
  if (!wasmReady) wasmReady = init();
  return wasmReady;
}

export class CallSession {
  private ws: WebSocket | null = null;
  private pc: RTCPeerConnection | null = null;
  private session: SignalSession | null = null;
  private localStream: MediaStream | null = null;
  private waitTimer: number | null = null;
  private heartbeatTimer: number | null = null;
  private closed = false;

  constructor(
    private readonly roomId: string,
    private readonly onEvent: CallEventHandler,
  ) {}

  async start(): Promise<void> {
    await ensureWasm();

    this.localStream = await getLocalStream();
    this.onEvent({ type: "local-stream", stream: this.localStream });

    // Start the wait clock only once the user has actually granted
    // camera/mic access — not while the permission prompt was pending.
    this.session = new SignalSession(this.roomId, Date.now());

    this.resetPeerConnection();
    this.connectSocket();
    this.tickWaitTimer();
    this.startHeartbeat();
  }

  private resetPeerConnection(): void {
    this.pc?.close();
    const pc = createPeerConnection();
    this.pc = pc;

    for (const track of this.localStream?.getTracks() ?? []) {
      pc.addTrack(track, this.localStream!);
    }

    pc.ontrack = (event) => {
      this.onEvent({ type: "remote-stream", stream: event.streams[0] });
    };

    pc.oniceconnectionstatechange = () => {
      const state = pc.iceConnectionState;
      if (state === "connected" || state === "completed") {
        this.session?.mark_connected();
        this.onEvent({ type: "connected" });
      } else if (state === "failed" || state === "disconnected" || state === "closed") {
        this.session?.mark_failed();
        this.onEvent({ type: "failed", reason: state });
      }
    };

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        const msg = SignalSession.build_ice_message(
          event.candidate.candidate,
          event.candidate.sdpMid ?? undefined,
          event.candidate.sdpMLineIndex ?? undefined,
        );
        this.send(msg);
      }
    };
  }

  private startHeartbeat(): void {
    this.heartbeatTimer = window.setInterval(() => this.send(PING_MESSAGE), HEARTBEAT_INTERVAL_MS);
  }

  private tickWaitTimer(): void {
    const step = () => {
      if (this.closed || !this.session) return;
      const now = Date.now();
      if (this.session.state === SessionState.WaitingForPeer) {
        if (this.session.check_timeout(now)) {
          this.onEvent({ type: "discarded" });
          this.stop();
          return;
        }
        this.onEvent({ type: "waiting", msRemaining: this.session.ms_remaining(now) });
      }
      this.waitTimer = window.setTimeout(step, 200);
    };
    step();
  }

  private connectSocket(): void {
    const ws = new WebSocket(`${SIGNAL_WS_URL}/${this.roomId}`);
    this.ws = ws;

    ws.onmessage = (event) => this.handleSignal(String(event.data));

    ws.onclose = (event) => {
      if (this.closed) return;
      if (event.code === 4000) {
        this.onEvent({ type: "discarded" });
      }
      this.stop();
    };

    ws.onerror = () => {
      this.onEvent({ type: "failed", reason: "signaling-error" });
    };
  }

  private send(payload: string): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(payload);
    }
  }

  private async handleSignal(raw: string): Promise<void> {
    if (!this.session || !this.pc) return;

    this.session.handle_message(raw, Date.now());

    let action = this.session.next_action();
    while (action) {
      await this.runAction(action.kind, action.payload);
      action = this.session.next_action();
    }
  }

  private async runAction(kind: string, payload: string): Promise<void> {
    if (!this.pc || !this.session) return;

    switch (kind) {
      case "create-offer": {
        const offer = await this.pc.createOffer();
        await this.pc.setLocalDescription(offer);
        applyCodecPreferences(this.pc);
        this.send(SignalSession.build_offer_message(offer.sdp ?? ""));
        break;
      }
      case "apply-offer": {
        await this.pc.setRemoteDescription({ type: "offer", sdp: payload });
        const answer = await this.pc.createAnswer();
        await this.pc.setLocalDescription(answer);
        applyCodecPreferences(this.pc);
        this.send(SignalSession.build_answer_message(answer.sdp ?? ""));
        break;
      }
      case "apply-answer": {
        await this.pc.setRemoteDescription({ type: "answer", sdp: payload });
        break;
      }
      case "apply-ice": {
        const { candidate, sdpMid, sdpMLineIndex } = JSON.parse(payload);
        try {
          await this.pc.addIceCandidate({ candidate, sdpMid, sdpMLineIndex });
        } catch {
          // Late/duplicate candidate — safe to ignore.
        }
        break;
      }
      case "peer-left": {
        this.resetPeerConnection();
        this.onEvent({ type: "peer-left" });
        break;
      }
    }
  }

  setMicEnabled(enabled: boolean): void {
    for (const track of this.localStream?.getAudioTracks() ?? []) {
      track.enabled = enabled;
    }
  }

  setCameraEnabled(enabled: boolean): void {
    for (const track of this.localStream?.getVideoTracks() ?? []) {
      track.enabled = enabled;
    }
  }

  stop(): void {
    if (this.closed) return;
    this.closed = true;

    if (this.waitTimer !== null) {
      window.clearTimeout(this.waitTimer);
      this.waitTimer = null;
    }
    if (this.heartbeatTimer !== null) {
      window.clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.ws?.close();
    this.pc?.close();
    for (const track of this.localStream?.getTracks() ?? []) {
      track.stop();
    }
  }
}

export { PAIR_TIMEOUT_MS };
