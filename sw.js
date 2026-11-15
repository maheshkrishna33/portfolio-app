// Offline support: app files come from the network when available (so updates arrive
// automatically) and from this cache when offline.
const CACHE = "portfolio-v1";
const SHELL = ["./", "index.html", "app.css", "manifest.webmanifest", "vendor/xlsx.full.min.js", "icons/icon-192.png", "icons/icon-512.png",
  "js/main.js", "js/util.js", "js/db.js", "js/calc.js", "js/market.js", "js/data.js", "js/features.js", "js/alerts.js", "js/charts.js", "js/excel.js"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;  // mfapi.in etc. go straight to the network
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), url.pathname.includes("/data/") ? 30000 : 5000);
      const res = await fetch(e.request, { signal: ctrl.signal });
      clearTimeout(t);
      if (res.ok && !url.pathname.includes("/data/")) cache.put(e.request, res.clone());
      return res;
    } catch (err) {
      const hit = await cache.match(e.request, { ignoreSearch: !url.pathname.includes("/data/") });
      if (hit) return hit;
      if (e.request.mode === "navigate") return cache.match("index.html");
      throw err;
    }
  })());
});
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: "window" }).then((cs) => (cs[0] ? cs[0].focus() : self.clients.openWindow("./"))));
});
