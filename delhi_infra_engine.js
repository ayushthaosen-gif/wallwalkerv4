/**
 * GAITWAY — DELHI INFRA ENGINE
 * Street-level infrastructure survey data from PAPL (paplilabs.com), sourced via
 * the Delhi Transport Stack OTD dataset API.
 *
 * Data files required (loaded before this script):
 *   delhi_streetlights.js  → window.DELHI_STREETLIGHTS   (~39.7k survey points, [lat,lng,count])
 *   delhi_subways.js       → window.DELHI_SUBWAYS        (~417 pedestrian underpass points, [lat,lng,count])
 *   delhi_metro_gates.js   → window.DELHI_METRO_GATES    (~529 OSM subway_entrance points, [lat,lng,gateName,stationName,gateNo])
 *   delhi_rrts_stations.js → window.DELHI_RRTS_STATIONS  (16 Delhi-Meerut RRTS stations in corridor order, [lat,lng,name])
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

// ── METRO GATES ──
function metroGatesReady() { return typeof DELHI_METRO_GATES !== 'undefined'; }

function _normStationName(s) {
  return (s || '').toLowerCase()
    .replace(/\(.*?\)/g, '')
    .replace(/metro station|station|metro/gi, '')
    .replace(/[^a-z0-9]/g, '')
    .trim();
}
function _stationNameMatch(a, b) {
  const na = _normStationName(a), nb = _normStationName(b);
  if (!na || !nb) return false;
  return na === nb || na.includes(nb) || nb.includes(na);
}

// Nearest gate to a point, optionally restricted to a given station (fuzzy name match).
// Falls back to null if no gate is close enough — caller should fall back to station center coords.
function getNearestGate(lat, lng, stationName, maxKm = 0.4) {
  if (!metroGatesReady()) return null;
  let best = null, bestDist = Infinity;
  for (let i = 0; i < DELHI_METRO_GATES.length; i++) {
    const [la, lo, gateName, station, gateNo] = DELHI_METRO_GATES[i];
    // If a station filter is requested, the gate must match by its parsed station name or,
    // failing that, by its raw gate name — never accept an unverifiable gate as a match.
    if (stationName && !_stationNameMatch(station || gateName, stationName)) continue;
    const dist = _delhiInfraHav(lat, lng, la, lo);
    if (dist <= maxKm && dist < bestDist) { bestDist = dist; best = { lat: la, lng: lo, gateName, station, gateNo, dist }; }
  }
  return best;
}

// ── RRTS (Delhi-Meerut Namo Bharat) ──
function rrtsDataReady() { return typeof DELHI_RRTS_STATIONS !== 'undefined'; }

function getNearestRrtsStations(lat, lng, n = 3, maxKm = 3.0) {
  if (!rrtsDataReady()) return [];
  return DELHI_RRTS_STATIONS
    .map(([la, lo, name], idx) => ({ lat: la, lng: lo, name, idx, dist: _delhiInfraHav(lat, lng, la, lo) }))
    .filter(p => p.dist <= maxKm)
    .sort((a, b) => a.dist - b.dist)
    .slice(0, n);
}

// Simple nearest-station journey plan along the single RRTS line.
function planRrtsJourney(fromLat, fromLng, toLat, toLng) {
  if (!rrtsDataReady()) return null;
  const nf = getNearestRrtsStations(fromLat, fromLng, 3, 3.0);
  const nt = getNearestRrtsStations(toLat, toLng, 3, 3.0);
  if (!nf.length || !nt.length) return null;
  let best = null;
  for (const f of nf) {
    for (const t of nt) {
      if (f.idx === t.idx) continue;
      if (!best || (f.dist + t.dist) < (best.board.dist + best.alight.dist)) {
        best = { board: f, alight: t, stops: Math.abs(f.idx - t.idx) };
      }
    }
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
  metroGatesReady,
  getNearestGate,
  rrtsDataReady,
  getNearestRrtsStations,
  planRrtsJourney,
};
