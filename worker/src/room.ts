import { DurableObject } from "cloudflare:workers";

const HEARTBEAT_THRESHOLD_MS = 5000;
const SWEEP_INTERVAL_MS = 2000;
const STALE_CLOSE_CODE = 4000;
const RESERVATION_TTL_MS = 60_000;
const RESERVED_AT_KEY = "reservedAt";

interface SocketAttachment {
  lastPingMs: number;
  evicted?: boolean;
}

export interface Env {
  ROOM: DurableObjectNamespace<RoomSignal>;
  TURN_KEY_ID?: string;
  TURN_KEY_API_TOKEN?: string;
}

export class RoomSignal extends DurableObject<Env> {
  async getWebSocketCount(): Promise<number> {
    return this.liveSockets().length;
  }

  // Claims this room code for a freshly created meeting so a concurrent
  // /new-room call can't hand the same code to someone else before the host
  // connects. Storage ops hold the DO's input gate, so get+put is atomic.
  async reserve(): Promise<boolean> {
    if (this.liveSockets().length > 0) return false;
    const reservedAt = await this.ctx.storage.get<number>(RESERVED_AT_KEY);
    const now = Date.now();
    if (reservedAt !== undefined && now - reservedAt < RESERVATION_TTL_MS) return false;
    await this.ctx.storage.put(RESERVED_AT_KEY, now);
    return true;
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("expected websocket upgrade", { status: 426 });
    }

    // A peer that changed networks (e.g. wifi -> cellular) often leaves a
    // stale socket behind with no clean close event. Reclaim any socket
    // that's past the heartbeat threshold before judging the room full,
    // rather than waiting for the next alarm sweep to get around to it.
    this.evictStaleSockets();
    if (this.liveSockets().length >= 2) {
      return new Response("room full", { status: 409 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    this.ctx.acceptWebSocket(server);
    this.touch(server);
    await this.ctx.storage.delete(RESERVED_AT_KEY);

    const allSockets = this.liveSockets();
    const nowPaired = allSockets.length === 2;
    if (nowPaired) {
      // The socket that was already here (not the one that just connected)
      // is designated the offerer, so exactly one side starts signaling —
      // otherwise both peers race to create offers ("glare") and the
      // second setRemoteDescription fails because the connection is no
      // longer in the expected signaling state.
      const existing = allSockets.find((s) => s !== server);
      if (existing) this.safeSend(existing, JSON.stringify({ type: "peer-joined", role: "offerer" }));
      this.safeSend(server, JSON.stringify({ type: "peer-joined", role: "answerer" }));
    }

    await this.scheduleSweep();

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message === "string" && this.isPing(message)) {
      this.touch(ws);
      return;
    }

    const sockets = this.liveSockets();
    if (sockets.length < 2) return;

    for (const socket of sockets) {
      if (socket !== ws) this.safeSend(socket, message);
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    // Complete the close handshake — without the auto-reply compat flag the
    // runtime leaves the socket half-open until we reciprocate. 1005/1006
    // are reserved "no status" codes that can't be sent on the wire.
    try {
      ws.close(code === 1005 || code === 1006 ? 1000 : code, reason);
    } catch {
      // Already closed.
    }
    await this.handlePeerGone(ws);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.handlePeerGone(ws);
  }

  private async handlePeerGone(ws: WebSocket): Promise<void> {
    const remaining = this.liveSockets().filter((s) => s !== ws);
    if (remaining.length === 0) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    // An evicted socket's survivor was already notified at eviction time; a
    // late close event for it must not tear down a newer pairing.
    const attachment = this.readAttachment(ws);
    if (attachment?.evicted) return;
    this.notifyPeerLeft(remaining);
  }

  async alarm(): Promise<void> {
    this.evictStaleSockets();

    if (this.liveSockets().length > 0) {
      await this.scheduleSweep();
    } else {
      await this.ctx.storage.deleteAlarm();
    }
  }

  // Dead peers (network switch, lid closed) never send a close frame, so
  // webSocketClose won't fire for them — the survivor is told here instead.
  private evictStaleSockets(): void {
    const now = Date.now();
    let evictedAny = false;
    for (const socket of this.liveSockets()) {
      const attachment = this.readAttachment(socket);
      const lastPingMs = attachment?.lastPingMs ?? now;
      if (now - lastPingMs < HEARTBEAT_THRESHOLD_MS) continue;
      try {
        socket.serializeAttachment({ lastPingMs, evicted: true } satisfies SocketAttachment);
        socket.close(STALE_CLOSE_CODE, "stale-connection");
      } catch {
        // Socket already torn down by the runtime.
      }
      evictedAny = true;
    }
    if (evictedAny) this.notifyPeerLeft(this.liveSockets());
  }

  private liveSockets(): WebSocket[] {
    return this.ctx
      .getWebSockets()
      .filter((s) => s.readyState === WebSocket.OPEN && !this.readAttachment(s)?.evicted);
  }

  private readAttachment(ws: WebSocket): SocketAttachment | null {
    try {
      return ws.deserializeAttachment() as SocketAttachment | null;
    } catch {
      return null;
    }
  }

  private notifyPeerLeft(sockets: WebSocket[]): void {
    const msg = JSON.stringify({ type: "peer-left" });
    for (const socket of sockets) this.safeSend(socket, msg);
  }

  private safeSend(ws: WebSocket, data: string | ArrayBuffer): void {
    try {
      ws.send(data);
    } catch {
      // Peer vanished mid-send; the heartbeat sweep will clean it up.
    }
  }

  private touch(ws: WebSocket): void {
    try {
      ws.serializeAttachment({ lastPingMs: Date.now() } satisfies SocketAttachment);
    } catch {
      // Socket closed between receipt and touch.
    }
  }

  private isPing(message: string): boolean {
    if (message.length > 32) return false;
    try {
      return JSON.parse(message)?.type === "ping";
    } catch {
      return false;
    }
  }

  private async scheduleSweep(): Promise<void> {
    await this.ctx.storage.setAlarm(Date.now() + SWEEP_INTERVAL_MS);
  }
}
