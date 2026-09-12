// App-shell cache for the Devy remote. Bump VERSION with every shell change;
// activation deletes every older cache, including the pre-rename ones.
const VERSION = "v15";
const BASE = new URL("./", self.location.href);
const shellUrl = (asset) => new URL(asset, BASE).href;
const CACHE_PREFIX = `devy-remote-${BASE.pathname.replaceAll("/", "_")}-`;
const CACHE = `${CACHE_PREFIX}${VERSION}`;
const SHELL = ["./", "index.html", "styles.css", "app.js", "manifest.json", "icon.svg", "icon-192.png", "icon-512.png", "icon-maskable-512.png", "apple-touch-icon.png"].map(shellUrl);

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) =>
      // cache: "reload" bypasses the HTTP cache so a new worker never precaches
      // a stale copy of the shell.
      cache.addAll(SHELL.map((url) => new Request(url, { cache: "reload" })))
    )
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    Promise.all([
      self.clients.claim(),
      caches.keys().then((keys) => Promise.all(keys.filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE).map((key) => caches.delete(key))))
    ])
  );
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  // Live data is never cached: JSON APIs, the terminal WebSocket, event streams.
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/ws/")) return;

  // Keep HTML and scripts from one version until an update is accepted.
  if (request.mode === "navigate" || url.pathname === BASE.pathname || url.pathname.endsWith(".html")) {
    event.respondWith(caches.open(CACHE).then((cache) => cache.match(shellUrl("index.html"))).then((cached) => cached || fetch(request)));
    return;
  }

  // Everything else in the shell is cache-first; the version bump refreshes it.
  event.respondWith(
    caches.open(CACHE).then((cache) => cache.match(request)).then((cached) => cached || fetch(request))
  );
});
