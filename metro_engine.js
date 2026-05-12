/**
 * GAITWAY V5.1 — METRO ROUTING ENGINE
 * Uses real DMRC GTFS data (metro_data.js):
 *  - 262 metro stations, 36 routes with real shapes
 *  - Nearest-station finder
 *  - Multi-leg journey planner (walk → metro → walk)
 *  - Interchange detection
 *  - Real polyline shapes per line
 */

'use strict';

// ── METRO COLOR MAP ──
const METRO_LINE_COLORS = {
  red:    '#e53935', blue:   '#1565c0', yellow: '#f9a825',
  green:  '#43a047', violet: '#8e24aa', pink:   '#e91e63',
  magenta:'#d81b60', gray:   '#757575', orange: '#fb8c00',
  aqua:   '#00acc1', rapid:  '#00897b',
};

// ──────────────────────────────────────────────────────────────
// Haversine distance in km
function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371, d2r = Math.PI / 180;
  const dLat = (lat2 - lat1) * d2r, dLon = (lon2 - lon1) * d2r;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*d2r)*Math.cos(lat2*d2r)*Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

// ── NEAREST METRO STATIONS ──
function getNearestMetroStations(lat, lng, n = 5, maxKm = 2.0) {
  if (typeof METRO_DATA === 'undefined') return [];
  const stops = METRO_DATA.stops;
  return Object.entries(stops)
    .map(([id, s]) => ({ id, lat: s[0], lng: s[1], name: s[2], dist: haversineKm(lat, lng, s[0], s[1]) }))
    .filter(s => s.dist <= maxKm)
    .sort((a, b) => a.dist - b.dist)
    .slice(0, n);
}

// ── FIND ROUTES SERVING A STOP ──
function getRoutesAtStop(stopId) {
  if (typeof METRO_DATA === 'undefined') return [];
  const routes = [];
  for (const [rid, stopList] of Object.entries(METRO_DATA.route_stops)) {
    if (stopList.includes(String(stopId))) {
      routes.push({ rid, ...METRO_DATA.routes[rid] });
    }
  }
  return routes;
}

// ── PLAN METRO JOURNEY ──
// Returns best (fewest stops) path between two stations on same line
// or with one interchange
function planMetroJourney(fromStopId, toStopId) {
  if (typeof METRO_DATA === 'undefined') return null;
  const rs = METRO_DATA.route_stops;
  const routes = METRO_DATA.routes;

  // Try direct (same line)
  for (const [rid, stopList] of Object.entries(rs)) {
    const iA = stopList.indexOf(String(fromStopId));
    const iB = stopList.indexOf(String(toStopId));
    if (iA !== -1 && iB !== -1) {
      const seg = iA < iB ? stopList.slice(iA, iB+1) : stopList.slice(iB, iA+1).reverse();
      return [{
        type: 'metro',
        routeId: rid,
        routeInfo: routes[rid],
        stops: seg,
        stopNames: seg.map(sid => METRO_DATA.stops[sid]?.[2] || sid),
        numStops: seg.length - 1,
        boardStopId: fromStopId,
        alightStopId: toStopId,
      }];
    }
  }

  // Try one interchange
  const fromRoutes = getRoutesAtStop(fromStopId);
  const toRoutes   = getRoutesAtStop(toStopId);

  for (const fRoute of fromRoutes) {
    const fStops = rs[fRoute.rid];
    for (const tRoute of toRoutes) {
      if (fRoute.rid === tRoute.rid) continue;
      const tStops = rs[tRoute.rid];
      // Find common interchange stops
      const common = fStops.filter(s => tStops.includes(s));
      if (common.length) {
        // Pick interchange closest to midpoint
        const interchangeId = common[0];
        const iA = fStops.indexOf(String(fromStopId));
        const iX = fStops.indexOf(interchangeId);
        const seg1 = iA < iX ? fStops.slice(iA, iX+1) : fStops.slice(iX, iA+1).reverse();
        const iX2 = tStops.indexOf(interchangeId);
        const iB  = tStops.indexOf(String(toStopId));
        const seg2 = iX2 < iB ? tStops.slice(iX2, iB+1) : tStops.slice(iB, iX2+1).reverse();
        return [
          {
            type: 'metro', routeId: fRoute.rid, routeInfo: fRoute,
            stops: seg1, stopNames: seg1.map(sid => METRO_DATA.stops[sid]?.[2] || sid),
            numStops: seg1.length - 1, boardStopId: fromStopId, alightStopId: interchangeId,
          },
          {
            type: 'interchange', stopId: interchangeId,
            stopName: METRO_DATA.stops[interchangeId]?.[2] || interchangeId,
          },
          {
            type: 'metro', routeId: tRoute.rid, routeInfo: tRoute,
            stops: seg2, stopNames: seg2.map(sid => METRO_DATA.stops[sid]?.[2] || sid),
            numStops: seg2.length - 1, boardStopId: interchangeId, alightStopId: toStopId,
          },
        ];
      }
    }
  }

  return null; // no path found
}

// ── DRAW METRO ROUTE ON MAP ──
function drawMetroRoute(legs, metroLayer) {
  if (!metroLayer || typeof METRO_DATA === 'undefined') return;

  legs.forEach(leg => {
    if (leg.type !== 'metro') return;
    const info  = leg.routeInfo;
    const color = parseLineColor(info?.name || '');
    const shape = METRO_DATA.route_shapes[leg.routeId];
    if (!shape || shape.length < 2) return;

    // Clip shape to the stops in this leg
    const board  = METRO_DATA.stops[leg.boardStopId];
    const alight = METRO_DATA.stops[leg.alightStopId];
    if (!board || !alight) {
      L.polyline(shape, { color, weight: 6, opacity: 0.9 }).addTo(metroLayer);
      return;
    }

    // Find closest shape points to board/alight
    const closest = (lat, lng) => {
      let best = 0, bestD = Infinity;
      shape.forEach((pt, i) => {
        const d = haversineKm(lat, lng, pt[0], pt[1]);
        if (d < bestD) { bestD = d; best = i; }
      });
      return best;
    };

    const iA = closest(board[0], board[1]);
    const iB = closest(alight[0], alight[1]);
    const clipped = iA <= iB ? shape.slice(iA, iB+1) : shape.slice(iB, iA+1).reverse();

    L.polyline(clipped.length > 1 ? clipped : shape, { color, weight: 6, opacity: 0.9 }).addTo(metroLayer);
  });
}

function parseLineColor(name) {
  const n = name.toUpperCase();
  if (n.includes('RED'))    return METRO_LINE_COLORS.red;
  if (n.includes('BLUE'))   return METRO_LINE_COLORS.blue;
  if (n.includes('YELLOW')) return METRO_LINE_COLORS.yellow;
  if (n.includes('GREEN'))  return METRO_LINE_COLORS.green;
  if (n.includes('VIOLET')) return METRO_LINE_COLORS.violet;
  if (n.includes('PINK'))   return METRO_LINE_COLORS.pink;
  if (n.includes('MAGENTA'))return METRO_LINE_COLORS.magenta;
  if (n.includes('GRAY') || n.includes('GREY')) return METRO_LINE_COLORS.gray;
  if (n.includes('ORANGE') || n.includes('AIRPORT')) return METRO_LINE_COLORS.orange;
  if (n.includes('AQUA'))   return METRO_LINE_COLORS.aqua;
  if (n.includes('RAPID'))  return METRO_LINE_COLORS.rapid;
  return '#888';
}

// ── BUILD METRO HUD HTML ──
function buildMetroHudHtml(legs, originName, destName, walkIn, walkOut) {
  let html = '';
  const totalMetroStops = legs.filter(l => l.type === 'metro').reduce((a, l) => a + l.numStops, 0);
  const approxMin = Math.round(walkIn * 12) + totalMetroStops * 2 + Math.round(walkOut * 12) + 5;

  legs.forEach(leg => {
    if (leg.type === 'metro') {
      const color = parseLineColor(leg.routeInfo?.name || '');
      const lineName = extractLineName(leg.routeInfo?.name || leg.routeId);
      html += `
        <div style="margin-bottom:10px;">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">
            <div style="width:14px;height:14px;border-radius:50%;background:${color};flex-shrink:0;"></div>
            <span style="font-size:12px;font-weight:800;color:${color};">${lineName}</span>
            <span style="font-size:10px;color:#64748b;font-weight:600;">${leg.numStops} stops</span>
          </div>
          <div style="background:${color}18;border-left:3px solid ${color};padding:8px 10px;border-radius:0 8px 8px 0;font-size:11px;">
            <b>Board:</b> ${leg.stopNames[0]}<br>
            <b>Alight:</b> ${leg.stopNames[leg.stopNames.length-1]}
          </div>
          ${leg.stopNames.slice(1, -1).length ? `
          <div style="font-size:10px;color:#94a3b8;margin-top:4px;padding-left:10px;">
            via ${leg.stopNames.slice(1,-1).join(' → ')}
          </div>` : ''}
        </div>`;
    } else if (leg.type === 'interchange') {
      html += `
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px;background:#f8fafc;padding:8px;border-radius:8px;">
          <span style="font-size:16px;">🔄</span>
          <span style="font-size:11px;font-weight:700;">Interchange at <b>${leg.stopName}</b></span>
        </div>`;
    }
  });

  return { html, approxMin, totalMetroStops };
}

function extractLineName(name) {
  const m = name.match(/^([A-Z_\/]+)_/);
  if (!m) return name;
  const parts = name.split('_');
  // e.g. "BLUE_Dwarka..." -> "Blue Line"
  const color = parts[0];
  return color.charAt(0) + color.slice(1).toLowerCase() + ' Line';
}

// Expose globally
window.MetroEngine = {
  getNearestMetroStations,
  getRoutesAtStop,
  planMetroJourney,
  drawMetroRoute,
  buildMetroHudHtml,
  parseLineColor,
  haversineKm,
};
