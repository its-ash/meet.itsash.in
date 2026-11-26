import { ENHANCER_READY_MS, FALLBACK_ICE_SERVERS, SIGNAL_TURN_CREDENTIALS_URL } from "./config";
import enhancerWasmUrl from "./enhancer/voice.wasm?url";
import enhancerWorkletUrl from "./enhancer-worklet.ts?worker&url";

const VIDEO_CODECS = ["video/AV1", "video/H265", "video/VP9", "video/H264", "video/VP8"];
// RED (RFC 2198) carries the previous Opus frame in each packet: one lost
// packet costs no audio at all. Opus stays next for peers without RED.
const AUDIO_CODECS = ["audio/red", "audio/opus"];
const OPUS_FMTP: Record<string, string> = { useinbandfec: "1", usedtx: "1" };
const ENHANCER = "voice-enhancer";
const ENHANCER_RATE = 48_000;
const WAKE_EVENTS = ["pointerdown", "keydown", "touchend", "visibilitychange"] as const;

let videoOrder: Promise<string[]> | null = null;

function rankVideoCodecs(): Promise<string[]> {
  return (videoOrder ??= Promise.all(
    VIDEO_CODECS.map(async (mime, i) => {
      try {
        const res = await navigator.mediaCapabilities.encodingInfo({
          type: "webrtc",
          video: { contentType: mime, width: 1280, height: 720, bitrate: 1_500_000, framerate: 30 },
        });
        return { mime, i, score: res.supported ? (res.smooth ? 0 : 1) : 2 };
      } catch {
        return { mime, i, score: 0 };
      }
    }),
  ).then((xs) => xs.sort((a, b) => a.score - b.score || a.i - b.i).map((x) => x.mime.toLowerCase())));
}

const rank = (mime: string, order: string[]): number => {
  const i = order.indexOf(mime.toLowerCase());
  return i === -1 ? order.length : i;
};

export async function applyCodecPreferences(pc: RTCPeerConnection): Promise<void> {
  if (typeof RTCRtpReceiver.getCapabilities !== "function") return;
  const orders = { video: await rankVideoCodecs(), audio: AUDIO_CODECS };

  for (const t of pc.getTransceivers()) {
    const kind = (t.sender.track?.kind ?? t.receiver.track?.kind) as "video" | "audio" | undefined;
    if (!kind || typeof t.setCodecPreferences !== "function") continue;
    const codecs = RTCRtpReceiver.getCapabilities(kind)?.codecs;
    if (!codecs) continue;
    const order = orders[kind];
    try {
      t.setCodecPreferences([...codecs].sort((a, b) => rank(a.mimeType, order) - rank(b.mimeType, order)));
    } catch {
      // Unsupported in this browser — fall back to default negotiation.
    }
  }
}

export function tuneSdp(sdp: string): string {
  const pt = /^a=rtpmap:(\d+) opus\/48000/im.exec(sdp)?.[1];
  if (!pt) return sdp;
  return sdp.replace(new RegExp(`^a=fmtp:${pt} (.*)$`, "m"), (_, raw: string) => {
    const params = new Map(
      raw
        .split(";")
        .map((kv) => kv.trim())
        .filter(Boolean)
        .map((kv) => {
          const [k, ...v] = kv.split("=");
          return [k, v.join("=")] as const;
        }),
    );
    for (const [k, v] of Object.entries(OPUS_FMTP)) if (!params.has(k)) params.set(k, v);
    return `a=fmtp:${pt} ${[...params].map(([k, v]) => (v ? `${k}=${v}` : k)).join(";")}`;
  });
}

export interface DeviceConstraints {
  videoDeviceId?: string;
  audioDeviceId?: string;
}

// With the Rust enhancer active, browser noise suppression and AGC are off:
// RNNoise and the leveler do that job better, and stacking both pumps.
const audioConstraints = (audioDeviceId?: string, enhanced = false): MediaTrackConstraints => ({
  echoCancellation: true,
  noiseSuppression: !enhanced,
  autoGainControl: !enhanced,
  channelCount: { ideal: 1 },
  sampleRate: { ideal: ENHANCER_RATE },
  ...(audioDeviceId ? { deviceId: { exact: audioDeviceId } } : {}),
});

/** Turns browser noise suppression and AGC back on when the enhancer cannot run. */
export async function restoreBrowserVoiceProcessing(track: MediaStreamTrack | null): Promise<void> {
  await track?.applyConstraints({ ...track.getConstraints(), noiseSuppression: true, autoGainControl: true }).catch(() => undefined);
}

// Ideal, not exact: lets the browser pick the sensor's natural
// portrait/landscape shape (important on mobile) instead of forcing
// a fixed 1280x720 landscape frame.
const videoConstraints = (videoDeviceId?: string): MediaTrackConstraints => ({
  width: { ideal: 1280 },
  height: { ideal: 720 },
  aspectRatio: { ideal: window.innerWidth / window.innerHeight },
  frameRate: { ideal: 30 },
  ...(videoDeviceId ? { deviceId: { exact: videoDeviceId } } : {}),
});

export async function getMicStream(audioDeviceId?: string, enhanced = false): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({ audio: audioConstraints(audioDeviceId, enhanced) });
}

const BLOCKED = new Set(["NotAllowedError", "SecurityError"]);
const PERMS = ["microphone", "camera"] as const;

type Perm = (typeof PERMS)[number];
type Grab = { stream: MediaStream | null; blocked: boolean };

export const isBlocked = (e: unknown): boolean => e instanceof DOMException && BLOCKED.has(e.name);

async function grab(constraints: MediaStreamConstraints): Promise<Grab> {
  try {
    return { stream: await navigator.mediaDevices.getUserMedia(constraints), blocked: false };
  } catch (e) {
    return { stream: null, blocked: isBlocked(e) };
  }
}

async function permState(name: Perm): Promise<PermissionState | null> {
  try {
    return (await navigator.permissions.query({ name: name as PermissionName })).state;
  } catch {
    return null;
  }
}

/** True when the browser refuses camera or mic without a prompt (only site settings lift it). */
export async function permissionDenied(): Promise<boolean> {
  return (await Promise.all(PERMS.map(permState))).includes("denied");
}

/** Calls `onChange` when the camera or mic permission changes; returns the unsubscribe. */
export function watchPermissions(onChange: () => void): () => void {
  let off = false;
  const subs: PermissionStatus[] = [];
  for (const name of PERMS) {
    navigator.permissions
      ?.query({ name: name as PermissionName })
      .then((s) => {
        if (off) return;
        s.onchange = onChange;
        subs.push(s);
      })
      .catch(() => undefined);
  }
  return () => {
    off = true;
    for (const s of subs) s.onchange = null;
  };
}

export interface InitialMedia {
  stream: MediaStream;
  /** Camera or mic permission was refused or dismissed. */
  blocked: boolean;
  /** The browser now refuses without a prompt. */
  denied: boolean;
}

/**
 * Asks for camera and mic permission up front, then stops the camera so the
 * call starts audio-only. The camera button can turn it on later without a
 * new prompt. Never rejects: refused or missing devices give fewer tracks.
 */
export async function getInitialMedia(enhanced = false): Promise<InitialMedia> {
  if (!navigator.mediaDevices?.getUserMedia) return { stream: new MediaStream(), blocked: false, denied: false };
  const audio = audioConstraints(undefined, enhanced);
  const video = videoConstraints();
  const both = await grab({ audio, video });
  let parts = [both];
  if (!both.stream) {
    // After a refusal, ask alone only for a kind that is granted, or that the
    // combined request never prompted for: no second prompt.
    const [mic, cam] = both.blocked ? await Promise.all(PERMS.map(permState)) : (["granted", "granted"] as const);
    const ask = (self: PermissionState | null, other: PermissionState | null, c: MediaStreamConstraints): Promise<Grab> =>
      self === "granted" || (self === "prompt" && other === "denied") ? grab(c) : Promise.resolve({ stream: null, blocked: true });
    parts = await Promise.all([ask(mic, cam, { audio }), ask(cam, mic, { video })]);
  }
  const streams = parts.flatMap((p) => (p.stream ? [p.stream] : []));
  for (const t of streams.flatMap((s) => s.getVideoTracks())) t.stop();
  const blocked = parts.some((p) => p.blocked);
  return {
    stream: new MediaStream(streams.flatMap((s) => s.getAudioTracks())),
    blocked,
    denied: blocked && (await permissionDenied()),
  };
}

export async function getCameraTrack(videoDeviceId?: string): Promise<MediaStreamTrack> {
  const [track] = (await navigator.mediaDevices.getUserMedia({ video: videoConstraints(videoDeviceId) })).getVideoTracks();
  track.contentHint = "motion";
  return track;
}

export async function getScreenStream(): Promise<MediaStream> {
  const options = {
    video: { frameRate: { ideal: 30 } },
    // Tab/system audio: keep it unprocessed — echo cancellation and noise
    // suppression mangle music and video soundtracks.
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    systemAudio: "include",
    // Capturing this tab would loop the partner's own audio back to them.
    selfBrowserSurface: "exclude",
  } as DisplayMediaStreamOptions;
  const stream = await navigator.mediaDevices.getDisplayMedia(options);
  for (const t of stream.getVideoTracks()) t.contentHint = "detail";
  for (const t of stream.getAudioTracks()) t.contentHint = "music";
  return stream;
}

let enhancerBytes: Promise<ArrayBuffer | null> | null = null;

/** Fetches the Rust voice enhancer (wasm) once; null when this browser cannot run it. */
export function loadEnhancer(): Promise<ArrayBuffer | null> {
  if (typeof AudioWorkletNode === "undefined" || typeof WebAssembly !== "object") return Promise.resolve(null);
  return (enhancerBytes ??= fetch(enhancerWasmUrl)
    .then((res) => (res.ok ? res.arrayBuffer() : null))
    .then((buf) => (buf && WebAssembly.validate(buf) ? buf : null))
    .catch(() => null));
}

async function createEnhancer(ctx: AudioContext, bytes: ArrayBuffer): Promise<AudioWorkletNode | null> {
  if (!ctx.audioWorklet) return null;
  try {
    await ctx.audioWorklet.addModule(enhancerWorkletUrl);
    const node = new AudioWorkletNode(ctx, ENHANCER, {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      channelCount: 1,
      channelCountMode: "explicit",
      channelInterpretation: "speakers",
      processorOptions: { bytes },
    });
    // The processor reports whether the wasm compiled. No report in time
    // (render thread not started yet) counts as success; a later trap is
    // caught by onprocessorerror.
    const ok = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(true), ENHANCER_READY_MS);
      node.port.onmessage = (e: MessageEvent<{ ok?: boolean }>) => {
        clearTimeout(timer);
        resolve(e.data?.ok === true);
      };
    });
    node.port.onmessage = null;
    if (!ok) node.disconnect();
    return ok ? node : null;
  } catch {
    return null;
  }
}

/**
 * One persistent audio graph for the outgoing audio:
 *   mic → Rust voice enhancer (RNNoise, gate, leveler, compressor, limiter) → out
 *   screen-share audio (unprocessed) → out
 * Both reach the partner over the single audio sender, so screen audio needs
 * no renegotiation. `track` is null while the context is not running (autoplay
 * policy); the caller then sends the raw mic, and `onChange` fires when that
 * flips. Muting the mic track mutes only the voice, not the shared audio.
 */
export class AudioPipeline {
  private readonly dest: MediaStreamAudioDestinationNode;
  private mic: MediaStreamAudioSourceNode | null = null;
  private screen: MediaStreamAudioSourceNode | null = null;

  private readonly wake = (): void => {
    if (this.ctx.state === "suspended" || (this.ctx.state as string) === "interrupted") {
      void this.ctx.resume().catch(() => undefined);
    }
  };

  private constructor(
    private readonly ctx: AudioContext,
    private fx: AudioWorkletNode | null,
    private readonly onChange: () => void,
  ) {
    this.dest = ctx.createMediaStreamDestination();
    if (fx) {
      fx.connect(this.dest);
      fx.onprocessorerror = () => this.bypass();
    }
    ctx.onstatechange = () => onChange();
    for (const e of WAKE_EVENTS) addEventListener(e, this.wake, true);
    this.wake();
  }

  /** Never rejects; null when Web Audio is unusable here. */
  static async create(
    bytes: ArrayBuffer | null,
    mic: MediaStreamTrack | null,
    onChange: () => void,
  ): Promise<AudioPipeline | null> {
    if (typeof AudioContext === "undefined") return null;
    // RNNoise runs at 48 kHz. Some browsers refuse a mic source whose rate
    // differs from the context rate, so fall back to the device rate.
    for (const sampleRate of [ENHANCER_RATE, undefined]) {
      let ctx: AudioContext | null = null;
      try {
        ctx = new AudioContext({ latencyHint: "interactive", sampleRate });
        const pipeline = new AudioPipeline(ctx, bytes ? await createEnhancer(ctx, bytes) : null, onChange);
        if (pipeline.setMic(mic)) return pipeline;
        pipeline.close();
      } catch {
        void ctx?.close().catch(() => undefined);
      }
    }
    return null;
  }

  /** Processed outgoing track, or null when the caller must send raw audio. */
  get track(): MediaStreamTrack | null {
    if (this.ctx.state !== "running" || (!this.mic && !this.screen)) return null;
    return this.dest.stream.getAudioTracks()[0] ?? null;
  }

  get enhanced(): boolean {
    return this.fx !== null;
  }

  setMic(track: MediaStreamTrack | null): boolean {
    this.mic?.disconnect();
    this.mic = null;
    if (!track) return true;
    try {
      this.mic = this.ctx.createMediaStreamSource(new MediaStream([track]));
      this.mic.connect(this.fx ?? this.dest);
      return true;
    } catch {
      this.mic = null;
      return false;
    }
  }

  setScreen(track: MediaStreamTrack | null): void {
    this.screen?.disconnect();
    this.screen = null;
    if (!track) return;
    try {
      this.screen = this.ctx.createMediaStreamSource(new MediaStream([track]));
      this.screen.connect(this.dest);
    } catch {
      this.screen = null;
    }
  }

  private bypass(): void {
    this.fx?.disconnect();
    this.fx = null;
    this.mic?.disconnect();
    this.mic?.connect(this.dest);
    this.onChange();
  }

  close(): void {
    for (const e of WAKE_EVENTS) removeEventListener(e, this.wake, true);
    this.ctx.onstatechange = null;
    this.mic?.disconnect();
    this.screen?.disconnect();
    this.fx?.disconnect();
    for (const t of this.dest.stream.getTracks()) t.stop();
    void this.ctx.close().catch(() => undefined);
  }
}

type Priority = "very-low" | "low" | "medium" | "high";
type PriorityEncoding = RTCRtpEncodingParameters & { priority?: Priority; networkPriority?: Priority };

/**
 * Gives audio the larger share of a congested link and DSCP marking, so
 * voice stays clear while video degrades first.
 */
export async function prioritizeAudio(sender: RTCRtpSender | null): Promise<void> {
  const params = sender?.getParameters();
  const encodings = params?.encodings as PriorityEncoding[] | undefined;
  if (!sender || !params || !encodings?.length) return;
  if (encodings.every((e) => e.priority === "high" && e.networkPriority === "high")) return;
  for (const e of encodings) e.priority = e.networkPriority = "high";
  await sender.setParameters(params).catch(() => undefined);
}

export interface MediaDeviceOption {
  deviceId: string;
  label: string;
}

export async function listDevices(): Promise<{ cameras: MediaDeviceOption[]; microphones: MediaDeviceOption[] }> {
  const devices = await navigator.mediaDevices.enumerateDevices();
  const toOption = (d: MediaDeviceInfo, index: number, prefix: string): MediaDeviceOption => ({
    deviceId: d.deviceId,
    label: d.label || `${prefix} ${index + 1}`,
  });
  return {
    cameras: devices.filter((d) => d.kind === "videoinput").map((d, i) => toOption(d, i, "Camera")),
    microphones: devices.filter((d) => d.kind === "audioinput").map((d, i) => toOption(d, i, "Microphone")),
  };
}

async function fetchTurnIceServers(): Promise<RTCIceServer[] | null> {
  try {
    const res = await fetch(SIGNAL_TURN_CREDENTIALS_URL);
    if (!res.ok) return null;
    const data = (await res.json()) as { iceServers?: RTCIceServer[] };
    return data.iceServers ?? null;
  } catch {
    return null;
  }
}

// Credentials are issued with a 1h TTL (worker); reuse them for well under
// that so peer-connection resets and rejoins don't each pay a round trip.
const ICE_SERVERS_CACHE_MS = 30 * 60 * 1000;
let iceServersCache: { at: number; servers: Promise<RTCIceServer[]> } | null = null;

/** Starts (or reuses) the ICE server fetch. Safe to call early to warm the cache. */
export function getIceServers(): Promise<RTCIceServer[]> {
  const now = Date.now();
  if (!iceServersCache || now - iceServersCache.at > ICE_SERVERS_CACHE_MS) {
    const servers = fetchTurnIceServers().then((turn) => {
      // Don't keep a failed fetch cached — retry on the next connection.
      if (!turn) iceServersCache = null;
      return turn ?? FALLBACK_ICE_SERVERS;
    });
    iceServersCache = { at: now, servers };
  }
  return iceServersCache.servers;
}

export async function createPeerConnection(): Promise<RTCPeerConnection> {
  return new RTCPeerConnection({ iceServers: await getIceServers() });
}

export function getOutgoingVideoResolution(sender: RTCRtpSender | null): { width: number; height: number } | null {
  const track = sender?.track;
  if (!track || track.kind !== "video") return null;
  const settings = track.getSettings();
  if (!settings.width || !settings.height) return null;
  return { width: settings.width, height: settings.height };
}

export type ConnectionQuality = "good" | "fair" | "poor";
export type TransportType = "direct" | "relay" | null;

export interface NetworkStats {
  level: ConnectionQuality;
  /** Estimated available send bandwidth in kbps, from the outbound candidate pair. */
  availableOutgoingKbps: number | null;
  /** Measured receive throughput in kbps, from inbound-rtp byte deltas. */
  downloadKbps: number | null;
  /** Measured send throughput in kbps, from outbound-rtp byte deltas. */
  uploadKbps: number | null;
  /** Whether media is flowing directly (STUN/host) or via a TURN relay. */
  transport: TransportType;
}

export function pollConnectionQuality(
  pc: RTCPeerConnection,
  onStats: (stats: NetworkStats) => void,
  intervalMs: number,
): () => void {
  let prevPacketsLost = 0;
  let prevPacketsReceived = 0;
  let prevBytesReceived = 0;
  let prevBytesSent = 0;
  let prevTimestamp = 0;
  let hasPrev = false;

  const tick = async () => {
    try {
      const stats = await pc.getStats();
      let rttMs: number | null = null;
      let availableOutgoingBitrate: number | null = null;
      let packetsLost = 0;
      let packetsReceived = 0;
      let bytesReceived = 0;
      let bytesSent = 0;
      let timestamp = 0;
      let localCandidateId: string | null = null;

      stats.forEach((report) => {
        if (report.type === "candidate-pair" && report.state === "succeeded" && "currentRoundTripTime" in report) {
          rttMs = (report.currentRoundTripTime as number) * 1000;
          localCandidateId = (report.localCandidateId as string) ?? null;
          if ("availableOutgoingBitrate" in report) {
            availableOutgoingBitrate = report.availableOutgoingBitrate as number;
          }
        }
        if (report.type === "inbound-rtp" && report.kind === "video") {
          packetsLost = (report.packetsLost as number) ?? 0;
          packetsReceived = (report.packetsReceived as number) ?? 0;
          bytesReceived = (report.bytesReceived as number) ?? 0;
          timestamp = report.timestamp as number;
        }
        if (report.type === "outbound-rtp" && report.kind === "video") {
          bytesSent = (report.bytesSent as number) ?? 0;
        }
      });

      let transport: TransportType = null;
      if (localCandidateId) {
        const localCandidate = stats.get(localCandidateId);
        if (localCandidate?.type === "local-candidate") {
          transport = localCandidate.candidateType === "relay" ? "relay" : "direct";
        }
      }

      let lossRatio = 0;
      let downloadKbps: number | null = null;
      let uploadKbps: number | null = null;
      if (hasPrev) {
        const deltaLost = Math.max(0, packetsLost - prevPacketsLost);
        const deltaReceived = Math.max(0, packetsReceived - prevPacketsReceived);
        const total = deltaLost + deltaReceived;
        lossRatio = total > 0 ? deltaLost / total : 0;

        const deltaSeconds = (timestamp - prevTimestamp) / 1000;
        if (deltaSeconds > 0) {
          downloadKbps = ((bytesReceived - prevBytesReceived) * 8) / 1000 / deltaSeconds;
          uploadKbps = ((bytesSent - prevBytesSent) * 8) / 1000 / deltaSeconds;
        }
      }
      prevPacketsLost = packetsLost;
      prevPacketsReceived = packetsReceived;
      prevBytesReceived = bytesReceived;
      prevBytesSent = bytesSent;
      prevTimestamp = timestamp;
      hasPrev = true;

      let level: ConnectionQuality = "good";
      if (lossRatio > 0.08 || (rttMs !== null && rttMs > 400)) {
        level = "poor";
      } else if (lossRatio > 0.02 || (rttMs !== null && rttMs > 200)) {
        level = "fair";
      }

      onStats({
        level,
        availableOutgoingKbps: availableOutgoingBitrate !== null ? availableOutgoingBitrate / 1000 : null,
        downloadKbps,
        uploadKbps,
        transport,
      });
    } catch {
      // getStats can throw briefly during renegotiation — skip this tick.
    }
  };

  const timer = window.setInterval(() => void tick(), intervalMs);
  return () => window.clearInterval(timer);
}

const MIN_VIDEO_BITRATE_KBPS = 100;
const MAX_VIDEO_BITRATE_KBPS = 2500;

/**
 * Adjusts the outgoing video bitrate cap to match available bandwidth.
 * WebRTC already adapts encoder output within whatever cap is set; this
 * narrows that cap on a constrained link so the encoder targets a bitrate
 * it can actually deliver, instead of over-producing and forcing packet
 * loss/retransmits that make video choppier than a lower bitrate would be.
 */
export async function adaptVideoBitrate(sender: RTCRtpSender | null, availableKbps: number | null): Promise<void> {
  if (!sender || !sender.track || sender.track.kind !== "video" || availableKbps === null) return;

  // Leave headroom for audio + RTCP + retransmits rather than saturating the link.
  const targetKbps = Math.round(Math.min(MAX_VIDEO_BITRATE_KBPS, Math.max(MIN_VIDEO_BITRATE_KBPS, availableKbps * 0.7)));

  const params = sender.getParameters();
  if (!params.encodings || params.encodings.length === 0) {
    params.encodings = [{}];
  }

  const currentMaxKbps = params.encodings[0].maxBitrate ? params.encodings[0].maxBitrate / 1000 : null;
  // Avoid churn from setParameters on every poll tick for small fluctuations.
  if (currentMaxKbps !== null && Math.abs(currentMaxKbps - targetKbps) < targetKbps * 0.15) return;

  params.encodings[0].maxBitrate = targetKbps * 1000;
  try {
    await sender.setParameters(params);
  } catch {
    // setParameters can reject if called mid-renegotiation — next poll tick retries.
  }
}
