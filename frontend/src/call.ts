import init, { SignalSession, SessionState } from "./wasm/wasm_signal.js";
import {
  SIGNAL_WS_URL,
  SIGNAL_ROOM_STATUS_URL,
  HEARTBEAT_INTERVAL_MS,
  ICE_RECONNECT_GRACE_MS,
  QUALITY_POLL_INTERVAL_MS,
  RECOVERY_TIMEOUT_MS,
  MAX_RECOVERY_BACKOFF,
  SOCKET_RETRY_BASE_MS,
  SOCKET_RETRY_MAX_MS,
  SOCKET_DEAD_MS,
  SOCKET_CONNECT_TIMEOUT_MS,
  FULL_ROOM_POLL_MS,
} from "./config";
import {
  AudioPipeline,
  adaptVideoBitrate,
  applyCodecPreferences,
  createPeerConnection,
  getCameraTrack,
  getIceServers,
  getInitialMedia,
  getMicStream,
  getOutgoingVideoResolution,
  getScreenStream,
  isBlocked,
  loadEnhancer,
  permissionDenied,
  pollConnectionQuality,
  prioritizeAudio,
  restoreBrowserVoiceProcessing,
  tuneSdp,
  watchPermissions,
  type InitialMedia,
  type NetworkStats,
  type DeviceConstraints,
} from "./rtc";

const PING_MESSAGE = JSON.stringify({ type: "ping" });
const PONG_MESSAGE = JSON.stringify({ type: "pong" });
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
  | { type: "network-stats"; stats: NetworkStats }
  | { type: "video-resolution"; width: number; height: number }
  | { type: "local-stream"; stream: MediaStream }
  /** Which local capture devices are currently available (both are optional). */
  | { type: "media"; audio: boolean; video: boolean }
  /** Camera or mic permission was refused (`denied`: the browser no longer prompts). */
  | { type: "permission"; blocked: boolean; denied: boolean }
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
  private readonly localStream = new MediaStream();
  private screenStream: MediaStream | null = null;
  private heartbeatTimer: number | null = null;
  private stopQualityPoll: (() => void) | null = null;
  private reconnectTimer: number | null = null;
  private recoveryTimer: number | null = null;
  private socketRetryTimer: number | null = null;
  private socketRetries = 0;
  private socketGen = 0;
  private lastRx = 0;
  private pongSeen = false;
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
  private audio: AudioPipeline | null = null;
  private videoDeviceId: string | undefined;
  private micEnabled = true;
  private cameraBusy = false;
  private fx: Promise<ArrayBuffer | null> = Promise.resolve(null);
  private mediaChain: Promise<void> = Promise.resolve();
  private asking: Promise<void> | null = null;
  private blocked = false;
  private unwatch: (() => void) | null = null;

  constructor(
    private readonly roomId: string,
    private readonly onEvent: CallEventHandler,
  ) {}

  /**
   * Joins the room at once and attaches the mic when the permission prompt
   * resolves, so the partner can connect while this side still decides.
   */
  async start(): Promise<void> {
    // Warm the ICE server cache while the permission prompt is open.
    void getIceServers();
    this.fx = loadEnhancer();
    const media = this.fx.then((bytes) => getInitialMedia(!!bytes));
    this.unwatch = watchPermissions(() => {
      if (this.blocked) void this.requestMedia();
    });
    try {
      await ensureWasm();
      if (!this.closed) await this.openSignaling();
    } finally {
      void this.queueMedia(media);
    }
  }

  /** Asks for camera and mic again (dialog button or a permission change). The camera stays off. */
  requestMedia(): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.asking ??= this.queueMedia(this.fx.then((bytes) => getInitialMedia(!!bytes))).finally(() => {
      this.asking = null;
    });
    return this.asking;
  }

  private queueMedia(media: Promise<InitialMedia>): Promise<void> {
    this.mediaChain = this.mediaChain.then(async () => this.attachMedia(await media, await this.fx)).catch(() => undefined);
    return this.mediaChain;
  }

  private setBlocked(blocked: boolean, denied: boolean): void {
    this.blocked = blocked;
    this.onEvent({ type: "permission", blocked, denied });
  }

  private async openSignaling(): Promise<void> {
    this.session = new SignalSession(this.roomId);
    await this.resetPeerConnection();
    if (this.closed) return;
    this.onEvent({ type: "local-stream", stream: this.localStream });
    this.emitMedia();
    this.onEvent({ type: "waiting" });
    this.connectSocket();
    this.heartbeatTimer = window.setInterval(this.tick, HEARTBEAT_INTERVAL_MS);
    addEventListener("pagehide", this.onPageHide);
    addEventListener("online", this.onWake);
    document.addEventListener("visibilitychange", this.onWake);
  }

  private async attachMedia({ stream, blocked, denied }: InitialMedia, bytes: ArrayBuffer | null): Promise<void> {
    const [mic] = stream.getAudioTracks();
    const add = !this.closed && !this.micTrack() ? mic : undefined;
    if (mic && !add) mic.stop();
    if (this.closed) return;
    if (add) {
      add.enabled = this.micEnabled;
      this.localStream.addTrack(add);
    }
    this.setBlocked(blocked, denied);

    if (!this.audio) {
      const audio = await AudioPipeline.create(bytes, this.micTrack(), () => void this.routeAudio());
      if (this.closed) {
        audio?.close();
        return;
      }
      this.audio = audio;
      if (this.screenStream) audio?.setScreen(this.screenAudio());
    } else if (add) {
      this.audio.setMic(add);
    }
    if (add && bytes && !this.audio?.enhanced) void restoreBrowserVoiceProcessing(add);

    this.onEvent({ type: "local-stream", stream: this.localStream });
    this.emitMedia();
    await this.routeAudio();
  }

  private readonly onPageHide = (): void => this.stop();

  /** Back online or tab visible again: probe the socket, rejoin at once if it is dead. */
  private readonly onWake = (): void => {
    if (this.closed || document.visibilityState !== "visible") return;
    const ws = this.ws;
    if (ws?.readyState === WebSocket.OPEN && (!this.pongSeen || Date.now() - this.lastRx <= SOCKET_DEAD_MS)) {
      ws.send(PING_MESSAGE);
    } else if (ws?.readyState !== WebSocket.CONNECTING) {
      this.reconnectNow();
    }
  };

  /** Heartbeat plus watchdog: a socket with no traffic is dead even if the browser still says OPEN. */
  private readonly tick = (): void => {
    if (this.closed) return;
    const ws = this.ws;
    const idle = Date.now() - this.lastRx;
    if (ws?.readyState === WebSocket.OPEN) {
      if (this.pongSeen && idle > SOCKET_DEAD_MS) this.reconnectNow();
      else ws.send(PING_MESSAGE);
    } else if (ws?.readyState === WebSocket.CONNECTING || this.socketRetryTimer === null) {
      if (idle > SOCKET_CONNECT_TIMEOUT_MS) this.reconnectNow();
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
    const stream = this.localStream;
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
    return this.localStream.getAudioTracks()[0] ?? null;
  }

  private screenAudio(): MediaStreamTrack | null {
    return this.screenStream?.getAudioTracks().find((t) => t.readyState === "live") ?? null;
  }

  /** Enhanced mic (+ screen audio) when the audio graph runs, else the raw track. */
  private outgoingAudioTrack(): MediaStreamTrack | null {
    return this.audio?.track ?? this.micTrack() ?? this.screenAudio();
  }

  private emitMedia(): void {
    this.onEvent({ type: "media", audio: !!this.micTrack(), video: !!this.cameraTrack });
  }

  private async routeAudio(): Promise<void> {
    if (this.closed) return;
    await this.audioSender?.replaceTrack(this.outgoingAudioTrack()).catch(() => undefined);
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
      t.sender.setStreams?.(this.localStream);
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
      void prioritizeAudio(this.audioSender);
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

  /**
   * Media not up in time: rejoin the room for a fresh pairing. Never gives
   * up; the delay doubles up to MAX_RECOVERY_BACKOFF. The answerer waits
   * twice as long so the offerer normally acts first and the two sides do
   * not reset each other in a loop.
   */
  private armRecoveryTimer(): void {
    if (this.recoveryTimer !== null) return;
    const delay =
      RECOVERY_TIMEOUT_MS * Math.min(2 ** this.renegotiations, MAX_RECOVERY_BACKOFF) * (this.isOfferer ? 1 : 2);
    this.recoveryTimer = window.setTimeout(() => {
      this.recoveryTimer = null;
      if (this.closed) return;
      this.renegotiations++;
      this.reconnectNow();
    }, delay);
  }

  private clearRecoveryTimer(): void {
    if (this.recoveryTimer !== null) {
      window.clearTimeout(this.recoveryTimer);
      this.recoveryTimer = null;
    }
  }

  private reconnectNow(): void {
    this.socketRetries = 0;
    this.connectSocket();
  }

  /** Detaches and closes the current socket so its late events cannot act. */
  private dropSocket(): void {
    const ws = this.ws;
    this.ws = null;
    if (!ws) return;
    ws.onopen = ws.onmessage = ws.onclose = null;
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close(1000, "rejoin");
  }

  /**
   * Every (re)open starts a fresh pairing: the server sends `peer-left` to
   * the partner when this socket goes, then `peer-joined` to both, so both
   * sides rebuild their peer connection and the two always meet again.
   */
  private connectSocket(): void {
    if (this.closed) return;
    this.clearSocketRetry();
    this.dropSocket();
    const gen = ++this.socketGen;
    const ws = new WebSocket(`${SIGNAL_WS_URL}/${this.roomId}?sid=${encodeURIComponent(tabSessionId())}`);
    this.ws = ws;
    this.lastRx = Date.now();
    let opened = false;

    ws.onopen = () => {
      opened = true;
      this.socketRetries = 0;
      this.lastRx = Date.now();
      ws.send(PING_MESSAGE);
      const rejoin = this.hadSocket;
      this.hadSocket = true;
      this.enqueue(async () => {
        if (rejoin) {
          this.session?.free();
          this.session = new SignalSession(this.roomId);
          await this.resetPeerConnection();
        }
        this.onEvent({ type: "waiting" });
      });
    };

    ws.onmessage = (event) => {
      this.lastRx = Date.now();
      const raw = String(event.data);
      if (raw === PONG_MESSAGE) {
        this.pongSeen = true;
        return;
      }
      this.enqueue(() => this.handleSignal(raw));
    };

    ws.onclose = (event) => {
      if (this.closed || gen !== this.socketGen) return;
      this.ws = null;
      if (event.code === REPLACED_CLOSE_CODE) {
        this.onEvent({ type: "discarded" });
        this.stop();
        return;
      }
      void this.retrySocket(gen, opened);
    };
  }

  /** Retries forever with capped backoff; a full room is polled until a slot frees. */
  private async retrySocket(gen: number, opened: boolean): Promise<void> {
    const full = !opened && (await isRoomFull(this.roomId));
    if (this.closed || gen !== this.socketGen) return;
    if (full) this.onEvent({ type: "full" });
    const n = ++this.socketRetries;
    const delay = full ? FULL_ROOM_POLL_MS : Math.min(SOCKET_RETRY_MAX_MS, SOCKET_RETRY_BASE_MS * 2 ** Math.min(n - 1, 8));
    this.socketRetryTimer = window.setTimeout(() => {
      this.socketRetryTimer = null;
      if (gen === this.socketGen) this.connectSocket();
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
    for (const track of this.localStream.getAudioTracks()) {
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
    this.localStream.removeTrack(track);
    track.stop();
    if (!this.screenStream) await this.videoSender?.replaceTrack(null);
    this.onEvent({ type: "local-stream", stream: this.localStream });
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
      this.localStream.removeTrack(old);
      old.stop();
    }
    this.setCameraTrack(track);
    this.localStream.addTrack(track);
    if (!this.screenStream) await this.videoSender?.replaceTrack(track);
    this.onEvent({ type: "local-stream", stream: this.localStream });
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
      if (enabled) {
        await this.useCameraTrack(await getCameraTrack(this.videoDeviceId));
        if (this.blocked && this.micTrack()) this.setBlocked(false, false);
      } else await this.dropCamera();
    } catch (e) {
      // Permission refused / no camera / camera busy — stay audio-only.
      if (isBlocked(e)) this.setBlocked(true, await permissionDenied());
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
    if (constraints.audioDeviceId && !this.closed) {
      const [track] = (await getMicStream(constraints.audioDeviceId, !!this.audio?.enhanced)).getAudioTracks();
      if (!track) return;
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
      this.audio?.setMic(track);
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
    this.audio?.setScreen(this.screenAudio());
    await this.routeAudio();

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
    this.audio?.setScreen(null);

    await this.videoSender?.replaceTrack(this.cameraTrack);
    await this.routeAudio();
    this.onEvent({ type: "screen-share-stopped" });
    this.emitVideoResolution();
  }

  stop(): void {
    if (this.closed) return;
    this.closed = true;

    removeEventListener("pagehide", this.onPageHide);
    removeEventListener("online", this.onWake);
    document.removeEventListener("visibilitychange", this.onWake);
    this.unwatch?.();
    this.unwatch = null;
    this.clearReconnectTimer();
    this.clearRecoveryTimer();
    this.clearSocketRetry();
    this.stopQualityPoll?.();
    this.stopQualityPoll = null;

    if (this.heartbeatTimer !== null) {
      window.clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.dropSocket();
    this.pc?.close();
    for (const track of this.localStream.getTracks()) {
      track.stop();
    }
    for (const track of this.screenStream?.getTracks() ?? []) {
      track.stop();
    }
    this.audio?.close();
    this.audio = null;
  }
}
