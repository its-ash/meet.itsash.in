import { FALLBACK_ICE_SERVERS, SIGNAL_TURN_CREDENTIALS_URL } from "./config";

const VIDEO_CODEC_PREFERENCE = ["AV1", "VP9", "H264", "VP8"];
const AUDIO_CODEC_PREFERENCE = ["opus"];

function preferCodecs(kind: "video" | "audio", codecs: RTCRtpCodec[], preference: string[]): RTCRtpCodec[] {
  const ranked = [...codecs].sort((a, b) => {
    const rankA = preference.findIndex((name) => a.mimeType.toLowerCase() === `${kind}/${name.toLowerCase()}`);
    const rankB = preference.findIndex((name) => b.mimeType.toLowerCase() === `${kind}/${name.toLowerCase()}`);
    const normA = rankA === -1 ? preference.length : rankA;
    const normB = rankB === -1 ? preference.length : rankB;
    return normA - normB;
  });
  return ranked;
}

export function applyCodecPreferences(pc: RTCPeerConnection): void {
  if (typeof RTCRtpSender.getCapabilities !== "function") return;

  for (const transceiver of pc.getTransceivers()) {
    const kind = transceiver.sender.track?.kind as "video" | "audio" | undefined;
    if (!kind || typeof transceiver.setCodecPreferences !== "function") continue;

    const capabilities = RTCRtpSender.getCapabilities(kind);
    if (!capabilities) continue;

    const preference = kind === "video" ? VIDEO_CODEC_PREFERENCE : AUDIO_CODEC_PREFERENCE;
    const ordered = preferCodecs(kind, capabilities.codecs, preference);
    try {
      transceiver.setCodecPreferences(ordered);
    } catch {
      // Unsupported in this browser (e.g. Safari) — fall back to default negotiation.
    }
  }
}

export interface DeviceConstraints {
  videoDeviceId?: string;
  audioDeviceId?: string;
}

export async function getLocalStream(constraints: DeviceConstraints = {}): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({
    video: {
      // Ideal, not exact: lets the browser pick the sensor's natural
      // portrait/landscape shape (important on mobile) instead of forcing
      // a fixed 1280x720 landscape frame that then gets cropped oddly by
      // object-cover in a portrait-shaped video element.
      width: { ideal: 1280 },
      height: { ideal: 720 },
      aspectRatio: { ideal: window.innerWidth / window.innerHeight },
      frameRate: { ideal: 30 },
      ...(constraints.videoDeviceId ? { deviceId: { exact: constraints.videoDeviceId } } : {}),
    },
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      ...(constraints.audioDeviceId ? { deviceId: { exact: constraints.audioDeviceId } } : {}),
    },
  });
}

export async function getScreenStream(): Promise<MediaStream> {
  return navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
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

export type ConnectionQuality = "good" | "fair" | "poor";

export interface NetworkStats {
  level: ConnectionQuality;
  /** Estimated available send bandwidth in kbps, from the outbound candidate pair. */
  availableOutgoingKbps: number | null;
  /** Measured receive throughput in kbps, from inbound-rtp byte deltas. */
  downloadKbps: number | null;
  /** Measured send throughput in kbps, from outbound-rtp byte deltas. */
  uploadKbps: number | null;
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

      stats.forEach((report) => {
        if (report.type === "candidate-pair" && report.state === "succeeded" && "currentRoundTripTime" in report) {
          rttMs = (report.currentRoundTripTime as number) * 1000;
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
