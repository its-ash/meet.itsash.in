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
  AudioMixer,
  adaptVideoBitrate,
  applyCodecPreferences,
  createPeerConnection,
  getCameraTrack,
  getIceServers,
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
  /** Which local capture devices are currently available (both are optional). */
  | { type: "media"; audio: boolean; video: boolean }
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
  private audioMixer: AudioMixer | null = null;
  private videoDeviceId: string | undefined;
  private micEnabled = true;
  private cameraBusy = false;

  constructor(
    private readonly roomId: string,
    private readonly onEvent: CallEventHandler,
  ) {}

  async start(): Promise<void> {
    // Warm the ICE server cache while the permission prompt is open.
    void getIceServers();
    const [, stream] = await Promise.all([ensureWasm(), getInitialMedia()]);
    if (this.closed) {
      for (const t of stream.getTracks()) t.stop();
      return;
    }

    this.localStream = stream;
    this.onEvent({ type: "local-stream", stream });
    this.emitMedia();

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

    // Always negotiate both an audio and a video m-line, even without a mic
    // or camera: otherwise the offer has no slot for the partner's media and
    // a camera-less/mic-less user would never hear or see them.
    const stream = this.localStream!;
    this.audioSender = pc.addTransceiver(this.outgoingAudioTrack() ?? "audio", {
      direction: "sendrecv",
      streams: [stream],
    }).sender;
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

  private micTrack(): MediaStreamTrack | null {
    return this.localStream?.getAudioTracks()[0] ?? null;
  }

  private outgoingAudioTrack(): MediaStreamTrack | null {
    return this.audioMixer?.track ?? this.micTrack();
  }

  private emitMedia(): void {
    this.onEvent({ type: "media", audio: !!this.micTrack(), video: !!this.cameraTrack });
  }

  /**
   * Recomputes the outgoing audio: the mic alone, or mic + shared-screen
   * audio mixed together while a screen share with audio is active.
   */
  private async routeAudio(): Promise<void> {
    this.audioMixer?.close();
    this.audioMixer = null;
    const screenAudio = this.screenStream?.getAudioTracks().find((t) => t.readyState === "live");
    if (screenAudio) {
      const mic = this.micTrack();
      try {
        this.audioMixer = new AudioMixer(mic ? [mic, screenAudio] : [screenAudio]);
      } catch {
        this.audioMixer = null;
      }
      // Mixer unavailable: share the screen audio as-is rather than nothing.
      if (!this.audioMixer) {
        await this.audioSender?.replaceTrack(screenAudio);
        return;
      }
    }
    await this.audioSender?.replaceTrack(this.outgoingAudioTrack());
  }

  /**
   * Transceivers we added before receiving an offer are not reused by
   * setRemoteDescription; switch our outgoing tracks onto the ones the
   * offer created so the answer actually sends media.
   */
  private async adoptTransceivers(pc: RTCPeerConnection): Promise<void> {
    for (const kind of ["audio", "video"] as const) {
      const t = pc.getTransceivers().find((x) => x.mid !== null && x.receiver.track.kind === kind);
      const current = kind === "audio" ? this.audioSender : this.videoSender;
      if (!t || t.sender === current) continue;
      t.direction = "sendrecv";
      await t.sender.replaceTrack(kind === "audio" ? this.outgoingAudioTrack() : this.outgoingVideoTrack());
      if (this.localStream) t.sender.setStreams?.(this.localStream);
      if (kind === "audio") this.audioSender = t.sender;
      else this.videoSender = t.sender;
    }
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
        await this.adoptTransceivers(this.pc);
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

  private setCameraTrack(track: MediaStreamTrack): void {
    this.cameraTrack = track;
    // Camera unplugged/revoked mid-call: keep the call going without video.
    track.onended = () => {
      if (!this.closed && this.cameraTrack === track) void this.dropCamera();
    };
  }

  private async dropCamera(): Promise<void> {
    const track = this.cameraTrack;
    if (!track) return;
    track.onended = null;
    this.cameraTrack = null;
    this.localStream?.removeTrack(track);
    track.stop();
    if (!this.screenStream) await this.videoSender?.replaceTrack(null);
    if (this.localStream) this.onEvent({ type: "local-stream", stream: this.localStream });
    this.emitMedia();
  }

  private async useCameraTrack(track: MediaStreamTrack): Promise<void> {
    if (this.closed) {
      track.stop();
      return;
    }
    const old = this.cameraTrack;
    if (old) {
      old.onended = null;
      this.localStream?.removeTrack(old);
      old.stop();
    }
    this.setCameraTrack(track);
    this.localStream?.addTrack(track);
    if (!this.screenStream) await this.videoSender?.replaceTrack(track);
    if (this.localStream) this.onEvent({ type: "local-stream", stream: this.localStream });
    this.emitMedia();
    this.emitVideoResolution();
  }

  /**
   * Turns the camera on or off. Off fully releases the device (camera light
   * goes out); the video slot stays negotiated, so no renegotiation is
   * needed either way. Resolves to whether the camera is on afterwards.
   */
  async setCameraEnabled(enabled: boolean): Promise<boolean> {
    if (this.closed || this.cameraBusy || enabled === !!this.cameraTrack) return !!this.cameraTrack;
    this.cameraBusy = true;
    try {
      if (enabled) await this.useCameraTrack(await getCameraTrack(this.videoDeviceId));
      else await this.dropCamera();
    } catch {
      // Permission denied / no camera / camera busy — stay audio-only.
      this.emitMedia();
    } finally {
      this.cameraBusy = false;
    }
    return !!this.cameraTrack;
  }

  /** Switches camera / mic. Picking a camera while it is off only remembers the choice. */
  async switchDevices(constraints: DeviceConstraints): Promise<void> {
    if (constraints.videoDeviceId) {
      this.videoDeviceId = constraints.videoDeviceId;
      if (this.cameraTrack && !this.cameraBusy) await this.useCameraTrack(await getCameraTrack(this.videoDeviceId));
    }
    if (constraints.audioDeviceId && this.localStream && !this.closed) {
      const [track] = (await getMicStream(constraints.audioDeviceId)).getAudioTracks();
      if (this.closed) {
        track.stop();
        return;
      }
      track.enabled = this.micEnabled;
      for (const old of this.localStream.getAudioTracks()) {
        this.localStream.removeTrack(old);
        old.stop();
      }
      this.localStream.addTrack(track);
      await this.routeAudio();
      this.emitMedia();
    }
  }

  async startScreenShare(): Promise<void> {
    if (this.screenStream || this.closed) return;
    const screenStream = await getScreenStream();
    if (this.closed || this.screenStream) {
      for (const t of screenStream.getTracks()) t.stop();
      return;
    }
    this.screenStream = screenStream;

    const [screenTrack] = screenStream.getVideoTracks();
    await this.videoSender?.replaceTrack(screenTrack);
    if (screenStream.getAudioTracks().length) await this.routeAudio();

    screenTrack.onended = () => void this.stopScreenShare();
    this.onEvent({ type: "screen-share-started" });
    this.emitVideoResolution();
  }

  async stopScreenShare(): Promise<void> {
    if (!this.screenStream) return;
    const hadAudio = this.screenStream.getAudioTracks().length > 0;
    for (const track of this.screenStream.getTracks()) {
      track.stop();
    }
    this.screenStream = null;

    await this.videoSender?.replaceTrack(this.cameraTrack);
    if (hadAudio) await this.routeAudio();
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
    this.audioMixer?.close();
    this.audioMixer = null;
  }
}
