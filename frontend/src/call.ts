import init, { SignalSession, SessionState } from "./wasm/wasm_signal.js";
import {
  SIGNAL_WS_URL,
  SIGNAL_ROOM_STATUS_URL,
  HEARTBEAT_INTERVAL_MS,
  ICE_RECONNECT_GRACE_MS,
  QUALITY_POLL_INTERVAL_MS,
  RECOVERY_TIMEOUT_MS,
  SOCKET_RETRY_BASE_MS,
  SOCKET_RETRY_MAX_MS,
  MAX_SOCKET_RETRIES,
  MAX_RENEGOTIATIONS,
} from "./config";
import {
  adaptVideoBitrate,
  applyCodecPreferences,
  createPeerConnection,
  getCameraTrack,
  getInitialMedia,
  getMicStream,
  getOutgoingVideoResolution,
  getScreenStream,
  pollConnectionQuality,
  tuneSdp,
  type NetworkStats,
  type DeviceConstraints,
} from "./rtc";

const PING_MESSAGE = JSON.stringify({ type: "ping" });
const SID_KEY = "meet:sid";
const REPLACED_CLOSE_CODE = 4001;

let tabSid: string | null = null;

function tabSessionId(): string {
  if (tabSid) return tabSid;
  const sid = sessionStorage.getItem(SID_KEY) ?? crypto.randomUUID();
  tabSid = sid;
  sessionStorage.removeItem(SID_KEY);
  addEventListener("pagehide", () => sessionStorage.setItem(SID_KEY, sid));
  return sid;
}

export async function isRoomFull(roomId: string): Promise<boolean> {
  try {
    const res = await fetch(`${SIGNAL_ROOM_STATUS_URL}/${roomId}?sid=${encodeURIComponent(tabSessionId())}`);
    if (!res.ok) return false;
    const { count } = (await res.json()) as { count: number };
    return count >= 2;
  } catch {
    return false;
  }
}

export type CallEvent =
  | { type: "waiting" }
  | { type: "discarded" }
  | { type: "full" }
  | { type: "peer-left" }
  | { type: "connected" }
  | { type: "reconnecting" }
  | { type: "failed"; reason: string }
  | { type: "network-stats"; stats: NetworkStats }
  | { type: "video-resolution"; width: number; height: number }
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
  private recoveryTimer: number | null = null;
  private socketRetryTimer: number | null = null;
  private socketRetries = 0;
  private renegotiations = 0;
  private hadSocket = false;
  private isOfferer = false;
  private pendingIce: RTCIceCandidateInit[] = [];
  private signalChain: Promise<void> = Promise.resolve();
  private reconnecting = false;
  private closed = false;
  private videoSender: RTCRtpSender | null = null;
  private audioSender: RTCRtpSender | null = null;
  private cameraTrack: MediaStreamTrack | null = null;
  private videoDeviceId: string | undefined;
  private micEnabled = true;

  constructor(
    private readonly roomId: string,
    private readonly onEvent: CallEventHandler,
  ) {}

  async start(): Promise<void> {
    await ensureWasm();

    this.localStream = await getInitialMedia();
    this.onEvent({ type: "local-stream", stream: this.localStream });

    this.session = new SignalSession(this.roomId);

    await this.resetPeerConnection();
    this.connectSocket();
    this.onEvent({ type: "waiting" });
    this.startHeartbeat();

    addEventListener("pagehide", this.onPageHide);
    addEventListener("online", this.onWake);
    document.addEventListener("visibilitychange", this.onWake);
  }

  private readonly onPageHide = (): void => this.stop();

  private readonly onWake = (): void => {
    if (this.closed || document.visibilityState !== "visible") return;
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.send(PING_MESSAGE);
    } else if (this.socketRetryTimer !== null) {
      this.clearSocketRetry();
      this.socketRetries = 0;
      this.connectSocket();
    }
  };

  private async resetPeerConnection(): Promise<void> {
    this.stopQualityPoll?.();
    this.stopQualityPoll = null;
    this.clearReconnectTimer();
    this.clearRecoveryTimer();
    this.reconnecting = false;
    this.isOfferer = false;
    this.pendingIce = [];
    this.pc?.close();
    this.pc = null;

    const pc = await createPeerConnection();
    if (this.closed) {
      pc.close();
      return;
    }
    this.pc = pc;

    const stream = this.localStream!;
    const audioTrack = stream.getAudioTracks()[0];
    this.audioSender = audioTrack ? pc.addTrack(audioTrack, stream) : null;
    this.videoSender = pc.addTransceiver(this.outgoingVideoTrack() ?? "video", {
      direction: "sendrecv",
      streams: [stream],
    }).sender;

    const remote = new MediaStream();
    pc.ontrack = (event) => {
      if (this.pc !== pc) return;
      remote.addTrack(event.track);
      this.onEvent({ type: "remote-stream", stream: remote });
    };

    pc.oniceconnectionstatechange = () => {
      if (this.pc === pc) this.handleIceStateChange();
    };

    pc.onicecandidate = (event) => {
      if (this.pc === pc && event.candidate) {
        const msg = SignalSession.build_ice_message(
          event.candidate.candidate,
          event.candidate.sdpMid ?? undefined,
          event.candidate.sdpMLineIndex ?? undefined,
        );
        this.send(msg);
      }
    };

    await applyCodecPreferences(pc);
  }

  private outgoingVideoTrack(): MediaStreamTrack | null {
    return this.screenStream?.getVideoTracks()[0] ?? this.cameraTrack;
  }

  private async adoptVideoTransceiver(pc: RTCPeerConnection): Promise<void> {
    const t = pc.getTransceivers().find((x) => x.mid !== null && x.receiver.track.kind === "video");
    if (!t || t.sender === this.videoSender) return;
    t.direction = "sendrecv";
    await t.sender.replaceTrack(this.outgoingVideoTrack());
    if (this.localStream) t.sender.setStreams?.(this.localStream);
    this.videoSender = t.sender;
  }

  private emitVideoResolution(): void {
    const resolution = getOutgoingVideoResolution(this.videoSender);
    if (resolution) {
      this.onEvent({ type: "video-resolution", width: resolution.width, height: resolution.height });
    }
  }

  private handleIceStateChange(): void {
    const state = this.pc?.iceConnectionState;

    if (state === "connected" || state === "completed") {
      this.clearReconnectTimer();
      this.clearRecoveryTimer();
      this.reconnecting = false;
      this.renegotiations = 0;
      this.session?.mark_connected();
      this.onEvent({ type: "connected" });
      this.emitVideoResolution();
      this.stopQualityPoll?.();
      this.stopQualityPoll = pollConnectionQuality(
        this.pc!,
        (stats) => {
          this.onEvent({ type: "network-stats", stats });
          void adaptVideoBitrate(this.videoSender, stats.availableOutgoingKbps);
        },
        QUALITY_POLL_INTERVAL_MS,
      );
      return;
    }

    if (state === "disconnected") {
      this.armReconnectTimer();
      return;
    }

    if (state === "failed") {
      this.attemptIceRestart();
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
    const pc = this.pc;
    if (!pc || this.closed) return;
    if (!this.reconnecting) {
      this.reconnecting = true;
      this.onEvent({ type: "reconnecting" });
      this.armRecoveryTimer();
    }
    if (!this.isOfferer) return;
    this.enqueue(async () => {
      if (this.pc !== pc || pc.signalingState !== "stable") return;
      const sdp = tuneSdp((await pc.createOffer({ iceRestart: true })).sdp ?? "");
      await pc.setLocalDescription({ type: "offer", sdp });
      this.send(SignalSession.build_offer_message(sdp));
    });
  }

  private armRecoveryTimer(): void {
    if (this.recoveryTimer !== null) return;
    this.recoveryTimer = window.setTimeout(() => {
      this.recoveryTimer = null;
      this.renegotiate();
    }, RECOVERY_TIMEOUT_MS);
  }

  private clearRecoveryTimer(): void {
    if (this.recoveryTimer !== null) {
      window.clearTimeout(this.recoveryTimer);
      this.recoveryTimer = null;
    }
  }

  private renegotiate(): void {
    if (this.closed) return;
    if (++this.renegotiations > MAX_RENEGOTIATIONS) {
      this.fail("ice-failed");
      return;
    }
    this.clearSocketRetry();
    const old = this.ws;
    if (old) {
      old.onopen = old.onmessage = old.onclose = null;
      old.close(1000, "rejoin");
    }
    this.socketRetries = 0;
    this.connectSocket();
  }

  private fail(reason: string): void {
    this.session?.mark_failed();
    this.onEvent({ type: "failed", reason });
    this.stop();
  }

  private startHeartbeat(): void {
    this.heartbeatTimer = window.setInterval(() => this.send(PING_MESSAGE), HEARTBEAT_INTERVAL_MS);
  }

  private connectSocket(): void {
    const ws = new WebSocket(`${SIGNAL_WS_URL}/${this.roomId}?sid=${encodeURIComponent(tabSessionId())}`);
    this.ws = ws;
    let opened = false;

    ws.onopen = () => {
      opened = true;
      this.socketRetries = 0;
      this.send(PING_MESSAGE);
      if (this.hadSocket) {
        this.enqueue(async () => {
          this.session?.free();
          this.session = new SignalSession(this.roomId);
          await this.resetPeerConnection();
          this.onEvent({ type: "waiting" });
        });
      }
      this.hadSocket = true;
    };

    ws.onmessage = (event) => {
      const raw = String(event.data);
      this.enqueue(() => this.handleSignal(raw));
    };

    ws.onclose = (event) => {
      if (this.closed || this.ws !== ws) return;
      if (event.code === REPLACED_CLOSE_CODE) {
        this.onEvent({ type: "discarded" });
        this.stop();
        return;
      }
      void this.retrySocket(opened);
    };
  }

  private async retrySocket(opened: boolean): Promise<void> {
    if (!opened && (await isRoomFull(this.roomId))) {
      if (this.closed) return;
      this.onEvent({ type: "full" });
      this.stop();
      return;
    }
    if (this.closed) return;
    if (++this.socketRetries > MAX_SOCKET_RETRIES) {
      this.fail("signaling-lost");
      return;
    }
    const delay = Math.min(SOCKET_RETRY_MAX_MS, SOCKET_RETRY_BASE_MS * 2 ** (this.socketRetries - 1));
    this.socketRetryTimer = window.setTimeout(() => {
      this.socketRetryTimer = null;
      this.connectSocket();
    }, delay);
  }

  private clearSocketRetry(): void {
    if (this.socketRetryTimer !== null) {
      window.clearTimeout(this.socketRetryTimer);
      this.socketRetryTimer = null;
    }
  }

  private enqueue(task: () => Promise<void>): void {
    this.signalChain = this.signalChain.then(task).catch(() => undefined);
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

    const ice = this.pc?.iceConnectionState;
    if (this.session?.state === SessionState.Signaling && ice !== "connected" && ice !== "completed") {
      this.armRecoveryTimer();
    }
  }

  private async addIce(init: RTCIceCandidateInit): Promise<void> {
    try {
      await this.pc?.addIceCandidate(init);
    } catch {
      // Late/duplicate candidate — safe to ignore.
    }
  }

  private async flushPendingIce(): Promise<void> {
    const queued = this.pendingIce;
    this.pendingIce = [];
    for (const init of queued) await this.addIce(init);
  }

  private async runAction(kind: string, payload: string): Promise<void> {
    if (!this.pc || !this.session) return;

    switch (kind) {
      case "create-offer": {
        this.isOfferer = true;
        const sdp = tuneSdp((await this.pc.createOffer()).sdp ?? "");
        await this.pc.setLocalDescription({ type: "offer", sdp });
        this.send(SignalSession.build_offer_message(sdp));
        break;
      }
      case "apply-offer": {
        await this.pc.setRemoteDescription({ type: "offer", sdp: payload });
        await this.adoptVideoTransceiver(this.pc);
        await applyCodecPreferences(this.pc);
        await this.flushPendingIce();
        const sdp = tuneSdp((await this.pc.createAnswer()).sdp ?? "");
        await this.pc.setLocalDescription({ type: "answer", sdp });
        this.send(SignalSession.build_answer_message(sdp));
        break;
      }
      case "apply-answer": {
        if (this.pc.signalingState !== "have-local-offer") break;
        await this.pc.setRemoteDescription({ type: "answer", sdp: payload });
        await this.flushPendingIce();
        break;
      }
      case "apply-ice": {
        const { candidate, sdpMid, sdpMLineIndex } = JSON.parse(payload) as RTCIceCandidateInit;
        if (!this.pc.remoteDescription) {
          this.pendingIce.push({ candidate, sdpMid, sdpMLineIndex });
          break;
        }
        await this.addIce({ candidate, sdpMid, sdpMLineIndex });
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
    this.micEnabled = enabled;
    for (const track of this.localStream?.getAudioTracks() ?? []) {
      track.enabled = enabled;
    }
  }

  async setCameraEnabled(enabled: boolean): Promise<boolean> {
    if (enabled === (this.cameraTrack !== null)) return true;
    if (enabled) {
      try {
        await this.useCameraTrack(await getCameraTrack(this.videoDeviceId));
      } catch {
        return false;
      }
    } else {
      await this.useCameraTrack(null);
    }
    return true;
  }

  private async useCameraTrack(track: MediaStreamTrack | null): Promise<void> {
    const old = this.cameraTrack;
    if (old) {
      this.localStream?.removeTrack(old);
      old.stop();
    }
    this.cameraTrack = track;
    if (track) {
      if (this.closed) {
        track.stop();
        this.cameraTrack = null;
        return;
      }
      this.localStream?.addTrack(track);
    }
    if (!this.screenStream) await this.videoSender?.replaceTrack(track);
    if (this.localStream) this.onEvent({ type: "local-stream", stream: this.localStream });
    this.emitVideoResolution();
  }

  async switchDevices(constraints: DeviceConstraints): Promise<void> {
    if (constraints.videoDeviceId) {
      this.videoDeviceId = constraints.videoDeviceId;
      if (this.cameraTrack) await this.useCameraTrack(await getCameraTrack(this.videoDeviceId));
    }
    if (constraints.audioDeviceId && this.localStream) {
      const [track] = (await getMicStream(constraints.audioDeviceId)).getAudioTracks();
      track.enabled = this.micEnabled;
      for (const old of this.localStream.getAudioTracks()) {
        this.localStream.removeTrack(old);
        old.stop();
      }
      this.localStream.addTrack(track);
      await this.audioSender?.replaceTrack(track);
    }
  }

  async startScreenShare(): Promise<void> {
    if (this.screenStream) return;
    const screenStream = await getScreenStream();
    this.screenStream = screenStream;

    const [screenTrack] = screenStream.getVideoTracks();
    await this.videoSender?.replaceTrack(screenTrack);

    screenTrack.onended = () => void this.stopScreenShare();
    this.onEvent({ type: "screen-share-started" });
    this.emitVideoResolution();
  }

  async stopScreenShare(): Promise<void> {
    if (!this.screenStream) return;
    for (const track of this.screenStream.getTracks()) {
      track.stop();
    }
    this.screenStream = null;

    await this.videoSender?.replaceTrack(this.cameraTrack);
    this.onEvent({ type: "screen-share-stopped" });
    this.emitVideoResolution();
  }

  stop(): void {
    if (this.closed) return;
    this.closed = true;

    removeEventListener("pagehide", this.onPageHide);
    removeEventListener("online", this.onWake);
    document.removeEventListener("visibilitychange", this.onWake);
    this.clearReconnectTimer();
    this.clearRecoveryTimer();
    this.clearSocketRetry();
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
