/**
 * GAITWAY — DELHI INFRA ENGINE
 * Street-level infrastructure survey data from PAPL (paplilabs.com), sourced via
 * the Delhi Transport Stack OTD dataset API.
 *
 * Data files required (loaded before this script):
 *   delhi_streetlights.js → window.DELHI_STREETLIGHTS  (~39.7k survey points, [lat,lng,count])
 *   delhi_subways.js      → window.DELHI_SUBWAYS       (~417 pedestrian underpass points, [lat,lng,count])
 */
'use strict';

function _delhiInfraHav(la1, lo1, la2, lo2) {
  const R = 6371, r = Math.PI / 180;
  const dL = (la2 - la1) * r, dO = (lo2 - lo1) * r;
  const a = Math.sin(dL/2)**2 + Math.cos(la1*r)*Math.cos(la2*r)*Math.sin(dO/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

function delhiStreetlightsReady() { return typeof DELHI_STREETLIGHTS !== 'undefined'; }
function delhiSubwaysReady()      { return typeof DELHI_SUBWAYS      !== 'undefined'; }

// ── STREETLIGHTS (returns raw [lat,lng,count] points — used for heatmap weighting) ──
function getStreetlightsInView(swLat, swLng, neLat, neLng, cap = 4000) {
  if (!delhiStreetlightsReady()) return [];
  const out = [];
  for (let i = 0; i < DELHI_STREETLIGHTS.length && out.length < cap; i++) {
    const [lat, lng, cnt] = DELHI_STREETLIGHTS[i];
    if (lat >= swLat && lat <= neLat && lng >= swLng && lng <= neLng) out.push([lat, lng, cnt]);
  }
  return out;
}

// ── NEAREST STREETLIGHT SURVEY POINTS (used for route/point lighting lookups) ──
function getNearestStreetlights(lat, lng, n = 20, maxKm = 0.3) {
  if (!delhiStreetlightsReady()) return [];
  return DELHI_STREETLIGHTS
    .map(([la, lo, cnt]) => ({ lat: la, lng: lo, count: cnt, dist: _delhiInfraHav(lat, lng, la, lo) }))
    .filter(p => p.dist <= maxKm)
    .sort((a, b) => a.dist - b.dist)
    .slice(0, n);
}

// ── NEAREST PEDESTRIAN UNDERPASSES ──
function getNearestSubways(lat, lng, n = 5, maxKm = 1.5) {
  if (!delhiSubwaysReady()) return [];
  return DELHI_SUBWAYS
    .map(([la, lo, cnt]) => ({ lat: la, lng: lo, count: cnt, dist: _delhiInfraHav(lat, lng, la, lo) }))
    .filter(p => p.dist <= maxKm)
    .sort((a, b) => a.dist - b.dist)
    .slice(0, n);
}

// Cheap presence check — no sort/slice, early-exits on first match.
// Used for per-route-step lighting sampling where only yes/no matters.
function isLitPoint(lat, lng, maxKm = 0.08) {
  if (!delhiStreetlightsReady()) return false;
  for (let i = 0; i < DELHI_STREETLIGHTS.length; i++) {
    const [la, lo] = DELHI_STREETLIGHTS[i];
    if (Math.abs(la - lat) > 0.002 || Math.abs(lo - lng) > 0.002) continue; // cheap bbox pre-filter (~200m)
    if (_delhiInfraHav(lat, lng, la, lo) <= maxKm) return true;
  }
  return false;
}

// Closest single underpass within range, or null — no sort needed.
function nearestSubway(lat, lng, maxKm = 0.1) {
  if (!delhiSubwaysReady()) return null;
  let best = null, bestDist = Infinity;
  for (let i = 0; i < DELHI_SUBWAYS.length; i++) {
    const [la, lo, cnt] = DELHI_SUBWAYS[i];
    const dist = _delhiInfraHav(lat, lng, la, lo);
    if (dist <= maxKm && dist < bestDist) { bestDist = dist; best = { lat: la, lng: lo, count: cnt, dist }; }
  }
  return best;
}

window.DelhiInfraEngine = {
  delhiStreetlightsReady,
  delhiSubwaysReady,
  getStreetlightsInView,
  getNearestStreetlights,
  getNearestSubways,
  isLitPoint,
  nearestSubway,
};
