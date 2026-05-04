const CACHE = 'gaitway-mvp-v1';
const ASSETS = [
  './',
  './index.html',
  './manifest.json',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))));
});

self.addEventListener('fetch', e => {
  if (e.request.url.includes('nominatim') || e.request.url.includes('routing') || e.request.url.includes('open-meteo') || e.request.url.includes('anthropic')) return;
  e.respondWith(caches.match(e.request).then(r => r || fetch(e.request)));
});
