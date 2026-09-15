import { ICE_SERVERS } from "./config";

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

export async function getLocalStream(): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({
    video: {
      width: { ideal: 1280 },
      height: { ideal: 720 },
      frameRate: { ideal: 30 },
    },
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });
}

export function createPeerConnection(): RTCPeerConnection {
  return new RTCPeerConnection({ iceServers: ICE_SERVERS });
}
