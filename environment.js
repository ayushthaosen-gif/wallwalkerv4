/**
 * GAITWAY — ENVIRONMENT ENGINE (environment.js)
 *
 * Handles:
 *  1. Canopy Cover  — estimated from OpenTopoMap tile brightness + community reports
 *  2. Lighting      — detected via ambient light sensor (if available) + community reports
 *  3. Footpath Type — classified from OSM step names + accelerometer surface AI
 *  4. Combined walkability scoring
 *
 * Exposes: window.Env
 */

'use strict';

// ─────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────

// Canopy density levels (determined by NDVI proxy or community report)
const CANOPY = {
  dense:   { label: 'Dense Canopy',   emoji: '🌳', score: +2, color: '#15803d', desc: 'Good shade — comfortable walk' },
  partial: { label: 'Partial Canopy', emoji: '🌤️', score:  0, color: '#d97706', desc: 'Some shade available' },
  open:    { label: 'Exposed / Open', emoji: '☀️', score: -2, color: '#dc2626', desc: 'No shade — hot in summer' },
  unknown: { label: 'Unknown',        emoji: '❓', score:  0, color: '#94a3b8', desc: 'No canopy data yet' },
};

// Lighting levels
const LIGHTING = {
  good:    { label: 'Well Lit',      emoji: '💡', score: +3, color: '#d97706', desc: 'Safe at night' },
  dim:     { label: 'Dim Lighting',  emoji: '🔦', score: -3, color: '#92400e', desc: 'Exercise caution after dark' },
  none:    { label: 'No Lighting',   emoji: '🌑', score: -5, color: '#1e293b', desc: 'Avoid after dark' },
  unknown: { label: 'Unknown',       emoji: '❓', score:  0, color: '#94a3b8', desc: 'No lighting data' },
  day:     { label: 'Daytime',       emoji: '🌤️', score:  0, color: '#d97706', desc: 'Natural light' },
};

// Footpath types (from OSM instruction parsing + surface AI)
const FOOTPATH_TYPE = {
  footway:    { label: 'Designated Footpath', emoji: '🚶', color: '#2563eb', widthHint: '≥1.5m' },
  pavement:   { label: 'Pavement / Sidewalk', emoji: '🚶', color: '#2563eb', widthHint: '1–2.5m' },
  steps:      { label: 'Steps / Stairs',      emoji: '🪜', color: '#7c3aed', widthHint: 'varies' },
  bridge:     { label: 'Foot Bridge',         emoji: '🌉', color: '#1565c0', widthHint: '1–3m' },
  underpass:  { label: 'Underpass / Subway',  emoji: '🚇', color: '#7c3aed', widthHint: '3–5m' },
  crossing:   { label: 'Pedestrian Crossing', emoji: '🚦', color: '#d97706', widthHint: '3–6m' },
  track:      { label: 'Dirt Track / Path',   emoji: '🥾', color: '#92400e', widthHint: '<1m' },
  service:    { label: 'Service Road',        emoji: '🛣️', color: '#64748b', widthHint: 'varies' },
  unknown:    { label: 'Unknown Surface',     emoji: '❓', color: '#94a3b8', widthHint: '?' },
};

// Surface AI → footpath width bucket
const SURFACE_WIDTH = {
  smooth:  { min: 2.5, label: '≥ 2.5m',   color: '#16a34a' },
  medium:  { min: 1.0, label: '1.0–2.5m', color: '#d97706' },
  rough:   { min: 0,   label: '< 1.0m',   color: '#dc2626' },
  unknown: { min: 0,   label: '?',         color: '#64748b' },
};

// Walkability impact of hazard types
const HAZARD_SCORE_MAP = {
  '🚧 Construction': -8,  '⛔ Closed Gate': -12,  '🚷 No Footpath': -15,
  '🚗 Cars Blocking': -6, '🌊 Waterlogging': -10,  '💡 Good Lighting': +3,
  '🔦 No Lighting': -5,   '🌳 Good Canopy': +2,    '☀️ No Shade': -2,
  '📸': -5,               '🪨': -3,
};

// ─────────────────────────────────────────────────────────────
// STATE
// ─────────────────────────────────────────────────────────────
let _currentCanopy   = 'unknown';
let _currentLighting = 'unknown';
let _lightSensorActive = false;
let _lastLux = null;
let _communityReports = []; // {type, lat, lng, ts}

// ─────────────────────────────────────────────────────────────
// AMBIENT LIGHT SENSOR
// ─────────────────────────────────────────────────────────────
function initLightSensor() {
  if ('AmbientLightSensor' in window) {
    try {
      const sensor = new AmbientLightSensor({ frequency: 0.2 }); // 1 reading per 5s
      sensor.addEventListener('reading', () => {
        _lastLux = sensor.illuminance;
        _lightSensorActive = true;
        _currentLighting = luxToLighting(_lastLux);
        onEnvironmentChanged();
      });
      sensor.addEventListener('error', () => { _lightSensorActive = false; });
      sensor.start();
    } catch (e) { _lightSensorActive = false; }
  }
}

function luxToLighting(lux) {
  if (lux === null || lux === undefined) return 'unknown';
  // Typical ranges: outdoor day >1000, cloudy ~100, indoor 50-500, street lit ~10-50, dark <5
  if (lux > 200) return 'day';      // daylight — not a night concern
  if (lux > 30)  return 'good';     // well-lit street
  if (lux > 5)   return 'dim';      // dim street
  return 'none';                     // dark
}

// ─────────────────────────────────────────────────────────────
// CANOPY ESTIMATION
// Uses: time of day + season + community reports + tree tile overlay
// Full satellite NDVI would need a backend — this is a best-effort client approach
// ─────────────────────────────────────────────────────────────
function estimateCanopyFromReports(lat, lng, radiusKm = 0.3) {
  if (!_communityReports.length) return 'unknown';

  const nearby = _communityReports.filter(r => {
    const d = haversineKm(lat, lng, r.lat, r.lng);
    return d <= radiusKm && (Date.now() - r.ts) < 7 * 24 * 3600 * 1000; // last 7 days
  });

  const goodCanopy = nearby.filter(r => r.type.includes('Good Canopy')).length;
  const noShade    = nearby.filter(r => r.type.includes('No Shade') || r.type.includes('Exposed')).length;

  if (goodCanopy > noShade) return 'dense';
  if (noShade > goodCanopy) return 'open';
  if (nearby.length > 0)    return 'partial';
  return 'unknown';
}

function estimateLightingFromReports(lat, lng, radiusKm = 0.3) {
  const nearby = _communityReports.filter(r => {
    const d = haversineKm(lat, lng, r.lat, r.lng);
    return d <= radiusKm && (Date.now() - r.ts) < 3 * 24 * 3600 * 1000;
  });
  const good = nearby.filter(r => r.type.includes('Good Lighting')).length;
  const bad  = nearby.filter(r => r.type.includes('No Lighting') || r.type.includes('Dim')).length;
  if (good > bad) return 'good';
  if (bad > good) return 'none';
  return null; // no data
}

function isNightTime() {
  const h = new Date().getHours();
  return h < 6 || h > 20;
}

// ─────────────────────────────────────────────────────────────
// FOOTPATH TYPE CLASSIFIER
// Parses OSM step instruction strings to classify footpath type
// ─────────────────────────────────────────────────────────────
function classifyFootpathFromInstruction(instruction, surfaceClass) {
  const low = (instruction || '').toLowerCase();

  if (low.includes('step') || low.includes('stair'))          return 'steps';
  if (low.includes('bridge') || low.includes('flyover'))      return 'bridge';
  if (low.includes('underpass') || low.includes('subway'))    return 'underpass';
  if (low.includes('cross') || low.includes('intersection'))  return 'crossing';
  if (low.includes('footway') || low.includes('footpath'))    return 'footway';
  if (low.includes('pavement') || low.includes('sidewalk'))   return 'pavement';
  if (low.includes('track') || low.includes('path'))          return 'track';
  if (low.includes('service'))                                 return 'service';

  // Fall back to surface AI result
  if (surfaceClass === 'rough')  return 'track';
  if (surfaceClass === 'smooth') return 'footway';
  if (surfaceClass === 'medium') return 'pavement';
  return 'unknown';
}

// ─────────────────────────────────────────────────────────────
// SURFACE AI (3-axis accelerometer)
// ─────────────────────────────────────────────────────────────
function analyzeSurface(arrZ, arrX, arrY) {
  if (!arrZ || arrZ.length < 30) return null;

  const mean = v => v.reduce((a, b) => a + b, 0) / v.length;
  const variance = v => { const m = mean(v); return v.reduce((a, b) => a + (b-m)**2, 0) / v.length; };

  const varZ = variance(arrZ);
  const varX = arrX && arrX.length ? variance(arrX) : 0;
  const varY = arrY && arrY.length ? variance(arrY) : 0;
  const totalVar = varZ + varX * 0.3 + varY * 0.3;

  const jerk = arrZ.slice(1).map((v, i) => Math.abs(v - arrZ[i]));
  const meanJerk = mean(jerk);

  // Peak spacing regularity (cadence)
  const peaks = [];
  for (let i = 1; i < arrZ.length - 1; i++) {
    if (arrZ[i] > arrZ[i-1] && arrZ[i] > arrZ[i+1] && arrZ[i] > 10.5) peaks.push(i);
  }
  const peakGaps = peaks.slice(1).map((p, i) => p - peaks[i]);
  const peakRegularity = peakGaps.length > 2 ? variance(peakGaps) : 999;

  let surface, quality, surfaceClass, footpathType;

  if (totalVar < 1.8 && meanJerk < 0.8) {
    surface = 'Smooth Asphalt'; quality = 'Good'; surfaceClass = 'smooth';
  } else if (totalVar < 4.5 && meanJerk < 1.5) {
    surface = 'Cement / Paver Blocks'; quality = 'Fair'; surfaceClass = 'medium';
  } else if (totalVar < 9 && meanJerk < 2.5) {
    surface = 'Broken Pavement'; quality = 'Poor'; surfaceClass = 'rough';
  } else if (totalVar >= 9 || meanJerk >= 2.5) {
    surface = 'Dirt / Rubble'; quality = 'Very Poor'; surfaceClass = 'rough';
  } else {
    surface = 'Unknown'; quality = 'Unknown'; surfaceClass = 'unknown';
  }

  footpathType = classifyFootpathFromInstruction('', surfaceClass);
  const fw = SURFACE_WIDTH[surfaceClass];
  const ft = FOOTPATH_TYPE[footpathType];
  const confidence = Math.min(99, Math.round(60 + (arrZ.length / 60) * 20 + (peakRegularity < 50 ? 15 : 0)));

  return {
    surface, quality, surfaceClass, footpathType,
    width: fw.label, widthColor: fw.color,
    footpathLabel: ft.label, footpathEmoji: ft.emoji, footpathColor: ft.color,
    confidence,
    rawVar: totalVar.toFixed(2), rawJerk: meanJerk.toFixed(2),
  };
}

// ─────────────────────────────────────────────────────────────
// WALKABILITY SCORE CALCULATOR
// ─────────────────────────────────────────────────────────────
function computeWalkabilityScore(base, hazards, surfaceResult, lat, lng) {
  let score = base;

  // Hazard penalties
  hazards.forEach(h => {
    const pen = HAZARD_SCORE_MAP[h.type] || -5;
    score += pen;
  });

  // Surface penalty
  if (surfaceResult) {
    if (surfaceResult.surfaceClass === 'rough')  score -= 8;
    if (surfaceResult.surfaceClass === 'medium') score -= 2;
  }

  // Canopy bonus/penalty
  const canopy = estimateCanopyFromReports(lat, lng);
  score += CANOPY[canopy]?.score || 0;

  // Lighting bonus/penalty
  const reportedLight = estimateLightingFromReports(lat, lng);
  const effectiveLighting = isNightTime() ? (reportedLight || _currentLighting) : 'day';
  score += LIGHTING[effectiveLighting]?.score || 0;

  return Math.max(0, Math.min(100, Math.round(score)));
}

// ─────────────────────────────────────────────────────────────
// SURFACE READOUT HTML
// Called from app.js whenever new surface data arrives
// ─────────────────────────────────────────────────────────────
function buildSurfaceReadoutHtml(surfaceResult, lat, lng) {
  const canopyKey   = estimateCanopyFromReports(lat, lng);
  const canopyInfo  = CANOPY[canopyKey];

  let lightKey;
  if (_lightSensorActive && _lastLux !== null) {
    lightKey = _currentLighting;
  } else {
    const rep = estimateLightingFromReports(lat, lng);
    lightKey = rep || (isNightTime() ? 'dim' : 'day');
  }
  const lightInfo = LIGHTING[lightKey];

  const fw  = surfaceResult ? SURFACE_WIDTH[surfaceResult.surfaceClass] : SURFACE_WIDTH.unknown;
  const ft  = surfaceResult ? FOOTPATH_TYPE[surfaceResult.footpathType] : FOOTPATH_TYPE.unknown;
  const srf = surfaceResult ? surfaceResult.surface : 'Analysing…';
  const conf = surfaceResult ? surfaceResult.confidence + '%' : '';

  return `
    <div style="display:flex;gap:6px;flex-wrap:wrap;">
      <div style="flex:1;min-width:100px;">
        <div style="font-size:9px;font-weight:800;color:#94a3b8;text-transform:uppercase;letter-spacing:.5px;margin-bottom:3px;">Surface</div>
        <div style="display:flex;align-items:center;gap:5px;">
          <div style="width:8px;height:8px;border-radius:50%;background:${fw.color};flex-shrink:0;"></div>
          <span style="font-size:12px;font-weight:800;color:${fw.color};">${srf}</span>
          ${conf ? `<span style="font-size:10px;color:#94a3b8;">${conf}</span>` : ''}
        </div>
        <div style="font-size:10px;color:${fw.color};font-weight:700;margin-top:2px;">${ft.emoji} ${ft.label} · ${fw.label}</div>
      </div>
      <div style="display:flex;gap:8px;">
        <div style="text-align:center;">
          <div style="font-size:9px;font-weight:800;color:#94a3b8;text-transform:uppercase;margin-bottom:3px;">Canopy</div>
          <div style="font-size:18px;">${canopyInfo.emoji}</div>
          <div style="font-size:9px;font-weight:700;color:${canopyInfo.color};">${canopyKey}</div>
        </div>
        <div style="text-align:center;">
          <div style="font-size:9px;font-weight:800;color:#94a3b8;text-transform:uppercase;margin-bottom:3px;">Lights</div>
          <div style="font-size:18px;">${lightInfo.emoji}</div>
          <div style="font-size:9px;font-weight:700;color:${lightInfo.color};">${isNightTime() ? 'Night' : 'Day'}</div>
        </div>
      </div>
    </div>`;
}

// ─────────────────────────────────────────────────────────────
// COMMUNITY REPORT INTEGRATION
// ─────────────────────────────────────────────────────────────
function addEnvironmentReport(type, lat, lng) {
  _communityReports.push({ type, lat, lng, ts: Date.now() });
  // Update lighting/canopy state
  const lightUpdate = estimateLightingFromReports(lat, lng);
  if (lightUpdate) _currentLighting = lightUpdate;
  const canopyUpdate = estimateCanopyFromReports(lat, lng);
  _currentCanopy = canopyUpdate;
  onEnvironmentChanged();
}

function onEnvironmentChanged() {
  // Trigger UI update if app.js has registered a callback
  if (typeof window._onEnvUpdate === 'function') window._onEnvUpdate();
}

// ─────────────────────────────────────────────────────────────
// FOOTPATH INSTRUCTION ENRICHER
// Adds footpath type to each step for the itinerary HUD
// ─────────────────────────────────────────────────────────────
function enrichStep(instruction, surfaceClass) {
  const typeKey = classifyFootpathFromInstruction(instruction, surfaceClass || 'unknown');
  const ft = FOOTPATH_TYPE[typeKey];
  return { typeKey, emoji: ft.emoji, label: ft.label, color: ft.color };
}

// ─────────────────────────────────────────────────────────────
// UTIL
// ─────────────────────────────────────────────────────────────
function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371, r = Math.PI / 180;
  const dL = (lat2-lat1)*r, dO = (lon2-lon1)*r;
  const a = Math.sin(dL/2)**2 + Math.cos(lat1*r)*Math.cos(lat2*r)*Math.sin(dO/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

// ─────────────────────────────────────────────────────────────
// INIT
// ─────────────────────────────────────────────────────────────
function initEnv() {
  initLightSensor();
  // Set initial lighting based on time of day
  _currentLighting = isNightTime() ? 'dim' : 'day';
}

// ─────────────────────────────────────────────────────────────
// PUBLIC API
// ─────────────────────────────────────────────────────────────
window.Env = {
  init: initEnv,
  analyzeSurface,
  buildSurfaceReadoutHtml,
  computeWalkabilityScore,
  addEnvironmentReport,
  enrichStep,
  classifyFootpathFromInstruction,
  isNightTime,
  CANOPY, LIGHTING, FOOTPATH_TYPE, SURFACE_WIDTH, HAZARD_SCORE_MAP,
  getCanopy:   () => _currentCanopy,
  getLighting: () => _currentLighting,
  getLux:      () => _lastLux,
  getReports:  () => _communityReports,
};
