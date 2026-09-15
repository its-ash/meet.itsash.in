import init, { SignalSession } from "./wasm/wasm_signal.js";
import { SIGNAL_WS_URL, HEARTBEAT_INTERVAL_MS, ICE_RECONNECT_GRACE_MS, QUALITY_POLL_INTERVAL_MS } from "./config";
import {
  applyCodecPreferences,
  createPeerConnection,
  getLocalStream,
  getScreenStream,
  pollConnectionQuality,
  type ConnectionQuality,
  type DeviceConstraints,
} from "./rtc";

const PING_MESSAGE = JSON.stringify({ type: "ping" });

export type CallEvent =
  | { type: "waiting" }
  | { type: "discarded" }
  | { type: "peer-left" }
  | { type: "connected" }
  | { type: "reconnecting" }
  | { type: "failed"; reason: string }
  | { type: "quality"; level: ConnectionQuality }
  | { type: "local-stream"; stream: MediaStream }
  | { type: "remote-stream"; stream: MediaStream }
  | { type: "screen-share-started" }
  | { type: "screen-share-stopped" };

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
  private screenStream: MediaStream | null = null;
  private heartbeatTimer: number | null = null;
  private stopQualityPoll: (() => void) | null = null;
  private reconnectTimer: number | null = null;
  private reconnecting = false;
  private closed = false;
  private videoSender: RTCRtpSender | null = null;
  private audioSender: RTCRtpSender | null = null;

  constructor(
    private readonly roomId: string,
    private readonly onEvent: CallEventHandler,
  ) {}

  async start(): Promise<void> {
    await ensureWasm();

    this.localStream = await getLocalStream();
    this.onEvent({ type: "local-stream", stream: this.localStream });

    this.session = new SignalSession(this.roomId);

    await this.resetPeerConnection();
    this.connectSocket();
    this.onEvent({ type: "waiting" });
    this.startHeartbeat();
  }

  private async resetPeerConnection(): Promise<void> {
    this.stopQualityPoll?.();
    this.stopQualityPoll = null;
    this.pc?.close();

    const pc = await createPeerConnection();
    this.pc = pc;

    this.videoSender = null;
    this.audioSender = null;
    for (const track of this.localStream?.getTracks() ?? []) {
      const sender = pc.addTrack(track, this.localStream!);
      if (track.kind === "video") this.videoSender = sender;
      if (track.kind === "audio") this.audioSender = sender;
    }

    pc.ontrack = (event) => {
      this.onEvent({ type: "remote-stream", stream: event.streams[0] });
    };

    pc.oniceconnectionstatechange = () => this.handleIceStateChange();

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

  private handleIceStateChange(): void {
    const state = this.pc?.iceConnectionState;

    if (state === "connected" || state === "completed") {
      this.clearReconnectTimer();
      this.reconnecting = false;
      this.session?.mark_connected();
      this.onEvent({ type: "connected" });
      this.stopQualityPoll?.();
      this.stopQualityPoll = pollConnectionQuality(
        this.pc!,
        (level) => this.onEvent({ type: "quality", level }),
        QUALITY_POLL_INTERVAL_MS,
      );
      return;
    }

    if (state === "disconnected") {
      this.armReconnectTimer();
      return;
    }

    if (state === "failed") {
      if (!this.reconnecting) {
        this.attemptIceRestart();
      } else {
        this.giveUpReconnecting("failed");
      }
      return;
    }

    if (state === "closed") {
      this.session?.mark_failed();
      this.onEvent({ type: "failed", reason: state });
    }
  }

  private armReconnectTimer(): void {
    if (this.reconnectTimer !== null) return;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      const state = this.pc?.iceConnectionState;
      if (state === "disconnected" || state === "failed") {
        this.attemptIceRestart();
      }
    }, ICE_RECONNECT_GRACE_MS);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private attemptIceRestart(): void {
    if (!this.pc || this.closed) return;
    this.reconnecting = true;
    this.onEvent({ type: "reconnecting" });

    this.pc
      .createOffer({ iceRestart: true })
      .then(async (offer) => {
        await this.pc!.setLocalDescription(offer);
        this.send(SignalSession.build_offer_message(offer.sdp ?? ""));
      })
      .catch(() => this.giveUpReconnecting("ice-restart-failed"));
  }

  private giveUpReconnecting(reason: string): void {
    this.reconnecting = false;
    this.session?.mark_failed();
    this.onEvent({ type: "failed", reason });
  }

  private startHeartbeat(): void {
    this.heartbeatTimer = window.setInterval(() => this.send(PING_MESSAGE), HEARTBEAT_INTERVAL_MS);
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

    this.session.handle_message(raw);

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
        await this.resetPeerConnection();
        this.onEvent({ type: "peer-left" });
        this.onEvent({ type: "waiting" });
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

  async switchDevices(constraints: DeviceConstraints): Promise<MediaStream> {
    const newStream = await getLocalStream(constraints);
    const oldStream = this.localStream;
    this.localStream = newStream;

    const isSharingScreen = this.screenStream !== null;
    for (const newTrack of newStream.getTracks()) {
      if (newTrack.kind === "video" && isSharingScreen) continue;
      const sender = newTrack.kind === "video" ? this.videoSender : this.audioSender;
      await sender?.replaceTrack(newTrack);
    }

    for (const track of oldStream?.getTracks() ?? []) {
      track.stop();
    }

    return newStream;
  }

  async startScreenShare(): Promise<void> {
    if (this.screenStream) return;
    const screenStream = await getScreenStream();
    this.screenStream = screenStream;

    const [screenTrack] = screenStream.getVideoTracks();
    await this.videoSender?.replaceTrack(screenTrack);

    screenTrack.onended = () => void this.stopScreenShare();
    this.onEvent({ type: "screen-share-started" });
  }

  async stopScreenShare(): Promise<void> {
    if (!this.screenStream) return;
    for (const track of this.screenStream.getTracks()) {
      track.stop();
    }
    this.screenStream = null;

    const cameraTrack = this.localStream?.getVideoTracks()[0] ?? null;
    await this.videoSender?.replaceTrack(cameraTrack);
    this.onEvent({ type: "screen-share-stopped" });
  }

  stop(): void {
    if (this.closed) return;
    this.closed = true;

    this.clearReconnectTimer();
    this.stopQualityPoll?.();
    this.stopQualityPoll = null;

    if (this.heartbeatTimer !== null) {
      window.clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.ws?.close();
    this.pc?.close();
    for (const track of this.localStream?.getTracks() ?? []) {
      track.stop();
    }
    for (const track of this.screenStream?.getTracks() ?? []) {
      track.stop();
    }
  }
}
