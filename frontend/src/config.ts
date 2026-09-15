export const SIGNAL_HOST = "meet-signal.its-ash.workers.dev";
export const SIGNAL_WS_URL = `wss://${SIGNAL_HOST}/ws`;
export const SIGNAL_NEW_ROOM_URL = `https://${SIGNAL_HOST}/new-room`;
export const SIGNAL_ROOM_STATUS_URL = `https://${SIGNAL_HOST}/room-status`;

export const ICE_SERVERS: RTCIceServer[] = [
  { urls: "stun:stun.cloudflare.com:3478" },
  { urls: "stun:stun.l.google.com:19302" },
];

export const PAIR_TIMEOUT_MS = 5000;
export const HEARTBEAT_INTERVAL_MS = 2000;
