const CACHE = "zynloc-v1";
const SHELL = ["/", "/src/main.jsx", "/src/styles.css"];

self.addEventListener("install", e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(SHELL).catch(() => {}))
  );
  self.skipWaiting();
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);

  // API calls: network first, no cache
  if (url.pathname.startsWith("/api/")) {
    e.respondWith(fetch(e.request).catch(() => new Response(JSON.stringify({ error: "offline" }), { headers: { "Content-Type": "application/json" } })));
    return;
  }

  // face-api model files: cache first (large CDN assets)
  if (url.hostname.includes("jsdelivr.net")) {
    e.respondWith(
      caches.match(e.request).then(cached => {
        if (cached) return cached;
        return fetch(e.request).then(res => {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
          return res;
        });
      })
    );
    return;
  }

  // App shell: network first, fall back to cache
  e.respondWith(
    fetch(e.request).then(res => {
      const clone = res.clone();
      caches.open(CACHE).then(c => c.put(e.request, clone));
      return res;
    }).catch(() => caches.match(e.request).then(cached => cached || caches.match("/")))
  );
});

// Offline message queue — flush on sync
self.addEventListener("sync", e => {
  if (e.tag === "flush-messages") {
    e.waitUntil(flushQueue());
  }
});

async function flushQueue() {
  const db = await openDb();
  const tx = db.transaction("queue", "readwrite");
  const store = tx.objectStore("queue");
  const items = await store.getAll();
  for (const item of items) {
    try {
      await fetch(item.url, { method: item.method, headers: item.headers, body: item.body });
      store.delete(item.id);
    } catch {}
  }
}

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("zynloc-offline", 1);
    req.onupgradeneeded = e => e.target.result.createObjectStore("queue", { keyPath: "id", autoIncrement: true });
    req.onsuccess = e => resolve(e.target.result);
    req.onerror = reject;
  });
}
