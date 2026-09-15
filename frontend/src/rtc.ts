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
      width: { ideal: 1280 },
      height: { ideal: 720 },
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

export function pollConnectionQuality(
  pc: RTCPeerConnection,
  onQuality: (level: ConnectionQuality) => void,
  intervalMs: number,
): () => void {
  let prevPacketsLost = 0;
  let prevPacketsReceived = 0;
  let hasPrev = false;

  const tick = async () => {
    try {
      const stats = await pc.getStats();
      let rttMs: number | null = null;
      let packetsLost = 0;
      let packetsReceived = 0;

      stats.forEach((report) => {
        if (report.type === "candidate-pair" && report.state === "succeeded" && "currentRoundTripTime" in report) {
          rttMs = (report.currentRoundTripTime as number) * 1000;
        }
        if (report.type === "inbound-rtp" && report.kind === "video") {
          packetsLost = (report.packetsLost as number) ?? 0;
          packetsReceived = (report.packetsReceived as number) ?? 0;
        }
      });

      let lossRatio = 0;
      if (hasPrev) {
        const deltaLost = Math.max(0, packetsLost - prevPacketsLost);
        const deltaReceived = Math.max(0, packetsReceived - prevPacketsReceived);
        const total = deltaLost + deltaReceived;
        lossRatio = total > 0 ? deltaLost / total : 0;
      }
      prevPacketsLost = packetsLost;
      prevPacketsReceived = packetsReceived;
      hasPrev = true;

      let level: ConnectionQuality = "good";
      if (lossRatio > 0.08 || (rttMs !== null && rttMs > 400)) {
        level = "poor";
      } else if (lossRatio > 0.02 || (rttMs !== null && rttMs > 200)) {
        level = "fair";
      }
      onQuality(level);
    } catch {
      // getStats can throw briefly during renegotiation — skip this tick.
    }
  };

  const timer = window.setInterval(() => void tick(), intervalMs);
  return () => window.clearInterval(timer);
}
