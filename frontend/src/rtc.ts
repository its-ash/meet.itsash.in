import { FALLBACK_ICE_SERVERS, SIGNAL_TURN_CREDENTIALS_URL } from "./config";

const VIDEO_CODECS = ["video/AV1", "video/H265", "video/VP9", "video/H264", "video/VP8"];
const AUDIO_CODECS = ["audio/opus"];
const OPUS_FMTP: Record<string, string> = { useinbandfec: "1", usedtx: "1" };

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

const audioConstraints = (audioDeviceId?: string): MediaTrackConstraints => ({
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
  ...(audioDeviceId ? { deviceId: { exact: audioDeviceId } } : {}),
});

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

export async function getMicStream(audioDeviceId?: string): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({ audio: audioConstraints(audioDeviceId) });
}

export async function getInitialMedia(): Promise<MediaStream> {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints(), video: videoConstraints() });
    for (const t of stream.getVideoTracks()) {
      t.stop();
      stream.removeTrack(t);
    }
    if (stream.getAudioTracks().length) return stream;
  } catch {
    // Camera denied, missing, or busy — ask for the mic alone.
  }
  return getMicStream();
}

export async function getCameraTrack(videoDeviceId?: string): Promise<MediaStreamTrack> {
  const [track] = (await navigator.mediaDevices.getUserMedia({ video: videoConstraints(videoDeviceId) })).getVideoTracks();
  track.contentHint = "motion";
  return track;
}

export async function getScreenStream(): Promise<MediaStream> {
  const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
  for (const t of stream.getVideoTracks()) t.contentHint = "detail";
  return stream;
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

export async function createPeerConnection(): Promise<RTCPeerConnection> {
  const turnServers = await fetchTurnIceServers();
  const iceServers = turnServers ?? FALLBACK_ICE_SERVERS;
  return new RTCPeerConnection({ iceServers });
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
