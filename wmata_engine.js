/**
 * GAITWAY — WMATA ENGINE
 * Washington DC Metro + Bus data from official GeoJSON sources
 *
 * Data files required (loaded before this script):
 *   wmata_stations.js      → window.WMATA_STATIONS  (44 metro stations)
 *   wmata_lines.js         → window.WMATA_LINES     (6 metro line polylines)
 *   wmata_bus_stops.js     → window.WMATA_BUS_STOPS (8173 bus stops)
 *   wmata_bus_routes_p1.js → window._WMATA_ROUTES_P1
 *   wmata_bus_routes_p2.js → window._WMATA_ROUTES_P2
 *   wmata_park_ride.js     → window.WMATA_PARK_RIDE (6 P&R lots)
 */
'use strict';

// ── LINE COLORS (WMATA official palette) ──
const WMATA_LINE_COLORS = {
  red:    '#E3222B',
  blue:   '#0D5CA8',
  orange: '#E97F1B',
  green:  '#0C8C44',
  yellow: '#FBBF07',
  silver: '#9DAAB6',
};

// ── HELPERS ──
function wmataHav(la1, lo1, la2, lo2) {
  const R = 6371, r = Math.PI / 180;
  const dL = (la2 - la1) * r, dO = (lo2 - lo1) * r;
  const a = Math.sin(dL/2)**2 + Math.cos(la1*r)*Math.cos(la2*r)*Math.sin(dO/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

function wmataDataReady() {
  return typeof WMATA_STATIONS !== 'undefined' &&
         typeof WMATA_BUS_STOPS !== 'undefined' &&
         typeof WMATA_LINES !== 'undefined';
}

function wmataRoutesReady() {
  return typeof window.WMATA_BUS_ROUTES !== 'undefined';
}

// Merge route chunks once both are loaded
function mergeWmataRoutes() {
  if (typeof window._WMATA_ROUTES_P1 === 'undefined' ||
      typeof window._WMATA_ROUTES_P2 === 'undefined') return;
  if (window.WMATA_BUS_ROUTES) return; // already merged
  window.WMATA_BUS_ROUTES = Object.assign({}, window._WMATA_ROUTES_P1, window._WMATA_ROUTES_P2);
  delete window._WMATA_ROUTES_P1;
  delete window._WMATA_ROUTES_P2;
  console.log(`✅ WMATA routes merged: ${Object.keys(window.WMATA_BUS_ROUTES).length} routes`);
}

// Poll until both chunks loaded
(function pollMerge() {
  if (typeof window._WMATA_ROUTES_P1 !== 'undefined' &&
      typeof window._WMATA_ROUTES_P2 !== 'undefined') {
    mergeWmataRoutes();
  } else {
    setTimeout(pollMerge, 200);
  }
})();

// ── LINE COLOR HELPER ──
function wmataLineColor(lineStr) {
  if (!lineStr) return '#888';
  const first = lineStr.split(',')[0].trim().toLowerCase();
  return WMATA_LINE_COLORS[first] || '#888';
}

// ── NEAREST METRO STATIONS ──
function getNearestWmataStations(lat, lng, n = 5, maxKm = 2.0) {
  if (!wmataDataReady()) return [];
  return Object.entries(WMATA_STATIONS)
    .map(([name, s]) => ({
      id:   name,
      name,
      lat:  s.lat,
      lng:  s.lng,
      line: s.line,
      lines: s.lines,
      addr: s.addr,
      url:  s.url,
      dist: wmataHav(lat, lng, s.lat, s.lng),
    }))
    .filter(s => s.dist <= maxKm)
    .sort((a, b) => a.dist - b.dist)
    .slice(0, n);
}

// ── NEAREST BUS STOPS ──
function getNearestWmataBusStops(lat, lng, n = 6, maxKm = 0.6) {
  if (!wmataDataReady()) return [];
  return Object.entries(WMATA_BUS_STOPS)
    .map(([id, s]) => ({
      id,
      lat:  s[0],
      lng:  s[1],
      name: s[2],
      dist: wmataHav(lat, lng, s[0], s[1]),
    }))
    .filter(s => s.dist <= maxKm)
    .sort((a, b) => a.dist - b.dist)
    .slice(0, n);
}

// ── NEAREST PARK & RIDE ──
function getNearestParkRide(lat, lng, n = 3, maxKm = 5.0) {
  if (typeof WMATA_PARK_RIDE === 'undefined') return [];
  return WMATA_PARK_RIDE
    .map(p => ({ ...p, dist: wmataHav(lat, lng, p.lat, p.lng) }))
    .filter(p => p.dist <= maxKm)
    .sort((a, b) => a.dist - b.dist)
    .slice(0, n);
}

// ── DRAW METRO LINES on a Leaflet layer ──
function drawWmataMetroLines(layer) {
  if (!wmataDataReady() || !layer) return;
  Object.entries(WMATA_LINES).forEach(([lineName, coords]) => {
    const color = WMATA_LINE_COLORS[lineName] || '#888';
    L.polyline(coords, {
      color,
      weight:   5,
      opacity:  0.85,
      lineCap:  'round',
      lineJoin: 'round',
    }).addTo(layer).bindTooltip(
      `<b style="color:${color}">${lineName.charAt(0).toUpperCase()+lineName.slice(1)} Line</b>`,
      { sticky: true, className: 'wmata-line-tip' }
    );
  });
}

// ── DRAW BUS ROUTE SHAPE on a Leaflet layer ──
function drawWmataBusRoute(routeId, layer) {
  if (!wmataRoutesReady() || !layer) return false;
  const variants = WMATA_BUS_ROUTES[routeId];
  if (!variants || !variants.length) return false;
  variants.forEach(v => {
    if (!v.c || v.c.length < 2) return;
    L.polyline(v.c, {
      color:   '#E97F1B',
      weight:  5,
      opacity: 0.85,
      dashArray: '8,5',
    }).addTo(layer).bindTooltip(
      `<b>Route ${routeId}</b><br><small>${v.o} → ${v.t}</small>`,
      { sticky: true }
    );
  });
  return true;
}

// ── METRO STATION POPUP HTML ──
function buildWmataStationPopup(station) {
  const color = wmataLineColor(station.lines);
  const lineLabels = (station.lines || '').split(',').map(l => {
    const lc = l.trim().toLowerCase();
    const c = WMATA_LINE_COLORS[lc] || '#888';
    return `<span style="background:${c};color:${lc==='yellow'?'#333':'white'};font-size:9px;font-weight:800;padding:2px 7px;border-radius:4px;">${l.trim().toUpperCase()}</span>`;
  }).join(' ');

  return `
    <div style="min-width:220px;max-width:280px;">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">
        <div style="width:18px;height:18px;border-radius:50%;background:${color};flex-shrink:0;"></div>
        <b style="font-size:13px;line-height:1.2;">🚇 ${station.name}</b>
      </div>
      <div style="display:flex;gap:4px;flex-wrap:wrap;margin-bottom:8px;">${lineLabels}</div>
      ${station.addr ? `<div style="font-size:11px;color:#64748b;margin-bottom:8px;">📍 ${station.addr}</div>` : ''}
      <div style="display:flex;gap:6px;">
        <button onclick="poiNavigateTo(${station.lat},${station.lng},'${station.name.replace(/'/g,"\\'")}');map.closePopup();"
          style="flex:1;background:#0D5CA8;color:white;border:none;border-radius:8px;padding:7px 8px;font-size:11px;font-weight:800;cursor:pointer;font-family:inherit;">🧭 Navigate Here</button>
        <button onclick="poiSetFrom(${station.lat},${station.lng},'${station.name.replace(/'/g,"\\'")}');map.closePopup();"
          style="flex:1;background:#f1f5f9;border:1px solid #e2e8f0;border-radius:8px;padding:7px 8px;font-size:11px;font-weight:700;cursor:pointer;font-family:inherit;color:#475569;">📍 Start Here</button>
      </div>
      ${station.url ? `<a href="${station.url}" target="_blank" style="display:block;text-align:center;font-size:10px;color:#0D5CA8;margin-top:6px;text-decoration:none;">WMATA Station Info →</a>` : ''}
    </div>`;
}

// ── BUS STOP POPUP HTML ──
function buildWmataBusStopPopup(stop) {
  // Find which routes serve this stop (by proximity to route endpoints)
  let routeInfo = '';
  if (wmataRoutesReady()) {
    const matchingRoutes = [];
    // Check stop name against route origins/destinations
    const nameUpper = stop.name.toUpperCase();
    Object.entries(WMATA_BUS_ROUTES).forEach(([rid, variants]) => {
      variants.forEach(v => {
        if ((v.o||'').toUpperCase().includes(nameUpper.split('+')[0]) ||
            (v.t||'').toUpperCase().includes(nameUpper.split('+')[0])) {
          if (!matchingRoutes.includes(rid)) matchingRoutes.push(rid);
        }
      });
    });
    if (matchingRoutes.length) {
      routeInfo = `<div style="margin-top:6px;font-size:10px;color:#64748b;">Routes: ${
        matchingRoutes.slice(0,6).map(r =>
          `<span style="background:#fff7ed;border:1px solid #fed7aa;color:#c2410c;padding:1px 5px;border-radius:4px;font-weight:700;">${r}</span>`
        ).join(' ')
      }</div>`;
    }
  }

  return `
    <div style="min-width:200px;max-width:260px;">
      <b style="font-size:13px;">🚏 ${stop.name}</b>
      <div style="font-size:10px;color:#94a3b8;margin:3px 0 8px;">Stop ID: ${stop.id} · WMATA Metrobus</div>
      ${routeInfo}
      <div style="display:flex;gap:6px;margin-top:8px;">
        <button onclick="poiNavigateTo(${stop.lat},${stop.lng},'${stop.name.replace(/'/g,"\\'")}');map.closePopup();"
          style="flex:1;background:#E97F1B;color:white;border:none;border-radius:8px;padding:7px 8px;font-size:11px;font-weight:800;cursor:pointer;font-family:inherit;">🧭 Navigate Here</button>
        <button onclick="poiSetFrom(${stop.lat},${stop.lng},'${stop.name.replace(/'/g,"\\'")}');map.closePopup();"
          style="flex:1;background:#f1f5f9;border:1px solid #e2e8f0;border-radius:8px;padding:7px 8px;font-size:11px;font-weight:700;cursor:pointer;font-family:inherit;color:#475569;">📍 Start Here</button>
      </div>
    </div>`;
}

// ── PARK & RIDE POPUP HTML ──
function buildParkRidePopup(lot) {
  return `
    <div style="min-width:200px;">
      <b style="font-size:13px;">🅿️ ${lot.name}</b><br>
      <div style="font-size:11px;color:#64748b;margin:4px 0 8px;">📍 ${lot.addr}</div>
      <div style="display:flex;gap:6px;">
        <button onclick="poiNavigateTo(${lot.lat},${lot.lng},'${lot.name.replace(/'/g,"\\'")} Park & Ride');map.closePopup();"
          style="flex:1;background:#16a34a;color:white;border:none;border-radius:8px;padding:7px 8px;font-size:11px;font-weight:800;cursor:pointer;font-family:inherit;">🧭 Navigate Here</button>
        <button onclick="poiSetFrom(${lot.lat},${lot.lng},'${lot.name.replace(/'/g,"\\'")} Park & Ride');map.closePopup();"
          style="flex:1;background:#f1f5f9;border:1px solid #e2e8f0;border-radius:8px;padding:7px 8px;font-size:11px;font-weight:700;cursor:pointer;font-family:inherit;color:#475569;">📍 Start Here</button>
      </div>
    </div>`;
}

// ── REFRESH WMATA STOPS ON MAP VIEW ──
function refreshWmataOnView(lat, lng, zoom, stationLayer) {
  if (!wmataDataReady() || !stationLayer) return;

  const metroRadius = zoom >= 14 ? 2.5 : 4.0;
  const busRadius   = zoom >= 16 ? 0.3 : zoom >= 15 ? 0.5 : zoom >= 14 ? 0.7 : 0;
  const busCount    = zoom >= 16 ? 12  : zoom >= 15 ? 8   : 5;

  // Metro stations (always show when in DC area)
  getNearestWmataStations(lat, lng, 8, metroRadius).forEach(s => {
    const color = wmataLineColor(s.lines);
    const ico = L.divIcon({
      className: '',
      html: `<div style="background:${color};border:3px solid white;border-radius:6px;padding:3px 7px;font-size:${zoom>=15?'11':'10'}px;font-weight:900;color:${s.line==='yellow'?'#333':'white'};white-space:nowrap;box-shadow:0 2px 8px rgba(0,0,0,.4);">🚇 ${zoom>=15?s.name:s.name.split(' ')[0]}</div>`,
      iconSize: [null, null],
    });
    const marker = L.marker([s.lat, s.lng], { icon: ico, zIndexOffset: 500 }).addTo(stationLayer);
    marker.on('click', e => { e.originalEvent._handled = true; });
    marker.bindPopup(buildWmataStationPopup(s), { maxWidth: 300 });
  });

  // Bus stops (only when zoomed in)
  if (zoom >= 14) {
    getNearestWmataBusStops(lat, lng, busCount, busRadius).forEach(s => {
      const ico = L.divIcon({
        className: '',
        html: `<div style="background:white;border:2px solid #E97F1B;border-radius:50%;width:${zoom>=16?20:16}px;height:${zoom>=16?20:16}px;display:flex;align-items:center;justify-content:center;font-size:10px;box-shadow:0 2px 5px rgba(0,0,0,.25);">🚏</div>`,
        iconSize: [zoom>=16?20:16, zoom>=16?20:16],
        iconAnchor: [zoom>=16?10:8, zoom>=16?10:8],
      });
      const marker = L.marker([s.lat, s.lng], { icon: ico }).addTo(stationLayer);
      marker.on('click', e => { e.originalEvent._handled = true; });
      marker.bindPopup(buildWmataBusStopPopup(s), { maxWidth: 280 });
    });
  }

  // Park & Ride lots (show when zoomed out, good for planning)
  if (zoom >= 12) {
    getNearestParkRide(lat, lng, 3, 8.0).forEach(lot => {
      const ico = L.divIcon({
        className: '',
        html: `<div style="background:#16a34a;border:2px solid white;border-radius:8px;padding:3px 7px;font-size:10px;font-weight:800;color:white;white-space:nowrap;box-shadow:0 2px 6px rgba(0,0,0,.3);">🅿️ ${lot.name}</div>`,
        iconSize: [null, null],
      });
      const marker = L.marker([lot.lat, lot.lng], { icon: ico, zIndexOffset: 200 }).addTo(stationLayer);
      marker.on('click', e => { e.originalEvent._handled = true; });
      marker.bindPopup(buildParkRidePopup(lot), { maxWidth: 260 });
    });
  }
}

// ── METRO ROUTE PLANNER (simple nearest-station plan) ──
function planWmataMetroJourney(fromLat, fromLng, toLat, toLng) {
  if (!wmataDataReady()) return null;
  const fromStations = getNearestWmataStations(fromLat, fromLng, 3, 3.0);
  const toStations   = getNearestWmataStations(toLat, toLng, 3, 3.0);
  if (!fromStations.length || !toStations.length) return null;

  const board  = fromStations[0];
  const alight = toStations[0];
  if (board.id === alight.id) return null;

  // Check if same line (direct)
  const boardLines  = (board.lines  || '').split(',').map(l => l.trim().toLowerCase());
  const alightLines = (alight.lines || '').split(',').map(l => l.trim().toLowerCase());
  const commonLines = boardLines.filter(l => alightLines.includes(l));
  const line = commonLines[0] || boardLines[0];

  return {
    board,
    alight,
    line,
    color:       WMATA_LINE_COLORS[line] || '#888',
    walkInKm:    board.dist,
    walkOutKm:   alight.dist,
    directLine:  commonLines.length > 0,
  };
}

// ── HUD HTML for WMATA Metro ──
function buildWmataMetroHudHtml(plan) {
  if (!plan) return { html: '<div style="font-size:12px;color:#64748b;">No WMATA metro nearby.</div>', approxMin: 30 };

  const { board, alight, line, color, walkInKm, walkOutKm, directLine } = plan;
  const approxMin = Math.round(walkInKm * 12) + 8 + Math.round(walkOutKm * 12) + (directLine ? 0 : 5);
  const lineUC = line.charAt(0).toUpperCase() + line.slice(1);

  const html = `
    <div style="background:white;padding:12px;border-radius:12px;border:1px solid #e2e8f0;margin-bottom:8px;">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px;">
        <div style="background:${color};color:${line==='yellow'?'#333':'white'};font-size:13px;font-weight:900;padding:5px 10px;border-radius:8px;flex-shrink:0;">${lineUC} Line</div>
        <div style="flex:1;">
          <div style="font-size:13px;font-weight:800;">WMATA Metro</div>
          <div style="font-size:10px;color:#64748b;">${directLine ? 'Direct — no transfer needed' : 'May require transfer'}</div>
        </div>
        <div style="text-align:right;flex-shrink:0;">
          <div style="font-size:20px;font-weight:900;color:${color};">~${approxMin}</div>
          <div style="font-size:10px;color:#64748b;">min</div>
        </div>
      </div>
      <div style="border-left:4px solid ${color};padding:8px 10px;background:${color}18;border-radius:0 8px 8px 0;font-size:11px;">
        <div style="margin-bottom:4px;"><b>Board:</b> ${board.name} <span style="color:#94a3b8;">(${(walkInKm*1000).toFixed(0)}m walk)</span></div>
        <div><b>Alight:</b> ${alight.name} <span style="color:#94a3b8;">(${(walkOutKm*1000).toFixed(0)}m to dest)</span></div>
      </div>
    </div>`;
  return { html, approxMin };
}

// ── FIND BUS ROUTE BETWEEN TWO LOCATIONS ──
function findWmataBusRoute(fromLat, fromLng, toLat, toLng) {
  if (!wmataRoutesReady()) return null;
  const fromStops = getNearestWmataBusStops(fromLat, fromLng, 8, 0.8);
  const toStops   = getNearestWmataBusStops(toLat, toLng, 8, 0.8);
  if (!fromStops.length || !toStops.length) return null;

  // Find routes that appear near both origin and destination by coords
  // (simplified — checks if any route variant passes through both bboxes)
  const fromBox = {
    minLat: fromLat - 0.005, maxLat: fromLat + 0.005,
    minLng: fromLng - 0.007, maxLng: fromLng + 0.007,
  };
  const toBox = {
    minLat: toLat - 0.005, maxLat: toLat + 0.005,
    minLng: toLng - 0.007, maxLng: toLng + 0.007,
  };

  const inBox = (pt, box) =>
    pt[0] >= box.minLat && pt[0] <= box.maxLat &&
    pt[1] >= box.minLng && pt[1] <= box.maxLng;

  const matches = [];
  Object.entries(WMATA_BUS_ROUTES).forEach(([rid, variants]) => {
    variants.forEach(v => {
      if (!v.c || v.c.length < 2) return;
      const hitsFrom = v.c.some(pt => inBox(pt, fromBox));
      const hitsTo   = v.c.some(pt => inBox(pt, toBox));
      if (hitsFrom && hitsTo && !matches.find(m => m.routeId === rid)) {
        matches.push({
          routeId:   rid,
          direction: v.d,
          origin:    v.o,
          dest:      v.t,
          boardStop: fromStops[0],
          alightStop: toStops[0],
          coords:    v.c,
        });
      }
    });
  });

  return matches.length ? { type: 'direct', options: matches.slice(0, 4), walkInKm: fromStops[0].dist, walkOutKm: toStops[0].dist } : null;
}

// ── HUD HTML for WMATA Bus ──
function buildWmataBusHudHtml(journey) {
  if (!journey || !journey.options.length) {
    return { html: '<div style="font-size:12px;color:#64748b;">No direct WMATA bus found.</div>', approxMin: 30 };
  }
  const opt = journey.options[0];
  const approxMin = Math.round(journey.walkInKm * 12) + 15 + Math.round(journey.walkOutKm * 12);

  const altHtml = journey.options.length > 1
    ? `<div style="margin-top:6px;font-size:10px;color:#64748b;">Also: ${
        journey.options.slice(1,4).map(o =>
          `<span style="background:#fff7ed;padding:2px 6px;border-radius:4px;font-weight:700;">${o.routeId}</span>`
        ).join(' ')
      }</div>`
    : '';

  const html = `
    <div style="background:white;padding:12px;border-radius:12px;border:1px solid #e2e8f0;margin-bottom:8px;">
      <div style="display:flex;align-items:flex-start;gap:10px;">
        <div style="background:#E97F1B;color:white;font-size:15px;font-weight:900;padding:6px 10px;border-radius:8px;flex-shrink:0;">${opt.routeId}</div>
        <div style="flex:1;">
          <div style="font-size:13px;font-weight:800;">WMATA Metrobus</div>
          <div style="font-size:10px;color:#64748b;margin-top:2px;">🚏 Board: <b>${opt.boardStop.name}</b> (${(journey.walkInKm*1000).toFixed(0)}m)</div>
          <div style="font-size:10px;color:#64748b;">📍 ${opt.origin} → ${opt.dest}</div>
        </div>
        <div style="text-align:right;flex-shrink:0;">
          <div style="font-size:18px;font-weight:900;color:#E97F1B;">~${approxMin}</div>
          <div style="font-size:10px;color:#64748b;">min</div>
        </div>
      </div>
      ${altHtml}
    </div>`;

  return { html, approxMin, routeId: opt.routeId, boardStop: opt.boardStop, alightStop: opt.alightStop, coords: opt.coords };
}

window.WmataEngine = {
  wmataDataReady,
  wmataRoutesReady,
  wmataLineColor,
  getNearestWmataStations,
  getNearestWmataBusStops,
  getNearestParkRide,
  drawWmataMetroLines,
  drawWmataBusRoute,
  refreshWmataOnView,
  planWmataMetroJourney,
  buildWmataMetroHudHtml,
  findWmataBusRoute,
  buildWmataBusHudHtml,
  buildWmataStationPopup,
  buildWmataBusStopPopup,
  WMATA_LINE_COLORS,
};

console.log('✅ WMATA Engine loaded');
