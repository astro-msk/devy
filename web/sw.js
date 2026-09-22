// Devy service worker — versioned app-shell cache.
// Bump VERSION whenever a shell asset changes; the page shows an "update
// available" toast and the new worker takes over only when the user reloads.
const VERSION = "devy-v29";
const SHELL = `${VERSION}-shell`;
const RUNTIME = `${VERSION}-runtime`;
const SHELL_ASSETS = [
  "/",
  "/index.html",
  "/styles.css",
  "/app.js",
  "/gateway.js",
  "/manifest.json",
  "/icon.svg",
  "/icon-192.png",
  "/icon-512.png",
  "/icon-maskable-512.png",
  "/apple-touch-icon.png",
  "/vendor/xterm/xterm.js",
  "/vendor/xterm/css/xterm.css",
  "/vendor/xterm-addon-fit/addon-fit.js",
  "/vendor/xterm-addon-web-links/addon-web-links.js",
  "/vendor/xterm-addon-search/addon-search.js",
  "/vendor/xterm-addon-unicode11/addon-unicode11.js",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(SHELL).then((cache) =>
      // Fetch each asset individually so one missing vendor file can't fail the
      // whole install; cache: "reload" bypasses the HTTP cache for a fresh copy.
      Promise.all(
        SHELL_ASSETS.map((url) =>
          fetch(new Request(url, { cache: "reload" }))
            .then((res) => (res.ok ? cache.put(url, res) : null))
            .catch(() => null)
        )
      )
    )
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key.startsWith("devy-v") && key !== SHELL && key !== RUNTIME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

// Only look in this version's caches: a waiting (newer) worker has already
// precached its own shell, and caches.match() with no cache name would let the
// old page pick up a mismatched new app.js.
async function matchOwn(request) {
  for (const name of [SHELL, RUNTIME]) {
    const hit = await caches.open(name).then((cache) => cache.match(request));
    if (hit) return hit;
  }
  return undefined;
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== location.origin) return;
  // The companion app owns its own scoped worker and shell cache.
  if (url.pathname === "/remote" || url.pathname.startsWith("/remote/")) return;
  // Live data and streams are never cached: REST, SSE, WebSocket upgrades.
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/ws/")) return;
  if (request.headers.get("accept") === "text/event-stream") return;

  // Keep the HTML and JS from one release together. A new worker precaches
  // the next release, then activates when the user accepts the update.
  if (request.mode === "navigate" || url.pathname === "/" || url.pathname.endsWith(".html")) {
    event.respondWith(
      matchOwn("/index.html").then((cached) => cached || fetch(request))
        .then((res) => {
          if (res.ok) caches.open(SHELL).then((cache) => cache.put("/index.html", res.clone())).catch(() => {});
          return res;
        })
        .catch(() => matchOwn("/index.html"))
    );
    return;
  }

  // Versioned shell assets stay together until the next worker activates.
  if (SHELL_ASSETS.includes(url.pathname)) {
    event.respondWith(matchOwn(request).then((cached) => cached || fetch(request)));
    return;
  }
  // Other static assets may refresh in the background.
  event.respondWith(
    matchOwn(request).then((cached) => {
      const network = fetch(request)
        .then((res) => {
          if (res.ok) caches.open(RUNTIME).then((cache) => cache.put(request, res.clone())).catch(() => {});
          return res;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") self.skipWaiting();
});

// Tapping a "needs input" notification focuses the app on that session's terminal.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = event.notification.data?.url || "/#sessions";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if ("focus" in client) {
          client.postMessage({ type: "NAVIGATE", url: target });
          return client.focus();
        }
      }
      return self.clients.openWindow(target);
    })
  );
});
