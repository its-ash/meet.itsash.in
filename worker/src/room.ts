import { DurableObject } from "cloudflare:workers";

const PAIR_TIMEOUT_MS = 5000;
const NO_PEER_CLOSE_CODE = 4000;
const PEER_LEFT_CLOSE_CODE = 4002;

export interface Env {
  ROOM: DurableObjectNamespace<RoomSignal>;
}

export class RoomSignal extends DurableObject<Env> {
  async getWebSocketCount(): Promise<number> {
    return this.ctx.getWebSockets().length;
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("expected websocket upgrade", { status: 426 });
    }

    const sockets = this.ctx.getWebSockets();
    if (sockets.length >= 2) {
      return new Response("room full", { status: 409 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    this.ctx.acceptWebSocket(server);

    const nowPaired = this.ctx.getWebSockets().length === 2;
    if (nowPaired) {
      await this.ctx.storage.deleteAlarm();
      for (const socket of this.ctx.getWebSockets()) {
        socket.send(JSON.stringify({ type: "peer-joined" }));
      }
    } else {
      await this.ctx.storage.setAlarm(Date.now() + PAIR_TIMEOUT_MS);
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
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
      socket.close(PEER_LEFT_CLOSE_CODE, "peer-left");
    }
  }

  async alarm(): Promise<void> {
    const sockets = this.ctx.getWebSockets();
    if (sockets.length < 2) {
      for (const socket of sockets) {
        socket.close(NO_PEER_CLOSE_CODE, "no-peer-timeout");
      }
    }
  }
}
