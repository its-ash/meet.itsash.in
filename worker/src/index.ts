import { RoomSignal, type Env } from "./room";

export { RoomSignal };

const ROOM_ID_RE = /^[a-z0-9]{4}$/i;
const ROOM_ID_ALPHABET = "23456789abcdefghjkmnpqrstuvwxyz";
const TURN_CREDENTIAL_TTL_SECONDS = 3600;

function randomRoomId(): string {
  let id = "";
  for (let i = 0; i < 4; i++) {
    id += ROOM_ID_ALPHABET[Math.floor(Math.random() * ROOM_ID_ALPHABET.length)];
  }
  return id;
}

function corsHeaders(origin: string | null): HeadersInit {
  return {
    "Access-Control-Allow-Origin": origin ?? "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin");

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders(origin) });
    }

    if (url.pathname === "/new-room" && request.method === "GET") {
      for (let attempt = 0; attempt < 10; attempt++) {
        const candidate = randomRoomId();
        const id = env.ROOM.idFromName(candidate);
        const stub = env.ROOM.get(id);
        const sockets = await stub.getWebSocketCount?.().catch(() => 0);
        if (!sockets) {
          return new Response(JSON.stringify({ roomId: candidate }), {
            headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
          });
        }
      }
      return new Response(JSON.stringify({ error: "could not allocate room" }), {
        status: 503,
        headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
      });
    }

    if (url.pathname === "/turn-credentials" && request.method === "GET") {
      if (!env.TURN_KEY_ID || !env.TURN_KEY_API_TOKEN) {
        return new Response(JSON.stringify({ error: "turn not configured" }), {
          status: 503,
          headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
        });
      }
      try {
        const turnRes = await fetch(
          `https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_KEY_ID}/credentials/generate-ice-servers`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${env.TURN_KEY_API_TOKEN}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ ttl: TURN_CREDENTIAL_TTL_SECONDS }),
          },
        );
        if (!turnRes.ok) {
          return new Response(JSON.stringify({ error: "turn credential request failed" }), {
            status: 502,
            headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
          });
        }
        const data = await turnRes.json();
        return new Response(JSON.stringify(data), {
          headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
        });
      } catch {
        return new Response(JSON.stringify({ error: "turn credential request failed" }), {
          status: 502,
          headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
        });
      }
    }

    const statusMatch = url.pathname.match(/^\/room-status\/([^/]+)$/);
    if (statusMatch && request.method === "GET") {
      const roomId = statusMatch[1];
      if (!ROOM_ID_RE.test(roomId)) {
        return new Response("invalid room id", { status: 400 });
      }
      const id = env.ROOM.idFromName(roomId.toLowerCase());
      const stub = env.ROOM.get(id);
      const count = await stub.getWebSocketCount();
      return new Response(JSON.stringify({ count }), {
        headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
      });
    }

    const match = url.pathname.match(/^\/ws\/([^/]+)$/);
    if (match) {
      const roomId = match[1];
      if (!ROOM_ID_RE.test(roomId)) {
        return new Response("invalid room id", { status: 400 });
      }
      const id = env.ROOM.idFromName(roomId.toLowerCase());
      const stub = env.ROOM.get(id);
      return stub.fetch(request);
    }

    return new Response("not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
