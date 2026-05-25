/**
 * GAITWAY — BUS ENGINE v2
 * - Real route numbers from GTFS
 * - Next departure times from /api/transit/stop/:id
 * - Stop info panel showing all buses at a stop
 */
'use strict';

const API_BASE = window.location.hostname === 'localhost' ? 'http://localhost:3000' : '';

function busHav(la1,lo1,la2,lo2){
  const R=6371,r=Math.PI/180,dL=(la2-la1)*r,dO=(lo2-lo1)*r;
  const a=Math.sin(dL/2)**2+Math.cos(la1*r)*Math.cos(la2*r)*Math.sin(dO/2)**2;
  return R*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a));
}
function busDataReady(){return typeof BUS_STOPS_V2!=='undefined'&&typeof BUS_STOP_ROUTES!=='undefined'&&typeof BUS_ROUTES_P1!=='undefined';}

// ── NEAREST STOPS ──
function getNearestBusStops(lat,lng,n=5,maxKm=0.8){
  if(!busDataReady())return[];
  return Object.entries(BUS_STOPS_V2)
    .map(([id,s])=>({id,lat:s[0],lng:s[1],name:s[2],dist:busHav(lat,lng,s[0],s[1])}))
    .filter(s=>s.dist<=maxKm).sort((a,b)=>a.dist-b.dist).slice(0,n);
}

// ── DIRECT ROUTE FINDER ──
function findDirectRoutes(fromStops,toStops){
  if(!busDataReady())return[];
  const results=[];
  const fromIds=new Set(fromStops.map(s=>s.id));
  for(const toStop of toStops){
    const toRoutes=BUS_STOP_ROUTES[toStop.id]||[];
    for(const rid of toRoutes){
      const route=BUS_ROUTES_P1[rid]; if(!route)continue;
      const seq=route.s;
      let boardIdx=-1,alightIdx=-1;
      for(let i=0;i<seq.length;i++){
        if(fromIds.has(seq[i])&&boardIdx===-1)boardIdx=i;
        if(seq[i]===toStop.id)alightIdx=i;
      }
      if(boardIdx!==-1&&alightIdx!==-1&&alightIdx>boardIdx){
        const boardStopId=seq[boardIdx];
        const boardStop=fromStops.find(s=>s.id===boardStopId)||{id:boardStopId,name:BUS_STOPS_V2[boardStopId]?.[2]||boardStopId,dist:0};
        results.push({
          routeId:rid,
          routeName:route.n,    // e.g. "828AUP"
          agency:route.a,
          boardStop,
          alightStop:{...toStop,name:BUS_STOPS_V2[toStop.id]?.[2]||toStop.id},
          numStops:alightIdx-boardIdx,
          stopNames:seq.slice(boardIdx,alightIdx+1).map(sid=>BUS_STOPS_V2[sid]?.[2]||sid),
        });
      }
    }
  }
  return results.sort((a,b)=>a.numStops-b.numStops).slice(0,5);
}

// ── MAIN PLANNER ──
function findBusRoutes(fromLat,fromLng,toLat,toLng){
  if(!busDataReady())return null;
  const fromStops=getNearestBusStops(fromLat,fromLng,8,1.0);
  const toStops=getNearestBusStops(toLat,toLng,8,1.0);
  if(!fromStops.length||!toStops.length)return null;
  const direct=findDirectRoutes(fromStops,toStops);
  return direct.length
    ? { type:'direct', options:direct, walkInKm:direct[0].boardStop.dist, walkOutKm:toStops[0].dist }
    : { type:'no_direct', nearestFrom:fromStops[0], nearestTo:toStops[0] };
}

// ── GET TIMINGS — reads from client-side JS chunks first, API fallback ──
function getStopTimingsSync(stopId, type='bus') {
  const timeMap  = type==='metro' ? window.METRO_STOP_TIMES : window.BUS_STOP_TIMES;
  const schedMap = type==='metro' ? window.METRO_SCHED      : window.BUS_ROUTE_SCHED;
  if (!timeMap || !timeMap[stopId]) return null;

  const now = new Date();
  const cur = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;

  const services = Object.entries(timeMap[stopId]).map(([rid, times]) => {
    const info  = schedMap?.[rid] || {};
    const upcoming = times.filter(t => t >= cur);
    const nextTimes = upcoming.length >= 3 ? upcoming.slice(0,5)
                    : [...upcoming, ...times.slice(0, 5-upcoming.length)];
    return {
      routeId:   rid,
      routeName: info.n || rid,
      agency:    info.a || (type==='metro'?'DMRC':'DTC'),
      color:     info.color || (type==='metro'?'#1565c0':'#d97706'),
      nextTimes,
      allTimes:  times,
    };
  }).sort((a,b) => (a.nextTimes[0]||'99:99').localeCompare(b.nextTimes[0]||'99:99'));

  return { stopId, type, serviceCount: services.length, services };
}

async function getStopTimings(stopId, type='bus') {
  // Try client-side data first (loaded from static JS chunks)
  const local = getStopTimingsSync(stopId, type);
  if (local && local.serviceCount > 0) return local;
  // Fallback to server API (works if server has JSON files loaded)
  try {
    const res = await fetch(`${API_BASE}/api/transit/stop/${stopId}?type=${type}`);
    const data = await res.json();
    if (data && data.serviceCount > 0) return data;
  } catch(e) {}
  return local || null;
}

// ── BUILD BUS HUD HTML (with route numbers + timings) ──
async function buildBusHudHtml(journey){
  if(!journey||journey.type==='no_direct'){
    return { html:`<div style="font-size:12px;color:#64748b;padding:8px;">No direct bus found nearby.</div>`, approxMin:30 };
  }

  const opt = journey.options[0];
  const agencyColor = opt.agency==='DTC'?'#16a34a':'#d97706';

  // Fetch real next departures from server
  let nextTimes = [];
  let allOptions = journey.options.slice(0,3);
  const timingData = await getStopTimings(opt.boardStop.id, 'bus');

  if(timingData && timingData.services){
    // Find our route in the timing data
    const ourService = timingData.services.find(s=>s.routeId===opt.routeId);
    if(ourService) nextTimes = ourService.nextTimes || [];
  }

  const now = new Date();
  const curTime = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
  const nextBus = nextTimes[0] || '--:--';

  // Minutes until next bus
  let minsUntil = '--';
  if(nextTimes[0]){
    const [h,m] = nextTimes[0].split(':').map(Number);
    const busMin = h*60+m;
    const nowMin = now.getHours()*60+now.getMinutes();
    minsUntil = Math.max(0, busMin-nowMin);
  }

  const approxMin = (typeof minsUntil==='number'?minsUntil:5) + opt.numStops*2 + Math.round(journey.walkOutKm*12) + 3;

  // All routes at the board stop
  let allRoutesHtml = '';
  if(timingData && timingData.services && timingData.services.length > 0){
    const others = timingData.services.filter(s=>s.routeId!==opt.routeId).slice(0,4);
    if(others.length){
      allRoutesHtml = `
        <div style="margin-top:8px;padding:8px;background:#f8fafc;border-radius:8px;">
          <div style="font-size:9px;font-weight:800;text-transform:uppercase;color:#94a3b8;margin-bottom:6px;">Other buses at ${opt.boardStop.name}</div>
          ${others.map(s=>`
            <div style="display:flex;align-items:center;gap:6px;padding:4px 0;border-bottom:1px solid rgba(0,0,0,.04);">
              <div style="background:${s.color||'#d97706'};color:white;font-size:9px;font-weight:800;padding:2px 6px;border-radius:4px;flex-shrink:0;">${s.routeName}</div>
              <span style="font-size:11px;color:#64748b;flex:1;">${s.agency}</span>
              <span style="font-size:11px;font-weight:800;color:#2563eb;">${s.nextTimes[0]||'--'}</span>
            </div>`).join('')}
        </div>`;
    }
  }

  // Alternative bus options
  const altHtml = allOptions.length > 1
    ? `<div style="margin-top:8px;font-size:10px;color:#64748b;font-weight:700;">
        Also: ${allOptions.slice(1).map(o=>`<span style="background:#f1f5f9;padding:2px 6px;border-radius:4px;margin-right:4px;">${o.routeName}</span>`).join('')}
       </div>`
    : '';

  const html = `
    <div style="background:white;padding:12px;border-radius:12px;border:1px solid #e2e8f0;margin-bottom:8px;">
      <div style="display:flex;align-items:flex-start;gap:10px;">
        <div style="background:${agencyColor};color:white;font-size:15px;font-weight:900;padding:6px 10px;border-radius:8px;flex-shrink:0;letter-spacing:.5px;">${opt.routeName}</div>
        <div style="flex:1;">
          <div style="font-size:13px;font-weight:800;color:#0f172a;">${opt.agency} Bus</div>
          <div style="font-size:10px;color:#64748b;margin-top:2px;">🚏 Board: <b>${opt.boardStop.name}</b> (${(journey.walkInKm*1000).toFixed(0)}m walk)</div>
          <div style="font-size:10px;color:#64748b;">🚏 Alight: <b>${opt.alightStop.name}</b> · ${opt.numStops} stops</div>
        </div>
        <div style="text-align:right;flex-shrink:0;">
          <div style="font-size:20px;font-weight:900;color:${typeof minsUntil==='number'&&minsUntil<5?'#dc2626':'#2563eb'};">${typeof minsUntil==='number'?minsUntil+' min':'--'}</div>
          <div style="font-size:10px;color:#64748b;">next bus</div>
        </div>
      </div>
      <div style="margin-top:8px;display:flex;gap:4px;flex-wrap:wrap;">
        ${nextTimes.slice(0,5).map((t,i)=>`<span style="background:${i===0?'#2563eb':'#f1f5f9'};color:${i===0?'white':'#475569'};font-size:11px;font-weight:700;padding:3px 8px;border-radius:6px;">${t}</span>`).join('')}
        ${nextTimes.length===0?'<span style="font-size:11px;color:#94a3b8;">Loading times…</span>':''}
      </div>
      ${altHtml}
      ${allRoutesHtml}
    </div>`;

  return { html, approxMin, numStops:opt.numStops, boardStop:opt.boardStop, alightStop:opt.alightStop, routeName:opt.routeName, agency:opt.agency, agencyColor, nextTimes };
}

// ── STOP INFO POPUP (tap a bus stop marker) ──
async function buildStopInfoHtml(stopId, stopName, type='bus'){
  const isMetro = type === 'metro';
  const iconBg  = isMetro ? '#1e3a8a' : '#92400e';
  const iconEmoji = isMetro ? '🚇' : '🚏';

  const data = await getStopTimings(stopId, type);
  if(!data || !data.services || !data.services.length){
    return `
      <div style="min-width:240px;font-family:-apple-system,BlinkMacSystemFont,'DM Sans',sans-serif;">
        <div style="display:flex;align-items:center;gap:10px;">
          <div style="width:36px;height:36px;border-radius:50%;background:${iconBg};display:flex;align-items:center;justify-content:center;flex-shrink:0;font-size:18px;">${iconEmoji}</div>
          <div>
            <div style="font-size:15px;font-weight:900;color:#0f172a;">${stopName}</div>
            <div style="font-size:10px;color:#94a3b8;">No schedule loaded · try again</div>
          </div>
        </div>
      </div>`;
  }

  const now = new Date();
  const nowMins = now.getHours() * 60 + now.getMinutes();
  function minsUntil(t) {
    if (!t) return null;
    const [h, m] = t.split(':').map(Number);
    const d = h * 60 + m - nowMins;
    return d >= 0 ? d : null;
  }

  const rows = data.services.slice(0, 8).map(s => {
    const lc = s.color || (isMetro ? '#1565c0' : '#d97706');
    const times = (s.nextTimes || []).slice(0, 3);
    const nd = minsUntil(times[0]);
    const cdTxt   = nd === null ? '—' : nd === 0 ? 'Now' : `${nd} min`;
    const cdColor = nd !== null && nd <= 2 ? '#dc2626' : nd !== null && nd <= 5 ? '#d97706' : '#475569';
    const chips = times.map((t,i) =>
      `<span style="background:${i===0?lc:'#f1f5f9'};color:${i===0?'white':'#64748b'};font-size:10px;font-weight:700;padding:2px 7px;border-radius:5px;">${t}</span>`
    ).join('');
    return `
      <div style="display:flex;align-items:center;gap:10px;padding:9px 0;border-bottom:1px solid #f1f5f9;">
        <div style="width:4px;min-height:36px;border-radius:4px;background:${lc};flex-shrink:0;align-self:stretch;"></div>
        <div style="flex:1;min-width:0;overflow:hidden;">
          <div style="font-size:12px;font-weight:900;color:${lc};letter-spacing:.3px;margin-bottom:3px;">${s.routeName}</div>
          <div style="display:flex;gap:4px;">${chips}</div>
        </div>
        <div style="text-align:right;flex-shrink:0;padding-left:2px;">
          <div style="font-size:17px;font-weight:900;color:${cdColor};line-height:1;">${cdTxt}</div>
          ${nd ? `<div style="font-size:9px;color:#94a3b8;margin-top:2px;">away</div>` : ''}
        </div>
      </div>`;
  }).join('');

  const more = data.services.length > 8
    ? `<div style="font-size:10px;color:#94a3b8;padding:6px 0 2px;font-weight:600;text-align:center;">+${data.services.length-8} more routes at this stop</div>`
    : '';

  // DTC link only for Delhi bus stops
  const dtcLink = !isMetro
    ? `<a href="https://otd.delhi.gov.in/" target="_blank" rel="noopener"
        style="display:flex;align-items:center;justify-content:center;gap:5px;margin-top:8px;padding:7px 10px;
               background:#fff7ed;border:1px solid #fed7aa;border-radius:8px;text-decoration:none;
               font-size:11px;font-weight:700;color:#c2410c;">
        🔗 View all routes on DTC / OTD Delhi
      </a>`
    : '';

  return `
    <div style="min-width:270px;max-width:320px;font-family:-apple-system,BlinkMacSystemFont,'DM Sans',sans-serif;">
      <div style="display:flex;align-items:center;gap:10px;padding-bottom:10px;border-bottom:2px solid #f1f5f9;margin-bottom:2px;">
        <div style="width:36px;height:36px;border-radius:50%;background:${iconBg};display:flex;align-items:center;justify-content:center;flex-shrink:0;font-size:18px;">${iconEmoji}</div>
        <div style="min-width:0;">
          <div style="font-size:15px;font-weight:900;color:#0f172a;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${stopName}</div>
          <div style="font-size:10px;color:#64748b;font-weight:600;">${data.serviceCount} route${data.serviceCount!==1?'s':''} · live departures</div>
        </div>
      </div>
      ${rows}${more}${dtcLink}
    </div>`;
}

window.BusEngine = {
  getNearestBusStops,
  findBusRoutes,
  buildBusHudHtml,
  buildStopInfoHtml,
  getStopTimings,
  busDataReady,
  busHav,
};
