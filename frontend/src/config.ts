export const SIGNAL_HOST = "meet-signal.its-ash.workers.dev";
export const SIGNAL_WS_URL = `wss://${SIGNAL_HOST}/ws`;
export const SIGNAL_NEW_ROOM_URL = `https://${SIGNAL_HOST}/new-room`;
export const SIGNAL_ROOM_STATUS_URL = `https://${SIGNAL_HOST}/room-status`;
export const SIGNAL_TURN_CREDENTIALS_URL = `https://${SIGNAL_HOST}/turn-credentials`;
export const DOWNLOAD_URL = "https://github.com/its-ash/meet.itsash.in/releases/latest/download";

export const FALLBACK_ICE_SERVERS: RTCIceServer[] = [
  { urls: "stun:stun.cloudflare.com:3478" },
  { urls: "stun:stun.l.google.com:19302" },
];

export const HEARTBEAT_INTERVAL_MS = 2000;
export const ICE_RECONNECT_GRACE_MS = 3000;
export const RECOVERY_TIMEOUT_MS = 15000;
export const SOCKET_RETRY_BASE_MS = 500;
export const SOCKET_RETRY_MAX_MS = 4000;
/** No pong for this long on an open socket: the link is dead, reconnect. */
export const SOCKET_DEAD_MS = 6500;
/** A socket still connecting after this long is dropped and retried. */
export const SOCKET_CONNECT_TIMEOUT_MS = 8000;
/** Recovery rejoin delay grows up to this many times RECOVERY_TIMEOUT_MS. */
export const MAX_RECOVERY_BACKOFF = 4;
export const FULL_ROOM_POLL_MS = 3000;
export const QUALITY_POLL_INTERVAL_MS = 2000;
export const ENHANCER_READY_MS = 1500;
