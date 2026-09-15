import { DurableObject } from "cloudflare:workers";

const HEARTBEAT_THRESHOLD_MS = 5000;
const SWEEP_INTERVAL_MS = 2000;
const STALE_CLOSE_CODE = 4000;

interface SocketAttachment {
  lastPingMs: number;
}

export interface Env {
  ROOM: DurableObjectNamespace<RoomSignal>;
  TURN_KEY_ID?: string;
  TURN_KEY_API_TOKEN?: string;
}

export class RoomSignal extends DurableObject<Env> {
  async getWebSocketCount(): Promise<number> {
    return this.ctx.getWebSockets().length;
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("expected websocket upgrade", { status: 426 });
    }

    // A peer that changed networks (e.g. wifi -> cellular) often leaves a
    // stale socket behind with no clean close event. Reclaim any socket
    // that's past the heartbeat threshold before judging the room full,
    // rather than waiting for the next alarm sweep to get around to it.
    // Count live sockets directly (rather than re-reading getWebSockets()
    // right after close()) so this doesn't depend on how quickly a closed
    // socket is removed from that list.
    const evicted = this.evictStaleSockets();
    const liveCount = this.ctx.getWebSockets().length - evicted.length;
    if (liveCount >= 2) {
      return new Response("room full", { status: 409 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    this.ctx.acceptWebSocket(server);
    this.touch(server);

    const evictedSet = new Set(evicted);
    const allSockets = this.ctx.getWebSockets().filter((s) => !evictedSet.has(s));
    const nowPaired = allSockets.length === 2;
    if (nowPaired) {
      // The socket that was already here (not the one that just connected)
      // is designated the offerer, so exactly one side starts signaling —
      // otherwise both peers race to create offers ("glare") and the
      // second setRemoteDescription fails because the connection is no
      // longer in the expected signaling state.
      const existing = allSockets.find((s) => s !== server);
      existing?.send(JSON.stringify({ type: "peer-joined", role: "offerer" }));
      server.send(JSON.stringify({ type: "peer-joined", role: "answerer" }));
    }

    await this.scheduleSweep();

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message === "string" && this.isPing(message)) {
      this.touch(ws);
      return;
    }

    const sockets = this.ctx.getWebSockets();
    if (sockets.length < 2) return;

    for (const socket of sockets) {
      if (socket !== ws) {
        socket.send(message);
      }
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    await this.handlePeerGone(ws);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.handlePeerGone(ws);
  }

  private async handlePeerGone(ws: WebSocket): Promise<void> {
    const remaining = this.ctx.getWebSockets().filter((s) => s !== ws);
    if (remaining.length === 0) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    for (const socket of remaining) {
      socket.send(JSON.stringify({ type: "peer-left" }));
    }
  }

  async alarm(): Promise<void> {
    const evicted = this.evictStaleSockets();
    const liveCount = this.ctx.getWebSockets().length - evicted.length;

    if (liveCount > 0) {
      await this.scheduleSweep();
    } else {
      await this.ctx.storage.deleteAlarm();
    }
  }

  private evictStaleSockets(): WebSocket[] {
    const now = Date.now();
    const evicted: WebSocket[] = [];
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = socket.deserializeAttachment() as SocketAttachment | null;
      const lastPingMs = attachment?.lastPingMs ?? now;
      if (now - lastPingMs >= HEARTBEAT_THRESHOLD_MS) {
        socket.close(STALE_CLOSE_CODE, "stale-connection");
        evicted.push(socket);
      }
    }
    return evicted;
  }

  private touch(ws: WebSocket): void {
    const attachment: SocketAttachment = { lastPingMs: Date.now() };
    ws.serializeAttachment(attachment);
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
