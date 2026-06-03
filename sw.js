/**
 * Service Worker für Unternehmens-Imperium (PWA).
 * - Precached die App-Shell für Offline-Start.
 * - Laufzeit-Cache (cache-first mit Netzwerk-Aktualisierung) für gleiche Herkunft.
 * - /api/-Aufrufe werden NIE gecacht (immer frisch vom Backend).
 *
 * Hinweis: Service Worker laufen nur in sicherem Kontext (https oder localhost).
 * Über http://<IP> wird der SW vom Browser ignoriert — das Spiel läuft trotzdem.
 */
const CACHE = 'imperium-v1';
const SHELL = [
  './',
  'index.html',
  'css/styles.css',
  'manifest.webmanifest',
  'icon.svg',
  'js/main.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  // Nicht-GET und API-Aufrufe nicht abfangen → gehen direkt ans Netzwerk.
  if (req.method !== 'GET' || url.pathname.includes('/api/')) return;

  event.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req)
        .then((res) => {
          if (res.ok && url.origin === self.location.origin) {
            const copy = res.clone();
            caches.open(CACHE).then((cache) => cache.put(req, copy));
          }
          return res;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});
