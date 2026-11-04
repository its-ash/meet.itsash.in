const VERSION = "meet-v1";
const SHELL = ["/", "/manifest.webmanifest", "/icon.svg", "/icon-192.png", "/icon-512.png"];
const ROOM_RE = /^\/[a-z0-9]{4}\/?$/i;

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

const put = async (req, res) => {
  if (res.ok && res.type === "basic") await (await caches.open(VERSION)).put(req, res.clone());
  return res;
};

const shell = async () => {
  try {
    return await put("/", await fetch("/", { cache: "no-store" }));
  } catch {
    return (await caches.match("/")) ?? Response.error();
  }
};

const cacheFirst = async (req) => (await caches.match(req)) ?? put(req, await fetch(req));

const staleWhileRevalidate = async (req) => {
  const hit = await caches.match(req);
  const net = fetch(req).then((res) => put(req, res)).catch(() => hit ?? Response.error());
  return hit ?? net;
};

self.addEventListener("fetch", (e) => {
  const { request: req } = e;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  if (req.mode === "navigate") {
    if (url.pathname === "/" || ROOM_RE.test(url.pathname)) e.respondWith(shell());
    return;
  }
  if (url.pathname.startsWith("/assets/")) {
    e.respondWith(cacheFirst(req));
    return;
  }
  e.respondWith(staleWhileRevalidate(req));
});
