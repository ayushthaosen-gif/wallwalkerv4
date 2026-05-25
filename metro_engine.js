/**
 * GAITWAY — METRO ENGINE v2
 * - Real line names, colors, stop sequences
 * - Next train timings from /api/transit/stop/:id?type=metro
 * - Interchange detection
 * - Stop info popup with all lines + timings
 */
'use strict';

const METRO_LINE_COLORS = {
  red:'#e53935',blue:'#1565c0',yellow:'#f9a825',green:'#43a047',
  violet:'#8e24aa',pink:'#e91e63',magenta:'#d81b60',gray:'#757575',
  orange:'#fb8c00',aqua:'#00acc1',rapid:'#00897b',
};

function haversineKm(la1,lo1,la2,lo2){
  const R=6371,r=Math.PI/180,dL=(la2-la1)*r,dO=(lo2-lo1)*r;
  const a=Math.sin(dL/2)**2+Math.cos(la1*r)*Math.cos(la2*r)*Math.sin(dO/2)**2;
  return R*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a));
}

function parseLineColor(name){
  const n=(name||'').toUpperCase();
  if(n.includes('RED'))    return METRO_LINE_COLORS.red;
  if(n.includes('BLUE'))   return METRO_LINE_COLORS.blue;
  if(n.includes('YELLOW')) return METRO_LINE_COLORS.yellow;
  if(n.includes('GREEN'))  return METRO_LINE_COLORS.green;
  if(n.includes('VIOLET')) return METRO_LINE_COLORS.violet;
  if(n.includes('PINK'))   return METRO_LINE_COLORS.pink;
  if(n.includes('MAGENTA'))return METRO_LINE_COLORS.magenta;
  if(n.includes('GRAY')||n.includes('GREY'))return METRO_LINE_COLORS.gray;
  if(n.includes('ORANGE')||n.includes('AIRPORT'))return METRO_LINE_COLORS.orange;
  if(n.includes('AQUA'))   return METRO_LINE_COLORS.aqua;
  if(n.includes('RAPID'))  return METRO_LINE_COLORS.rapid;
  return '#888';
}

function extractLineName(name){
  if(!name)return'Metro';
  // "BLUE_Dwarka Sector - 21 to Noida Electronic City" -> "Blue Line"
  const parts=name.split('_');
  const color=parts[0].replace(/\//g,' ').split(' ')[0];
  return color.charAt(0)+color.slice(1).toLowerCase()+' Line';
}

function getNearestMetroStations(lat,lng,n=5,maxKm=2.0){
  if(typeof METRO_DATA==='undefined')return[];
  return Object.entries(METRO_DATA.stops)
    .map(([id,s])=>({id,lat:s[0],lng:s[1],name:s[2],dist:haversineKm(lat,lng,s[0],s[1])}))
    .filter(s=>s.dist<=maxKm).sort((a,b)=>a.dist-b.dist).slice(0,n);
}

function getRoutesAtStop(stopId){
  if(typeof METRO_DATA==='undefined')return[];
  return Object.entries(METRO_DATA.route_stops)
    .filter(([,sl])=>sl.includes(String(stopId)))
    .map(([rid])=>({rid,...METRO_DATA.routes[rid]}));
}

function planMetroJourney(fromId,toId){
  if(typeof METRO_DATA==='undefined')return null;
  const rs=METRO_DATA.route_stops, routes=METRO_DATA.routes;
  // Direct
  for(const[rid,sl]of Object.entries(rs)){
    const iA=sl.indexOf(String(fromId)), iB=sl.indexOf(String(toId));
    if(iA!==-1&&iB!==-1){
      const seg=iA<iB?sl.slice(iA,iB+1):sl.slice(iB,iA+1).reverse();
      return[{type:'metro',routeId:rid,routeInfo:routes[rid],stops:seg,
        stopNames:seg.map(s=>METRO_DATA.stops[s]?.[2]||s),
        numStops:seg.length-1,boardStopId:fromId,alightStopId:toId}];
    }
  }
  // One interchange
  const fRoutes=getRoutesAtStop(fromId), tRoutes=getRoutesAtStop(toId);
  for(const fr of fRoutes){
    const fStops=rs[fr.rid];
    for(const tr of tRoutes){
      if(fr.rid===tr.rid)continue;
      const tStops=rs[tr.rid];
      const common=fStops.filter(s=>tStops.includes(s));
      if(common.length){
        const xId=common[0];
        const iA=fStops.indexOf(String(fromId)), iX=fStops.indexOf(xId);
        const seg1=iA<iX?fStops.slice(iA,iX+1):fStops.slice(iX,iA+1).reverse();
        const iX2=tStops.indexOf(xId), iB=tStops.indexOf(String(toId));
        const seg2=iX2<iB?tStops.slice(iX2,iB+1):tStops.slice(iB,iX2+1).reverse();
        return[
          {type:'metro',routeId:fr.rid,routeInfo:fr,stops:seg1,
           stopNames:seg1.map(s=>METRO_DATA.stops[s]?.[2]||s),
           numStops:seg1.length-1,boardStopId:fromId,alightStopId:xId},
          {type:'interchange',stopId:xId,stopName:METRO_DATA.stops[xId]?.[2]||xId},
          {type:'metro',routeId:tr.rid,routeInfo:tr,stops:seg2,
           stopNames:seg2.map(s=>METRO_DATA.stops[s]?.[2]||s),
           numStops:seg2.length-1,boardStopId:xId,alightStopId:toId},
        ];
      }
    }
  }
  return null;
}

function drawMetroRoute(legs,layer){
  if(!layer||typeof METRO_DATA==='undefined')return;
  legs.forEach(leg=>{
    if(leg.type!=='metro')return;
    const color=parseLineColor(leg.routeInfo?.name||'');
    const shape=METRO_DATA.route_shapes[leg.routeId];
    if(!shape||shape.length<2)return;
    const board=METRO_DATA.stops[leg.boardStopId];
    const alight=METRO_DATA.stops[leg.alightStopId];
    if(!board||!alight){L.polyline(shape,{color,weight:6,opacity:.9}).addTo(layer);return;}
    const closest=(lat,lng)=>{let best=0,bestD=Infinity;shape.forEach((pt,i)=>{const d=haversineKm(lat,lng,pt[0],pt[1]);if(d<bestD){bestD=d;best=i;}});return best;};
    const iA=closest(board[0],board[1]),iB=closest(alight[0],alight[1]);
    const clipped=iA<=iB?shape.slice(iA,iB+1):shape.slice(iB,iA+1).reverse();
    L.polyline(clipped.length>1?clipped:shape,{color,weight:6,opacity:.9}).addTo(layer);
  });
}

// ── BUILD METRO HUD with real timings ──
async function buildMetroHudHtml(legs, originName, destName, walkInKm, walkOutKm){
  const API_BASE = window.location.hostname==='localhost'?'http://localhost:3000':'';
  const metroLegs = legs.filter(l=>l.type==='metro');
  const totalStops = metroLegs.reduce((a,l)=>a+l.numStops,0);

  // Fetch next train times for board stop of first leg
  let nextTrains = [];
  let boardLineColor = '#1565c0';
  if(metroLegs.length){
    const firstLeg = metroLegs[0];
    boardLineColor = parseLineColor(firstLeg.routeInfo?.name||'');
    try {
      const res = await fetch(`${API_BASE}/api/transit/stop/${firstLeg.boardStopId}?type=metro`);
      const data = await res.json();
      const ourRoute = data.services?.find(s=>s.routeId===firstLeg.routeId);
      if(ourRoute) nextTrains = ourRoute.nextTimes||[];
    } catch(e){}
  }

  const now = new Date();
  let minsUntil = '--';
  if(nextTrains[0]){
    const [h,m]=nextTrains[0].split(':').map(Number);
    minsUntil=Math.max(0,h*60+m-now.getHours()*60-now.getMinutes());
  }

  const approxMin = Math.round(walkInKm*12) + totalStops*2 + Math.round(walkOutKm*12) + (typeof minsUntil==='number'?Math.min(minsUntil,10):5);

  let legsHtml = '';
  legs.forEach(leg=>{
    if(leg.type==='metro'){
      const color=parseLineColor(leg.routeInfo?.name||'');
      const lineName=extractLineName(leg.routeInfo?.name||leg.routeId);
      legsHtml+=`
        <div style="margin-bottom:10px;">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">
            <div style="background:${color};color:white;font-size:11px;font-weight:900;padding:3px 10px;border-radius:6px;">${lineName}</div>
            <span style="font-size:10px;color:#64748b;font-weight:600;">${leg.numStops} stops</span>
          </div>
          <div style="border-left:3px solid ${color};padding:6px 10px;background:${color}15;border-radius:0 8px 8px 0;font-size:11px;">
            <div><b>Board:</b> ${leg.stopNames[0]}</div>
            <div style="color:#64748b;font-size:10px;margin:2px 0;">${leg.stopNames.slice(1,-1).slice(0,3).join(' → ')}${leg.stopNames.length>5?' …':''}</div>
            <div><b>Alight:</b> ${leg.stopNames[leg.stopNames.length-1]}</div>
          </div>
        </div>`;
    } else if(leg.type==='interchange'){
      legsHtml+=`
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px;background:#f8fafc;padding:8px;border-radius:8px;">
          <span style="font-size:16px;">🔄</span>
          <span style="font-size:11px;font-weight:700;">Interchange at <b>${leg.stopName}</b></span>
        </div>`;
    }
  });

  // Next train times strip
  const timesHtml = nextTrains.length
    ? `<div style="display:flex;gap:4px;flex-wrap:wrap;margin-top:8px;">
        ${nextTrains.slice(0,5).map((t,i)=>`<span style="background:${i===0?boardLineColor:'#f1f5f9'};color:${i===0?'white':'#475569'};font-size:11px;font-weight:700;padding:3px 8px;border-radius:6px;">${t}</span>`).join('')}
       </div>`
    : '';

  const html = `
    <div style="margin-bottom:8px;">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">
        <div style="font-size:12px;font-weight:800;color:#1565c0;">🚇 Delhi Metro · ${totalStops} stops</div>
        <div style="text-align:right;">
          <div style="font-size:18px;font-weight:900;color:${typeof minsUntil==='number'&&minsUntil<5?'#dc2626':'#1565c0'};">${typeof minsUntil==='number'?minsUntil+' min':'--'}</div>
          <div style="font-size:9px;color:#94a3b8;">next train</div>
        </div>
      </div>
      ${legsHtml}
      ${timesHtml}
    </div>`;

  return { html, approxMin, totalMetroStops: totalStops };
}

// ── STOP INFO POPUP for metro station ──
async function buildMetroStopInfoHtml(stopId, stopName){
  if (typeof BusEngine !== 'undefined') {
    const data = await BusEngine.getStopTimings(stopId, 'metro');
    if (data && data.services && data.services.length) {

      const now = new Date();
      const nowMins = now.getHours() * 60 + now.getMinutes();

      function minsUntil(timeStr) {
        if (!timeStr) return null;
        const [h, m] = timeStr.split(':').map(Number);
        const diff = h * 60 + m - nowMins;
        return diff >= 0 ? diff : null;
      }

      const rows = data.services.map(s => {
        // Parse "MAGENTA_Janak Puri West to Botanical Garden"
        const uscore = s.routeName.indexOf('_');
        const lineKey  = uscore > -1 ? s.routeName.slice(0, uscore).trim() : '';
        const routePart = uscore > -1 ? s.routeName.slice(uscore + 1) : s.routeName;
        // Show destination only (after " to ")
        const toIdx = routePart.toLowerCase().indexOf(' to ');
        const dest  = toIdx > -1 ? routePart.slice(toIdx + 4).trim() : routePart;

        const lineColor = parseLineColor(lineKey || s.routeName) || s.color || '#1565c0';
        const lineName  = lineKey
          ? lineKey.charAt(0) + lineKey.slice(1).toLowerCase() + ' Line'
          : extractLineName(s.routeName);

        const times = (s.nextTimes || []).slice(0, 3);
        const nextDiff = minsUntil(times[0]);
        const countdownTxt   = nextDiff === null ? '—'
                             : nextDiff === 0    ? 'Now'
                             : `${nextDiff} min`;
        const countdownColor = (nextDiff !== null && nextDiff <= 2)  ? '#dc2626'
                             : (nextDiff !== null && nextDiff <= 5)  ? '#d97706'
                             : lineColor;

        const timeChips = times.map((t, i) =>
          `<span style="
            background:${i === 0 ? lineColor : '#f1f5f9'};
            color:${i === 0 ? 'white' : '#64748b'};
            font-size:10px;font-weight:700;
            padding:2px 7px;border-radius:5px;letter-spacing:.2px;
          ">${t}</span>`
        ).join('');

        return `
          <div style="display:flex;align-items:center;gap:10px;padding:9px 0;border-bottom:1px solid #f1f5f9;">
            <div style="width:4px;min-height:38px;border-radius:4px;background:${lineColor};flex-shrink:0;align-self:stretch;"></div>
            <div style="flex:1;min-width:0;overflow:hidden;">
              <div style="font-size:9px;font-weight:800;color:${lineColor};text-transform:uppercase;letter-spacing:.6px;margin-bottom:1px;">${lineName}</div>
              <div style="font-size:13px;font-weight:800;color:#0f172a;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">→ ${dest}</div>
              <div style="display:flex;gap:4px;margin-top:4px;">${timeChips}</div>
            </div>
            <div style="text-align:right;flex-shrink:0;padding-left:4px;">
              <div style="font-size:17px;font-weight:900;color:${countdownColor};line-height:1;">${countdownTxt}</div>
              ${nextDiff !== null && nextDiff > 0
                ? `<div style="font-size:9px;color:#94a3b8;margin-top:2px;">away</div>` : ''}
            </div>
          </div>`;
      }).join('');

      return `
        <div style="min-width:270px;max-width:330px;font-family:-apple-system,BlinkMacSystemFont,'DM Sans',sans-serif;">
          <div style="display:flex;align-items:center;gap:10px;padding-bottom:10px;border-bottom:2px solid #f1f5f9;margin-bottom:2px;">
            <div style="width:36px;height:36px;border-radius:50%;background:#1e3a8a;display:flex;align-items:center;justify-content:center;flex-shrink:0;font-size:18px;">🚇</div>
            <div style="min-width:0;">
              <div style="font-size:16px;font-weight:900;color:#0f172a;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${stopName}</div>
              <div style="font-size:10px;color:#64748b;font-weight:600;">${data.serviceCount} line${data.serviceCount !== 1 ? 's' : ''} · live departures</div>
            </div>
          </div>
          ${rows}
        </div>`;
    }
  }
  return `
    <div style="min-width:220px;padding:4px;font-family:-apple-system,BlinkMacSystemFont,'DM Sans',sans-serif;">
      <div style="display:flex;align-items:center;gap:8px;">
        <div style="width:32px;height:32px;border-radius:50%;background:#1e3a8a;display:flex;align-items:center;justify-content:center;font-size:16px;">🚇</div>
        <div>
          <div style="font-size:14px;font-weight:800;color:#0f172a;">${stopName}</div>
          <div style="font-size:10px;color:#94a3b8;">Schedule loading…</div>
        </div>
      </div>
    </div>`;
}

window.MetroEngine = {
  getNearestMetroStations,
  getRoutesAtStop,
  planMetroJourney,
  drawMetroRoute,
  buildMetroHudHtml,
  buildMetroStopInfoHtml,
  parseLineColor,
  extractLineName,
  haversineKm,
};
