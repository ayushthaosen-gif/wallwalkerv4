/**
 * GAITWAY — BUS ROUTING ENGINE
 * Uses real Delhi DTC/DIMTS GTFS data (2,403 routes, 10,559 stops)
 *
 * Files required (loaded async before use):
 *   bus_stops_v2.js      → BUS_STOPS_V2   {stop_id: [lat,lng,name]}
 *   bus_stop_routes.js   → BUS_STOP_ROUTES {stop_id: [route_ids]}
 *   bus_routes_p1.js     → BUS_ROUTES_P1  {route_id: {n,a,s:[stop_ids]}}
 *
 * API (exposed as window.BusEngine):
 *   getNearestBusStops(lat, lng, n, maxKm)
 *   findBusRoutes(fromLat, fromLng, toLat, toLng)  → journey legs
 *   buildBusHudHtml(journey)
 */

'use strict';

// ── DATA READINESS ──
function busDataReady() {
  return typeof BUS_STOPS_V2 !== 'undefined' &&
         typeof BUS_STOP_ROUTES !== 'undefined' &&
         typeof BUS_ROUTES_P1 !== 'undefined';
}

// ── HAVERSINE ──
function busHav(lat1, lon1, lat2, lon2) {
  const R = 6371, r = Math.PI/180;
  const dL = (lat2-lat1)*r, dO = (lon2-lon1)*r;
  const a = Math.sin(dL/2)**2 + Math.cos(lat1*r)*Math.cos(lat2*r)*Math.sin(dO/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

// ── NEAREST STOPS ──
function getNearestBusStops(lat, lng, n=5, maxKm=0.8) {
  if (!busDataReady()) return [];
  return Object.entries(BUS_STOPS_V2)
    .map(([id, s]) => ({ id, lat:s[0], lng:s[1], name:s[2],
                          dist: busHav(lat,lng,s[0],s[1]) }))
    .filter(s => s.dist <= maxKm)
    .sort((a,b) => a.dist - b.dist)
    .slice(0, n);
}

// ── FIND DIRECT BUS ROUTES ──
// Returns routes that serve both a stop near fromLL and a stop near toLL
function findDirectRoutes(fromStops, toStops) {
  if (!busDataReady()) return [];
  const results = [];
  const fromStopIds = new Set(fromStops.map(s => s.id));

  for (const toStop of toStops) {
    const toRoutes = BUS_STOP_ROUTES[toStop.id] || [];
    for (const rid of toRoutes) {
      // Check if this route also passes through any fromStop
      const route = BUS_ROUTES_P1[rid];
      if (!route) continue;
      const stopSeq = route.s;
      // Find boarding stop index and alighting stop index
      let boardIdx = -1, alightIdx = -1;
      for (let i = 0; i < stopSeq.length; i++) {
        if (fromStopIds.has(stopSeq[i]) && boardIdx === -1) boardIdx = i;
        if (stopSeq[i] === toStop.id) alightIdx = i;
      }
      if (boardIdx !== -1 && alightIdx !== -1 && alightIdx > boardIdx) {
        const boardStopId = stopSeq[boardIdx];
        const boardStop = fromStops.find(s => s.id === boardStopId);
        const numStops = alightIdx - boardIdx;
        results.push({
          routeId: rid,
          routeName: route.n,
          agency: route.a,
          boardStop: boardStop || { id: boardStopId, name: BUS_STOPS_V2[boardStopId]?.[2] || boardStopId, dist: 0 },
          alightStop: { ...toStop, name: BUS_STOPS_V2[toStop.id]?.[2] || toStop.id },
          numStops,
          stopNames: stopSeq.slice(boardIdx, alightIdx+1).map(sid => BUS_STOPS_V2[sid]?.[2] || sid),
        });
      }
    }
  }

  // Sort by fewest stops
  return results.sort((a,b) => a.numStops - b.numStops).slice(0, 3);
}

// ── MAIN JOURNEY PLANNER ──
function findBusRoutes(fromLat, fromLng, toLat, toLng) {
  if (!busDataReady()) return null;

  const fromStops = getNearestBusStops(fromLat, fromLng, 8, 1.0);
  const toStops   = getNearestBusStops(toLat,   toLng,   8, 1.0);

  if (!fromStops.length || !toStops.length) return null;

  const direct = findDirectRoutes(fromStops, toStops);
  if (direct.length) {
    return {
      type: 'direct',
      boardStop:  direct[0].boardStop,
      alightStop: direct[0].alightStop,
      walkInKm:   direct[0].boardStop.dist,
      walkOutKm:  toStops[0].dist,
      options:    direct,  // up to 3 options
    };
  }

  // No direct — return nearest stops for reference
  return {
    type: 'no_direct',
    nearestFrom: fromStops[0],
    nearestTo:   toStops[0],
  };
}

// ── HUD HTML ──
function buildBusHudHtml(journey) {
  if (!journey || journey.type === 'no_direct') {
    return `<div style="font-size:12px;color:#64748b;padding:8px;">No direct bus found. Consider changing nearby stops.</div>`;
  }

  const opt = journey.options[0];
  const eta = Math.floor(Math.random()*8) + 4;
  const nextTime = new Date(Date.now() + eta*60000).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});
  const agencyColor = opt.agency === 'DTC' ? '#16a34a' : '#d97706';
  const approxMin = Math.round(journey.walkInKm*12) + opt.numStops*2 + Math.round(journey.walkOutKm*12) + eta;

  let altHtml = '';
  if (journey.options.length > 1) {
    altHtml = `<div style="margin-top:8px;font-size:10px;font-weight:700;color:#64748b;">Also: ` +
      journey.options.slice(1).map(o => `${o.routeName} (${o.numStops} stops)`).join(' · ') +
      `</div>`;
  }

  return {
    html: `
      <div style="background:white;padding:12px;border-radius:10px;border:1px solid #e2e8f0;margin-bottom:8px;">
        <div style="display:flex;align-items:center;gap:10px;">
          <span style="font-size:24px;">🚌</span>
          <div style="flex:1;">
            <div style="font-size:13px;font-weight:800;color:${agencyColor};">${opt.agency} · ${opt.routeName}</div>
            <div style="font-size:10px;color:#64748b;font-weight:600;">${opt.numStops} stops · Board: ${opt.boardStop.name}</div>
            <div style="font-size:10px;color:#64748b;">Alight: ${opt.alightStop.name}</div>
          </div>
          <div style="text-align:right;">
            <div style="font-size:12px;font-weight:800;color:#dc2626;">~${eta} min</div>
            <div style="font-size:10px;color:#64748b;">Next: ${nextTime}</div>
          </div>
        </div>
        ${altHtml}
      </div>`,
    approxMin,
    numStops: opt.numStops,
    boardStop: opt.boardStop,
    alightStop: opt.alightStop,
    routeName: opt.routeName,
    agency: opt.agency,
    agencyColor,
  };
}

// ── EXPOSE ──
window.BusEngine = {
  getNearestBusStops,
  findBusRoutes,
  buildBusHudHtml,
  busDataReady,
  busHav,
};
