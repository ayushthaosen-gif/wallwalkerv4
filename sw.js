/**
 * GaitWay Service Worker
 * - Caches app shell for offline use
 * - Network-first for API calls
 * - Cache-first for static assets
 */

// #16 — cache key includes deploy timestamp so Render rebuilds always bust stale cache
// IMPORTANT: bump this string on every deploy (or set via build script)
const CACHE_VER = '2025-05-13-v1';
const CACHE    = `gaitway-${CACHE_VER}`;
const PRECACHE = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './environment.js',
  './bus_engine.js',
  './metro_engine.js',
  './wmata_engine.js',
  './transit_loader.js',
  './wmata_loader.js',
  './manifest.json',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
  'https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;600;800;900&display=swap',
];

// Install — precache app shell
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(PRECACHE))
      .then(() => self.skipWaiting())
      .catch(err => console.warn('SW precache error:', err))
  );
});

// Activate — clean old caches
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Fetch strategy
self.addEventListener('fetch', e => {
  const url = e.request.url;

  // Skip non-GET and cross-origin API calls
  if (e.request.method !== 'GET') return;

  // Network-only: API calls, routing, tile servers, nominatim
  if (url.includes('/api/') ||
      url.includes('nominatim') ||
      url.includes('routing.openstreetmap') ||
      url.includes('open-meteo') ||
      url.includes('air-quality-api') ||
      url.includes('anthropic') ||
      url.includes('googleapis') ||
      url.includes('generativelanguage')) {
    return;
  }

  // Cache-first for map tiles (they rarely change)
  if (url.includes('cartocdn') || url.includes('opentopomap') || url.includes('tile.openstreetmap')) {
    e.respondWith(
      caches.match(e.request).then(cached => {
        if (cached) return cached;
        return fetch(e.request).then(res => {
          if (res.ok) {
            const clone = res.clone();
            caches.open(CACHE).then(c => c.put(e.request, clone));
          }
          return res;
        }).catch(() => cached);
      })
    );
    return;
  }

  // Cache-first for large data files (bus/metro JS)
  if (url.includes('stop_timings') ||
      url.includes('bus_stops') ||
      url.includes('bus_routes') ||
      url.includes('metro_data') ||
      url.includes('route_schedules') ||
      url.includes('metro_schedules') ||
      url.includes('metro_stop_times') ||
      url.includes('bus_stop_routes')) {
    e.respondWith(
      caches.match(e.request).then(cached => cached || fetch(e.request).then(res => {
        if (res.ok) caches.open(CACHE).then(c => c.put(e.request, res.clone()));
        return res;
      }))
    );
    return;
  }

  // Network-first for everything else (app shell)
  e.respondWith(
    fetch(e.request)
      .then(res => {
        if (res.ok) caches.open(CACHE).then(c => c.put(e.request, res.clone()));
        return res;
      })
      .catch(() => caches.match(e.request).then(cached => cached || caches.match('./index.html')))
  );
});
