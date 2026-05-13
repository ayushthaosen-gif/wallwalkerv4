'use strict';

// ── API CONFIG ──
const API = window.location.hostname === 'localhost'
  ? 'http://localhost:3000'
  : '';  // Same origin on Render — empty string works

// ── USER SESSION ──
let userId = localStorage.getItem('gw_user_id');
if (!userId) {
  userId = 'u_' + Math.random().toString(36).slice(2,9) + Date.now().toString(36);
  localStorage.setItem('gw_user_id', userId);
}


// ══════════════════════════════════════════════
// AUTH & USER PROFILE
// ══════════════════════════════════════════════
let userToken = localStorage.getItem('gw_token') || null;
let otpTimer  = null;
let otpResendCountdown = 0;

function isLoggedIn() { return !!userToken; }
function authHeaders() {
  return userToken
    ? { 'Content-Type':'application/json', 'Authorization':'Bearer '+userToken }
    : { 'Content-Type':'application/json' };
}

// ── OTP digit box navigation ──
function initOTPBoxes() {
  const boxes = document.querySelectorAll('.otp-digit');
  boxes.forEach((box, i) => {
    box.addEventListener('input', e => {
      const v = e.target.value.toString().slice(-1);
      e.target.value = v;
      if (v && i < boxes.length - 1) boxes[i+1].focus();
      if (getOTPValue().length === 6) verifyOTP();
    });
    box.addEventListener('keydown', e => {
      if (e.key === 'Backspace' && !box.value && i > 0) boxes[i-1].focus();
    });
    box.addEventListener('paste', e => {
      e.preventDefault();
      const paste = (e.clipboardData || window.clipboardData).getData('text').replace(/\D/g,'').slice(0,6);
      paste.split('').forEach((ch, idx) => { if (boxes[idx]) boxes[idx].value = ch; });
      if (paste.length === 6) verifyOTP();
    });
  });
}

function getOTPValue() {
  return [0,1,2,3,4,5].map(i => document.getElementById('otp'+i)?.value||'').join('');
}

function clearOTPBoxes() {
  [0,1,2,3,4,5].forEach(i => { const el=document.getElementById('otp'+i); if(el) el.value=''; });
}

function startOTPTimer(secs=120) {
  clearInterval(otpTimer);
  otpResendCountdown = secs;
  const el = document.getElementById('otpTimer');
  const rb  = document.getElementById('resendBtn');
  if (rb) rb.disabled = true;
  otpTimer = setInterval(() => {
    otpResendCountdown--;
    if (el) el.textContent = otpResendCountdown > 0 ? `Resend in ${otpResendCountdown}s` : '';
    if (otpResendCountdown <= 0) {
      clearInterval(otpTimer);
      if (rb) rb.disabled = false;
    }
  }, 1000);
}

// ── Step 1: Request OTP ──
async function requestOTP() {
  const email = document.getElementById('loginEmail').value.trim();
  const name  = document.getElementById('loginName').value.trim();
  const errEl = document.getElementById('loginError');
  errEl.textContent = '';
  if (!name) { errEl.textContent = 'Please enter your name'; return; }
  if (!email || !email.includes('@')) { errEl.textContent = 'Enter a valid email address'; return; }

  const btn = document.querySelector('#loginStep1 .btn-start');
  btn.textContent = 'Sending…'; btn.disabled = true;

  try {
    const res  = await fetch(`${API}/api/auth/request-otp`, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ email })
    });
    const data = await res.json();
    if (!data.ok) { errEl.textContent = data.error || 'Could not send code'; btn.textContent='Get Login Code →'; btn.disabled=false; return; }

    localStorage.setItem('gw_pending_email', email);
    localStorage.setItem('gw_pending_name',  name);

    document.getElementById('loginStep1').style.display = 'none';
    document.getElementById('loginStep2').style.display = 'block';
    document.getElementById('loginStep2Desc').textContent = `Code sent to ${email}`;

    initOTPBoxes();
    startOTPTimer(120);
    setTimeout(() => document.getElementById('otp0')?.focus(), 100);

    // Dev mode — auto fill
    if (data.dev_otp) {
      const digits = data.dev_otp.toString().split('');
      digits.forEach((d,i) => { const el=document.getElementById('otp'+i); if(el) el.value=d; });
    }
  } catch(e) {
    errEl.textContent = 'Network error — check connection';
  }
  btn.textContent = 'Get Login Code →'; btn.disabled = false;
}

// ── Step 2: Verify OTP ──
async function verifyOTP() {
  const otp   = getOTPValue();
  const email = localStorage.getItem('gw_pending_email');
  const name  = localStorage.getItem('gw_pending_name') || 'Walker';
  const errEl = document.getElementById('otpError');
  errEl.textContent = '';

  if (otp.length < 6) { errEl.textContent = 'Enter all 6 digits'; return; }

  const btn = document.getElementById('verifyBtn');
  btn.textContent = 'Verifying…'; btn.disabled = true;

  try {
    const res  = await fetch(`${API}/api/auth/verify-otp`, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ email, otp, name })
    });
    const data = await res.json();
    if (!data.ok) {
      errEl.textContent = data.error || 'Incorrect code — try again';
      clearOTPBoxes();
      document.getElementById('otp0')?.focus();
      btn.textContent = 'Verify Code →'; btn.disabled = false;
      return;
    }
    clearInterval(otpTimer);

    // Save session
    userId    = data.userId;
    userToken = data.token;
    localStorage.setItem('gw_user_id',   userId);
    localStorage.setItem('gw_token',     userToken);
    localStorage.setItem('gw_user_name', data.user.name);
    localStorage.removeItem('gw_pending_email');
    localStorage.removeItem('gw_pending_name');

    applyUserToUI(data.user);

    // First-time user → show profile setup
    if (data.isNewUser) {
      document.getElementById('loginStep2').style.display = 'none';
      document.getElementById('loginStep3').style.display = 'block';
    } else {
      document.getElementById('loginModal').classList.remove('active');
      showToast(`Welcome back, ${data.user.name}! 🎉`);
    }
  } catch(e) {
    errEl.textContent = 'Network error — try again';
  }
  btn.textContent = 'Verify Code →'; btn.disabled = false;
}

// ── Resend OTP ──
async function resendOTP() {
  const email = localStorage.getItem('gw_pending_email');
  if (!email) { backToStep1(); return; }
  try {
    await fetch(`${API}/api/auth/request-otp`, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ email })
    });
    clearOTPBoxes();
    document.getElementById('otp0')?.focus();
    document.getElementById('otpError').textContent = '';
    startOTPTimer(120);
    showToast('New code sent!');
  } catch(e) { showToast('Could not resend — check connection'); }
}

function backToStep1() {
  clearInterval(otpTimer);
  document.getElementById('loginStep1').style.display = 'block';
  document.getElementById('loginStep2').style.display = 'none';
  document.getElementById('loginError').textContent = '';
}

// ── Profile chip toggle ──
function toggleProfileChip(btn, groupId) {
  document.querySelectorAll(`#${groupId} .profile-chip`).forEach(c => c.classList.remove('active'));
  btn.classList.add('active');
}

// ── Save profile (step 3) ──
async function saveProfile() {
  const purpose  = document.querySelector('#walkPurpose .profile-chip.active')?.dataset.val || 'commute';
  const priority = document.querySelector('#walkPriority .profile-chip.active')?.dataset.val || 'safety';
  const area     = document.getElementById('profileArea')?.value.trim() || '';
  const name     = localStorage.getItem('gw_pending_name') || localStorage.getItem('gw_user_name') || 'Walker';

  localStorage.setItem('gw_walk_purpose',  purpose);
  localStorage.setItem('gw_walk_priority', priority);
  localStorage.setItem('gw_area',          area);

  // Save to server
  try {
    await fetch(`${API}/api/users/upsert`, {
      method:'POST', headers: authHeaders(),
      body: JSON.stringify({ id:userId, name, walk_purpose:purpose, walk_priority:priority, area })
    });
  } catch(e) {}

  document.getElementById('loginModal').classList.remove('active');
  showToast(`Welcome, ${name}! Let's walk 🚶`);
}

function continueAsGuest() {
  document.getElementById('loginModal').classList.remove('active');
  showToast('Guest mode — reports saved locally');
}

// ── Apply user data to all UI elements ──
function applyUserToUI(user) {
  if (!user) return;
  document.getElementById('vaultName').textContent = user.name || 'Walker';
  document.getElementById('vaultXp').textContent   = (user.xp || 0).toLocaleString();
  // Update profile modal if open
  const pn = document.getElementById('profileName');
  if (pn) pn.value = user.name || '';
  const ed = document.getElementById('profileEmailDisplay');
  if (ed) ed.textContent = user.email_hint ? `Signed in · ${user.email_hint}` : 'Guest account';
  const ps = document.getElementById('pStatXp');      if (ps) ps.textContent = (user.xp||0).toLocaleString();
  const pr = document.getElementById('pStatRoutes');  if (pr) pr.textContent = user.route_count || 0;
  const ph = document.getElementById('pStatHazards'); if (ph) ph.textContent = user.hazard_count || 0;
}

function showLoginModal() {
  document.getElementById('loginStep1').style.display = 'block';
  document.getElementById('loginStep2').style.display = 'none';
  document.getElementById('loginStep3').style.display = 'none';
  openModal('loginModal');
}

// ── Edit profile save ──
async function saveProfileEdit() {
  const name = document.getElementById('profileName')?.value.trim();
  if (!name) { showToast('Enter a name'); return; }
  try {
    const res = await fetch(`${API}/api/users/${userId}`, {
      method:'PATCH', headers: authHeaders(),
      body: JSON.stringify({ name })
    });
    const user = await res.json();
    localStorage.setItem('gw_user_name', user.name);
    applyUserToUI(user);
    closeModal('profileModal');
    showToast('Profile saved ✓');
  } catch(e) { showToast('Could not save — check connection'); }
}

// ── Logout ──
function logoutUser() {
  if (!confirm('Sign out of GaitWay?')) return;
  userToken = null; userId = null;
  ['gw_token','gw_user_id','gw_user_name','gw_pending_email','gw_pending_name'].forEach(k => localStorage.removeItem(k));
  closeModal('profileModal');
  applyUserToUI({ name:'Walker', xp:0, route_count:0, hazard_count:0 });
  showLoginModal();
  showToast('Signed out');
}

// ── Load route history into profile modal ──
async function loadProfileRouteHistory() {
  const el = document.getElementById('profileRouteHistory');
  if (!el || !userId) return;
  try {
    const res = await fetch(`${API}/api/routes/${userId}`);
    const routes = await res.json();
    if (!routes.length) { el.innerHTML = '<div style="color:#94a3b8;font-size:12px;text-align:center;padding:10px;">No walks yet</div>'; return; }
    el.innerHTML = '<div style="font-size:12px;font-weight:800;color:#94a3b8;text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px;">Recent Walks</div>'
      + routes.slice(0,5).map(r => `
        <div style="background:#f8fafc;border-radius:10px;padding:10px 12px;margin-bottom:6px;display:flex;align-items:center;gap:10px;">
          <div style="font-size:18px;">${r.mode==='transit'?'🚌':r.mode==='safe'?'🛡️':'🚶'}</div>
          <div style="flex:1;">
            <div style="font-size:12px;font-weight:700;">${r.from_name||'?'} → ${r.to_name||'?'}</div>
            <div style="font-size:10px;color:#94a3b8;">${r.dist_km?.toFixed(1)||'?'}km · ${r.steps?.toLocaleString()||'?'} steps</div>
          </div>
          <div style="text-align:right;">
            <div style="font-size:16px;font-weight:900;color:#2563eb;">${r.walk_score||'—'}</div>
            <div style="font-size:9px;color:#94a3b8;">score</div>
          </div>
        </div>`).join('');
  } catch(e) {}
}

// ── Init user session on load ──
async function initUserSession() {
  const storedToken = localStorage.getItem('gw_token');
  const storedId    = localStorage.getItem('gw_user_id');

  if (!storedToken && !storedId) {
    // Brand new user — show login after map loads
    setTimeout(() => openModal('loginModal'), 1000);
    return;
  }

  userToken = storedToken;
  userId    = storedId || userId;

  try {
    const res  = await fetch(`${API}/api/users/upsert`, {
      method: 'POST', headers: { 'Content-Type':'application/json' },
      body: JSON.stringify({ id: userId, name: localStorage.getItem('gw_user_name') || 'Walker' })
    });
    const user = await res.json();
    applyUserToUI(user);
  } catch(e) { console.warn('User session offline — using cached data'); }
}

async function loadHazardsFromDB() {
  if (!userLoc) return;
  try {
    const res = await fetch(`${API}/api/hazards?lat=${userLoc.lat}&lng=${userLoc.lng}&radius=10&limit=200`);
    const hazards = await res.json();
    if (!Array.isArray(hazards)) return;
    hazards.forEach(h => {
      const ico = L.divIcon({ className:'',
        html:`<div style="background:#dc2626;width:10px;height:10px;border-radius:50%;border:2px solid white;opacity:.7;"></div>`,
        iconSize:[10,10], iconAnchor:[5,5] });
      L.marker([h.lat,h.lng],{icon:ico}).addTo(hazardLayer)
       .bindPopup(`<b>${h.type}</b>${h.surface?'<br>Surface: '+h.surface:''}${h.canopy?'<br>Canopy: '+h.canopy:''}<br><small>${new Date(h.created_at).toLocaleDateString()}</small>`);
    });
  } catch(e) {}
}

async function saveHazardToDB(type, lat, lng, extra={}) {
  try {
    await fetch(`${API}/api/hazards`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, lat, lng, user_id: userId, ...extra })
    });
  } catch(e) { console.warn('Hazard save failed (offline)'); }
}

async function saveRouteToDB(routeData) {
  try {
    const res = await fetch(`${API}/api/routes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_id: userId, ...routeData })
    });
    const data = await res.json();
    // Refresh XP
    const uRes = await fetch(`${API}/api/users/${userId}`);
    const user = await uRes.json();
    document.getElementById('vaultXp').textContent = (user.xp||0).toLocaleString();
    showToast(`+${routeData.mode==='walk'?250:150} XP earned!`);
  } catch(e) { console.warn('Route save failed (offline)'); }
}

// ── STATE ──
let map, userLoc, userMarker;
let searchTimerFrom, searchTimerTo;
let isMinimized = false, treeLayer = null;
let interactiveLayer, transitLayer, stationLayer, hazardLayer;
let routeCoordsData = { footpaths:[], bridges:[], underpasses:[], crossings:[] };
let activeDestLatLng = null, activeOriginLatLng = null;
let activeOriginName = '', activeDestName = '';
let originMarker = null;
let simData = {};
let isLiveTracking = false;
let currentRouteMode = 'walk';
let cachedMetroPlan = null;

// Surface / motion
let motionDataZ=[], motionDataX=[], motionDataY=[];
let lastKnownSurface = 'Unknown';
let surfaceHistory = [];
let peakTimestamps = [];
let liveSteps = 0;
let lastSurfaceResult = null;

// Score
let walkabilityBase = 100;
let localHazards = [];

// ── INIT ──
window.onload = () => {
  Env.init();
  window._onEnvUpdate = updateSurfaceReadout;
  initTabs();
  initMap();
  initSensors();
  initSearchBoxes();
  pollBusData();
  initUserSession();
};

// ── TABS ──
function initTabs() {
  document.querySelectorAll('.bottom-nav .nav-item').forEach(item => {
    item.addEventListener('click', function () {
      document.querySelectorAll('.bottom-nav .nav-item').forEach(n => n.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
      this.classList.add('active');
      const target = document.getElementById(this.dataset.target);
      if (target) target.classList.add('active');
      if (this.dataset.target === 'explore-tab') setTimeout(() => map.invalidateSize(), 100);
      if (this.dataset.target === 'vault-tab') { refreshVaultStats(); loadProfileRouteHistory(); }
    });
  });
}

// ── MAP ──
function initMap() {
  interactiveLayer = L.layerGroup();
  transitLayer     = L.layerGroup();
  stationLayer     = L.layerGroup();
  hazardLayer      = L.layerGroup();

  map = L.map('map', { zoomControl:false, attributionControl:false })
         .setView([28.6139, 77.2090], 13);
  L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png').addTo(map);
  interactiveLayer.addTo(map);
  transitLayer.addTo(map);
  stationLayer.addTo(map);
  hazardLayer.addTo(map);

  // Refresh transit stops as user pans/zooms
  let transitRefreshTimer = null;
  map.on('moveend zoomend', () => {
    clearTimeout(transitRefreshTimer);
    transitRefreshTimer = setTimeout(() => {
      const center = map.getCenter();
      const zoom   = map.getZoom();
      // Only show stops when zoomed in enough (avoid cluttering at zoom < 14)
      if (zoom >= 14) {
        refreshTransitOnView(center.lat, center.lng, zoom);
      } else {
        stationLayer.clearLayers();
      }
    }, 400);
  });

  // Long-press to drop destination
  map.on('contextmenu', async e => {
    showToast('Fetching address…');
    try {
      const r = await fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${e.latlng.lat}&lon=${e.latlng.lng}`);
      const d = await r.json();
      setDest(e.latlng.lat, e.latlng.lng, d.display_name ? d.display_name.split(',')[0] : 'Dropped Pin');
    } catch { setDest(e.latlng.lat, e.latlng.lng, 'Dropped Pin'); }
  });
}

// ── GPS / SENSORS ──
function initSensors() {
  // Watch GPS continuously
  map.locate({ setView: false, watch: true, enableHighAccuracy: true });

  map.on('locationfound', e => {
    const firstFix = !userLoc;
    userLoc = e.latlng;

    // AUTO-FLY to user on first fix (fixes the "locate me" issue)
    if (firstFix) {
      map.flyTo(userLoc, 16, { animate: true, duration: 1.2 });
    } else if (isLiveTracking) {
      map.panTo(userLoc);
    }

    if (!userMarker) {
      const ico = L.divIcon({
        className: '',
        html: `<div class="compass-marker" id="userCompassNode"><div class="compass-dot"></div><div class="compass-cone"></div></div>`,
        iconSize: [24,24], iconAnchor: [12,12]
      });
      userMarker = L.marker(userLoc, { icon: ico, zIndexOffset: 1000 }).addTo(map);
    } else {
      userMarker.setLatLng(userLoc);
    }

    document.getElementById('vGps').textContent = 'Active ✓';
    fetchLiveEnv(userLoc.lat, userLoc.lng);
    showNearbyTransit(userLoc.lat, userLoc.lng);
    if (firstFix) loadHazardsFromDB();
  });

  map.on('locationerror', e => {
    document.getElementById('vGps').textContent = 'Unavailable';
    showToast('GPS unavailable — check browser permissions');
  });

  if (window.DeviceOrientationEvent) {
    window.addEventListener('deviceorientationabsolute', handleOrientation, true);
    window.addEventListener('deviceorientation', handleOrientation, true);
  }
  if (navigator.getBattery) {
    navigator.getBattery().then(b => {
      const upd = () => document.getElementById('vBattery').textContent = Math.round(b.level*100)+'%';
      upd(); b.addEventListener('levelchange', upd);
    });
  }
}

// ── GPS BUTTON — flies to user location ──
function useMyLocation() {
  activeOriginLatLng = null;
  activeOriginName   = '';
  const inp = document.getElementById('inputFrom');
  inp.value = ''; inp.placeholder = 'From: My Location';
  if (originMarker) { map.removeLayer(originMarker); originMarker = null; }
  closeDropdown();
  if (userLoc) {
    map.flyTo(userLoc, 17, { animate: true, duration: 1 });
  } else {
    showToast('Acquiring GPS — please wait…');
    // Try one-shot locate in case watch hasn't fired
    map.locate({ setView: false, enableHighAccuracy: true });
  }
  tryPrepare();
}

function handleOrientation(e) {
  const node = document.getElementById('userCompassNode');
  if (!node) return;
  const h = e.webkitCompassHeading || Math.abs(e.alpha - 360);
  if (h) node.style.transform = `rotate(${h}deg)`;
}

// ── ENV DATA ──
let envFetched = false;
async function fetchLiveEnv(lat, lng) {
  if (envFetched) return;
  envFetched = true;
  try {
    const [wRes, aqiRes] = await Promise.all([
      fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}&current=temperature_2m,apparent_temperature,wind_speed_10m,relative_humidity_2m`),
      fetch(`https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${lat}&longitude=${lng}&current=us_aqi`),
    ]);
    const wd = await wRes.json(), ad = await aqiRes.json();
    const t   = Math.round(wd.current.apparent_temperature);
    const aqi = ad.current.us_aqi;
    document.getElementById('badgeTemp').textContent       = `${t}°C`;
    document.getElementById('badgeAqi').textContent        = `AQI ${aqi}`;
    document.getElementById('modalRealTemp').textContent   = `${Math.round(wd.current.temperature_2m)}°C`;
    document.getElementById('modalFeelsTemp').textContent  = `${t}°C`;
    document.getElementById('modalWind').textContent       = `${wd.current.wind_speed_10m} km/h`;
    document.getElementById('modalHumid').textContent      = `${wd.current.relative_humidity_2m}%`;
    document.getElementById('modalAqiVal').textContent     = aqi;
    document.getElementById('modalAqiDesc').textContent    = aqiDesc(aqi);
  } catch { envFetched = false; }
}
function aqiDesc(v) {
  if (v<=50) return '🟢 Good — safe to walk';
  if (v<=100) return '🟡 Moderate — OK for most';
  if (v<=150) return '🟠 Unhealthy for sensitive groups';
  if (v<=200) return '🔴 Unhealthy — limit outdoor time';
  return '🟣 Very unhealthy — stay indoors';
}

// ── TRANSIT DATA READINESS ──
function pollBusData() {
  const check = setInterval(() => {
    if (typeof BusEngine !== 'undefined' && BusEngine.busDataReady()) {
      clearInterval(check);
      console.log(`✅ Bus GTFS: ${Object.keys(BUS_STOPS_V2).length} stops, ${Object.keys(BUS_ROUTES_P1).length} routes`);
    }
  }, 300);
}
function getNearestBusStops(lat, lng, n=5, km=0.8) {
  return (typeof BusEngine !== 'undefined' && BusEngine.busDataReady())
    ? BusEngine.getNearestBusStops(lat, lng, n, km)
    : [];
}

// Refresh transit stops based on current map view
function refreshTransitOnView(lat, lng, zoom) {
  stationLayer.clearLayers();

  // Scale radius and count by zoom level
  const busRadius   = zoom >= 17 ? 0.3 : zoom >= 15 ? 0.5 : 0.8;
  const busCount    = zoom >= 17 ? 10  : zoom >= 15 ? 8   : 6;
  const metroRadius = zoom >= 15 ? 1.0 : 1.8;
  const metroCount  = zoom >= 15 ? 6   : 4;

  // Bus stops
  if (typeof BusEngine !== 'undefined' && BusEngine.busDataReady()) {
    BusEngine.getNearestBusStops(lat, lng, busCount, busRadius).forEach(s => {
      const ico = L.divIcon({ className:'',
        html:`<div style="background:white;border:2px solid #d97706;border-radius:50%;width:${zoom>=16?22:18}px;height:${zoom>=16?22:18}px;display:flex;align-items:center;justify-content:center;font-size:11px;box-shadow:0 2px 6px rgba(0,0,0,.25);">🚏</div>`,
        iconSize:[20,20], iconAnchor:[10,10] });
      const marker = L.marker([s.lat,s.lng],{icon:ico}).addTo(stationLayer);
      // Immediate content — no "tap again" needed
      marker.bindPopup(`<div style="min-width:160px;"><b>🚏 ${s.name}</b><br><small style="color:#94a3b8">Loading schedule…</small></div>`, {maxWidth:320});
      marker.on('popupopen', async () => {
        const html = await BusEngine.buildStopInfoHtml(s.id, s.name, 'bus');
        marker.getPopup().setContent(html).update();
      });
    });
  }

  // Metro stations
  if (typeof MetroEngine !== 'undefined') {
    MetroEngine.getNearestMetroStations(lat, lng, metroCount, metroRadius).forEach(s => {
      const color = MetroEngine.parseLineColor(
        Object.values(METRO_DATA?.routes||{}).find(r=>
          METRO_DATA.route_stops[Object.keys(METRO_DATA.routes).find(k=>METRO_DATA.routes[k]===r)]?.includes(String(s.id))
        )?.name || ''
      ) || '#1565c0';
      const ico = L.divIcon({ className:'',
        html:`<div style="background:${color};border:2px solid white;border-radius:5px;padding:3px 6px;font-size:10px;font-weight:800;color:white;white-space:nowrap;box-shadow:0 2px 6px rgba(0,0,0,.35);">🚇 ${zoom>=16?s.name:''}</div>`,
        iconSize:[null,null] });
      const marker = L.marker([s.lat,s.lng],{icon:ico}).addTo(stationLayer);
      marker.bindPopup(`<div style="min-width:160px;"><b>🚇 ${s.name}</b><br><small style="color:#94a3b8">Loading schedule…</small></div>`, {maxWidth:320});
      marker.on('popupopen', async () => {
        const html = await MetroEngine.buildMetroStopInfoHtml(s.id, s.name);
        marker.getPopup().setContent(html).update();
      });
    });
  }
}

// Show transit near GPS location (called on first fix)
function showNearbyTransit(lat, lng) {
  refreshTransitOnView(lat, lng, map.getZoom() || 15);
}

// ── SURFACE AI + ENV UPDATE ──
function handleMotion(event) {
  if (!isLiveTracking) return;
  const z = event.accelerationIncludingGravity?.z ?? 0;
  const x = event.accelerationIncludingGravity?.x ?? 0;
  const y = event.accelerationIncludingGravity?.y ?? 0;
  const now = Date.now();

  const lastPeak = peakTimestamps[peakTimestamps.length-1] || 0;
  if (z > 11 && (now - lastPeak) > 300) {
    liveSteps++;
    peakTimestamps.push(now);
    if (peakTimestamps.length > 10) peakTimestamps.shift();
    document.getElementById('liveStepCount').textContent = liveSteps;
    document.getElementById('liveCals').textContent = Math.round(liveSteps * 0.04);
  }

  motionDataZ.push(z); motionDataX.push(x); motionDataY.push(y);

  if (motionDataZ.length >= 60) {
    const result = Env.analyzeSurface(motionDataZ, motionDataX, motionDataY);
    motionDataZ=[]; motionDataX=[]; motionDataY=[];
    if (result && result.surfaceClass !== 'unknown') {
      const changed = result.surface !== lastKnownSurface;
      lastKnownSurface = result.surface;
      lastSurfaceResult = result;
      updateSurfaceReadout();
      if (changed) {
        showToast(`Surface: ${result.surface} — ${result.footpathLabel}`);
        if (result.surfaceClass === 'rough') {
          walkabilityBase = Math.max(30, walkabilityBase - 3);
          updateHudScore();
        }
        if ((result.quality === 'Poor' || result.quality === 'Very Poor') &&
             document.getElementById('surfacePromptToggle')?.checked) {
          document.getElementById('surfaceModalDesc').textContent =
            `AI detected: ${result.surface} (${result.footpathLabel}). Width est. ${result.width}. Log it?`;
          setTimeout(() => openModal('surfaceModal'), 500);
        }
      }
    }
  }
}

function updateSurfaceReadout() {
  const el = document.getElementById('surfaceReadout');
  if (!el) return;
  const lat = userLoc ? userLoc.lat : 28.6139;
  const lng = userLoc ? userLoc.lng : 77.2090;
  if (!lastSurfaceResult && !isLiveTracking) {
    el.innerHTML = '<div class="surface-idle">Start walking to detect surface · canopy · lighting</div>';
    return;
  }
  el.innerHTML = Env.buildSurfaceReadoutHtml(lastSurfaceResult, lat, lng);
}

function updateHudScore() {
  const el = document.getElementById('hudScore');
  const lat = userLoc ? userLoc.lat : 28.6139;
  const lng = userLoc ? userLoc.lng : 77.2090;
  const score = Env.computeWalkabilityScore(walkabilityBase, localHazards, lastSurfaceResult, lat, lng);
  if (el) el.textContent = score;
}

// ── SEARCH A→B ──
function initSearchBoxes() {
  const fromInput = document.getElementById('inputFrom');
  const toInput   = document.getElementById('inputTo');

  fromInput.addEventListener('input', () => {
    clearTimeout(searchTimerFrom);
    const v = fromInput.value.trim();
    if (v.length < 3) return closeDropdown();
    searchTimerFrom = setTimeout(() => doSearch(v, 'from'), 320);
  });
  fromInput.addEventListener('focus', () => { if (!fromInput.value) showGpsOption(); });

  toInput.addEventListener('input', () => {
    clearTimeout(searchTimerTo);
    const v = toInput.value.trim();
    if (v.length < 3) return closeDropdown();
    searchTimerTo = setTimeout(() => doSearch(v, 'to'), 320);
  });

  document.addEventListener('click', e => {
    if (!e.target.closest('#searchBox') && !e.target.closest('#resultsDropdown')) closeDropdown();
  });
}

function showGpsOption() {
  const dd = document.getElementById('resultsDropdown');
  dd.innerHTML = `<div class="result-item" onclick="useMyLocation()">
    <div><div class="result-name">📍 My Current Location</div><div class="result-sub">Use live GPS</div></div>
    <div class="result-gps">GPS</div></div>`;
  dd.classList.add('open');
}

async function doSearch(q, field) {
  try {
    const ref = userLoc ? `&lat=${userLoc.lat}&lon=${userLoc.lng}` : '';
    const r = await fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(q)}&countrycodes=in&limit=5${ref}`);
    const data = await r.json();
    const dd = document.getElementById('resultsDropdown');
    if (!data.length) { closeDropdown(); return; }

    let html = field === 'from'
      ? `<div class="result-item" onclick="useMyLocation()"><div><div class="result-name">📍 My Current Location</div><div class="result-sub">Use live GPS</div></div><div class="result-gps">GPS</div></div>`
      : '';
    html += data.map(item => {
      const parts = item.display_name.split(',');
      const dist  = userLoc ? (L.latLng(item.lat, item.lon).distanceTo(userLoc)/1000).toFixed(1)+' km' : '--';
      const fn    = field==='from'
        ? `setOrigin(${item.lat},${item.lon},'${parts[0].replace(/'/g,"\\'")}')`
        : `setDest(${item.lat},${item.lon},'${parts[0].replace(/'/g,"\\'")}')`;
      return `<div class="result-item" onclick="${fn}">
        <div><div class="result-name">${parts[0]}</div><div class="result-sub">${parts.slice(1,3).join(', ')}</div></div>
        <div class="result-dist">${dist}</div></div>`;
    }).join('');
    dd.innerHTML = html; dd.classList.add('open');
  } catch {}
}

function closeDropdown() { document.getElementById('resultsDropdown').classList.remove('open'); }

function setOrigin(lat, lon, name) {
  activeOriginLatLng = L.latLng(lat, lon); activeOriginName = name;
  document.getElementById('inputFrom').value = name;
  closeDropdown();
  if (originMarker) map.removeLayer(originMarker);
  const ico = L.divIcon({ className:'',
    html:`<div style="background:#16a34a;width:14px;height:14px;border-radius:50%;border:3px solid white;box-shadow:0 2px 6px rgba(0,0,0,.3);"></div>`,
    iconSize:[14,14], iconAnchor:[7,7] });
  originMarker = L.marker(activeOriginLatLng,{icon:ico}).addTo(map).bindPopup(`<b>From:</b> ${name}`);
  map.flyTo(activeOriginLatLng, 14);
  tryPrepare();
}

function setDest(lat, lon, name) {
  activeDestLatLng = L.latLng(lat, lon); activeDestName = name;
  document.getElementById('inputTo').value = name;
  closeDropdown(); tryPrepare();
}

function swapLocations() {
  const oL=activeOriginLatLng, oN=activeOriginName, dL=activeDestLatLng, dN=activeDestName;
  if (dL) setOrigin(dL.lat, dL.lng, dN); else useMyLocation();
  if (oL) setDest(oL.lat, oL.lng, oN); else { activeDestLatLng=null; document.getElementById('inputTo').value=''; }
  showToast('Swapped ↕');
}

function tryPrepare() {
  const from = activeOriginLatLng || userLoc;
  if (from && activeDestLatLng) prepareComparison(from, activeDestLatLng);
}

// ── ROUTE COMPARISON ──
function prepareComparison(fromLL, toLL) {
  clearRoute(false);
  walkabilityBase = 100; cachedMetroPlan = null; window._cachedBusJourney = null;

  const baseDist  = (fromLL.distanceTo(toLL) / 1000) * 1.3;
  const hazardPen = localHazards.reduce((a, h) => a + Math.abs(Env.HAZARD_SCORE_MAP[h.type] || 5), 0);
  const baseScore = Math.max(40, 100 - Math.round(baseDist*6) - hazardPen);

  simData = {
    walk:    { dist: baseDist,       score: baseScore,              mode:'walk' },
    safe:    { dist: baseDist*1.15,  score: Math.min(98,baseScore+12), mode:'safe' },
    transit: { dist: baseDist,       score: 80,                     mode:'transit' },
  };

  document.getElementById('metaWalk').textContent  = `${Math.ceil(simData.walk.dist*12)} min · ${simData.walk.dist.toFixed(1)} km`;
  document.getElementById('scoreWalk').textContent = simData.walk.score;
  document.getElementById('metaSafe').textContent  = `${Math.ceil(simData.safe.dist*13)} min · ${simData.safe.dist.toFixed(1)} km`;
  document.getElementById('scoreSafe').textContent = simData.safe.score;

  const busEl    = document.getElementById('nearestBusInfo');
  const busLabel = document.getElementById('busOptLabel');

  // 1. Try metro first
  if (typeof MetroEngine !== 'undefined' && typeof METRO_DATA !== 'undefined') {
    const nf = MetroEngine.getNearestMetroStations(fromLL.lat, fromLL.lng, 3, 2.5);
    const nt = MetroEngine.getNearestMetroStations(toLL.lat, toLL.lng, 3, 2.5);
    outer: for (const f of nf) {
      for (const t of nt) {
        if (f.id === t.id) continue;
        const plan = MetroEngine.planMetroJourney(f.id, t.id);
        if (plan) {
          cachedMetroPlan = { plan, boardStop:f, alightStop:t, walkInKm:f.dist, walkOutKm:t.dist };
          const totalStops = plan.filter(l=>l.type==='metro').reduce((a,l)=>a+l.numStops,0);
          const metroMin   = Math.round(f.dist*12) + totalStops*2 + Math.round(t.dist*12) + 4;
          document.getElementById('metaBus').textContent  = `🚇 ${metroMin} min · ${totalStops} stops`;
          document.getElementById('scoreBus').textContent = 92;
          if (busLabel) busLabel.textContent = '🚇 Metro Route';
          if (busEl) { busEl.innerHTML=`🚉 <b>${f.name}</b> → <b>${t.name}</b>`; busEl.style.display='block'; }
          break outer;
        }
      }
    }
  }

  // 2. Try real bus
  if (!cachedMetroPlan) {
    if (typeof BusEngine !== 'undefined' && BusEngine.busDataReady()) {
      const bj = BusEngine.findBusRoutes(fromLL.lat, fromLL.lng, toLL.lat, toLL.lng);
      if (bj && bj.type === 'direct') {
        const opt = bj.options[0];
        const approxMin = Math.round(bj.walkInKm*12) + opt.numStops*2 + Math.round(bj.walkOutKm*12) + 6;
        document.getElementById('metaBus').textContent  = `🚌 ${approxMin} min · ${opt.numStops} stops`;
        document.getElementById('scoreBus').textContent = 78;
        if (busLabel) busLabel.textContent = '🚌 Real Bus Route';
        if (busEl) { busEl.innerHTML=`🚌 <b>${opt.routeName}</b> · Board: ${opt.boardStop.name}`; busEl.style.display='block'; }
        window._cachedBusJourney = bj;
      } else {
        document.getElementById('metaBus').textContent  = `${Math.ceil(simData.transit.dist*4)+8} min · ${simData.transit.dist.toFixed(1)} km`;
        document.getElementById('scoreBus').textContent = simData.transit.score;
        if (busLabel) busLabel.textContent = '🚌 Public Bus';
        const s = getNearestBusStops(fromLL.lat, fromLL.lng, 1, 1.0);
        if (busEl && s.length) { busEl.textContent=`🚏 Nearest stop: ${s[0].name} (${(s[0].dist*1000).toFixed(0)}m)`; busEl.style.display='block'; }
      }
    } else {
      document.getElementById('metaBus').textContent  = `${Math.ceil(simData.transit.dist*4)+8} min · ${simData.transit.dist.toFixed(1)} km`;
      document.getElementById('scoreBus').textContent = simData.transit.score;
      if (busLabel) busLabel.textContent = '🚌 Public Bus';
    }
  }

  interactiveLayer.clearLayers();
  L.marker(toLL).addTo(interactiveLayer).bindPopup(`<b>To:</b> ${activeDestName}`);
  map.flyTo(toLL, 14);
  document.getElementById('routeCard').classList.add('active');
}

// ── ROUTING ──
async function pickRoute(type) {
  document.getElementById('routeCard').classList.remove('active');
  interactiveLayer.clearLayers(); transitLayer.clearLayers();
  currentRouteMode = type;
  const from = activeOriginLatLng || userLoc;
  if (!from || !activeDestLatLng) { showToast('Set both locations first'); return; }
  showToast('Calculating route…');
  try {
    const url = `https://routing.openstreetmap.de/routed-foot/route/v1/foot/${from.lng},${from.lat};${activeDestLatLng.lng},${activeDestLatLng.lat}?overview=full&geometries=geojson&steps=true`;
    const res = await fetch(url);
    const d   = await res.json();
    showHud(type, d.routes[0], from);
  } catch { showToast('Routing failed — check connection'); }
}

// ── HUD ──
function showHud(type, route, fromLL) {
  const hud = document.getElementById('hud');
  hud.classList.add('active'); isMinimized = false; hud.classList.remove('mini');

  const rd     = simData[type] || simData.walk;
  const steps  = route.legs[0].steps;
  const coords = route.geometry.coordinates.map(c => [c[1], c[0]]);
  routeCoordsData = { footpaths:[], bridges:[], underpasses:[], crossings:[] };
  let itinHtml = '';

  steps.forEach((step, i) => {
    const loc  = [step.maneuver.location[1], step.maneuver.location[0]];
    const road = step.name ? `onto ${step.name}` : 'forward';
    const dir  = step.maneuver.modifier ? step.maneuver.modifier.replace('-',' ') : '';
    const act  = step.maneuver.type==='turn' ? `Turn ${dir}` : (i===0 ? 'Start walking' : 'Continue');
    const instr = `${act} ${road}`.trim();
    const low   = instr.toLowerCase();

    // Enrich with footpath type from Env
    const enriched = Env.enrichStep(instr, null);

    let classKey = 'footpaths';
    if      (low.includes('bridge')||low.includes('flyover')) { routeCoordsData.bridges.push(loc);    classKey='bridges'; }
    else if (low.includes('underpass'))                        { routeCoordsData.underpasses.push(loc); classKey='underpasses'; }
    else if (low.includes('cross')||low.includes('intersection')){ routeCoordsData.crossings.push(loc); classKey='crossings'; }
    else                                                        routeCoordsData.footpaths.push(loc);

    itinHtml += `<div class="step-row" onclick="zoomToStep(${loc[0]},${loc[1]})">
      <span class="step-icon">${enriched.emoji}</span>
      <span class="step-txt">${instr}</span>
      <span class="step-m">${Math.round(step.distance)}m</span></div>`;
  });

  document.getElementById('cntFoot').textContent   = routeCoordsData.footpaths.length;
  document.getElementById('cntCross').textContent  = routeCoordsData.crossings.length;
  document.getElementById('cntBridge').textContent = routeCoordsData.bridges.length;
  document.getElementById('cntUnder').textContent  = routeCoordsData.underpasses.length;

  walkabilityBase = rd.score;
  updateHudScore();
  document.getElementById('hudScore').style.color =
    type==='safe' ? 'var(--safe)' : type==='transit' ? 'var(--transit)' : 'var(--primary)';

  const estSteps = Math.round((rd.dist*1000)/0.762);
  const estCals  = Math.round((rd.dist*1000)*0.05);

  if (type==='transit') {
    document.getElementById('hudTime').textContent = `${Math.ceil(rd.dist*4)+8} min`;
    document.getElementById('hudTime').style.color = 'var(--transit)';
  } else {
    document.getElementById('hudTime').textContent = `${Math.ceil(rd.dist*12)} min`;
    document.getElementById('hudTime').style.color = 'var(--text)';
  }
  document.getElementById('hudDist').textContent  = `${rd.dist.toFixed(2)} km`;
  document.getElementById('hudSteps').textContent = estSteps.toLocaleString();
  document.getElementById('hudCals').textContent  = estCals.toLocaleString();

  const stepsBox    = document.getElementById('stepsBox');
  const transitWrap = document.getElementById('transitWrap');
  if (type !== 'transit') {
    stepsBox.innerHTML = itinHtml; stepsBox.style.display='block'; transitWrap.style.display='none';
  } else {
    stepsBox.style.display='none'; transitWrap.style.display='block';
    buildTransitView(coords, steps, rd);
  }

  if (type !== 'transit') {
    const color = type==='safe' ? '#7c3aed' : '#2563eb';
    const dash  = type==='walk' ? '10,8' : '';
    const poly  = L.polyline(coords, { color, weight:6, opacity:.9, dashArray:dash }).addTo(interactiveLayer);
    const oIco  = L.divIcon({ className:'',
      html:`<div style="background:#16a34a;width:14px;height:14px;border-radius:50%;border:3px solid white;box-shadow:0 2px 6px rgba(0,0,0,.3);"></div>`,
      iconSize:[14,14], iconAnchor:[7,7] });
    L.marker(coords[0],{icon:oIco}).addTo(interactiveLayer).bindPopup(`<b>From:</b> ${activeOriginName||'My Location'}`);
    L.marker(coords[coords.length-1]).addTo(interactiveLayer).bindPopup(`<b>To:</b> ${activeDestName}`);
    map.fitBounds(poly.getBounds(), { padding:[50,50] });
  }

  updateSurfaceReadout();
  if (document.getElementById('voiceToggle')?.checked && 'speechSynthesis' in window) {
    const label = type==='transit' ? 'transit route' : type==='safe' ? 'safest walk' : 'shortest walk';
    speechSynthesis.speak(new SpeechSynthesisUtterance(`Route: ${label}. ${Math.ceil(rd.dist*12)} minutes.`));
  }
}

// ── TRANSIT VIEW ──
async function buildTransitView(coords, steps, rd) {
  const tw = document.getElementById('transitWrap');
  const n  = steps.length;

  const mkS = list => list.map(s => {
    const road = s.name ? `onto ${s.name}` : 'forward';
    const dir  = s.maneuver.modifier ? s.maneuver.modifier.replace('-',' ') : '';
    const act  = s.maneuver.type==='turn' ? `Turn ${dir}` : 'Continue';
    return `<div style="display:flex;gap:8px;padding:5px 0;border-bottom:1px solid rgba(0,0,0,.04);font-size:11px;font-weight:600;">
      <span>🚶</span><span style="flex:1;text-transform:capitalize;">${act} ${road}</span>
      <span style="color:#2563eb;font-weight:800;">${Math.round(s.distance)}m</span></div>`;
  }).join('');

  // ── METRO ──
  if (cachedMetroPlan) {
    const { plan, boardStop, alightStop, walkInKm, walkOutKm } = cachedMetroPlan;
    const { html:metroHtml, approxMin, totalMetroStops } =
      await MetroEngine.buildMetroHudHtml(plan, activeOriginName, activeDestName, walkInKm, walkOutKm);

    const p1 = Math.max(1, Math.min(Math.floor(coords.length*(walkInKm/(rd.dist+.01))), coords.length-2));
    const p2 = Math.max(p1+1, Math.min(Math.floor(coords.length*(1-walkOutKm/(rd.dist+.01))), coords.length-1));

    L.polyline(coords.slice(0,p1), { color:'#2563eb', weight:5, dashArray:'8,8' }).addTo(transitLayer);
    L.polyline(coords.slice(p2),   { color:'#2563eb', weight:5, dashArray:'8,8' }).addTo(transitLayer);
    MetroEngine.drawMetroRoute(plan, transitLayer);

    const mkStn = (ll, label, c) => {
      const ico = L.divIcon({ className:'', iconSize:[null,null],
        html:`<div style="background:${c};border:2px solid white;border-radius:4px;padding:2px 5px;font-size:10px;font-weight:800;color:white;white-space:nowrap;box-shadow:0 2px 6px rgba(0,0,0,.3);">${label}</div>` });
      return L.marker(ll, { icon:ico });
    };
    mkStn([boardStop.lat,boardStop.lng], `🚇 ${boardStop.name}`, '#1565c0').addTo(stationLayer);
    mkStn([alightStop.lat,alightStop.lng], `🚇 ${alightStop.name}`, '#8e24aa').addTo(stationLayer);
    map.fitBounds(L.latLngBounds([...coords,[boardStop.lat,boardStop.lng],[alightStop.lat,alightStop.lng]]), { padding:[50,50] });
    document.getElementById('hudTime').textContent = `${approxMin} min`;

    tw.innerHTML = `
      <div style="background:rgba(37,99,235,.05);padding:10px;border-radius:10px;margin-bottom:8px;">
        <div style="font-size:10px;font-weight:800;text-transform:uppercase;color:#2563eb;margin-bottom:6px;">🚶 Walk to Metro (${(walkInKm*1000).toFixed(0)}m)</div>
        ${mkS(steps.slice(0,Math.max(1,Math.floor(n*.15))))}
      </div>
      <div style="background:#e8f0fe;padding:12px;border-radius:10px;border-left:4px solid #1565c0;margin-bottom:8px;">
        <div style="font-size:10px;font-weight:800;text-transform:uppercase;color:#1565c0;margin-bottom:8px;">🚇 Delhi Metro · ${totalMetroStops} stops · ~${approxMin} min</div>
        ${metroHtml}
      </div>
      <div style="background:rgba(37,99,235,.05);padding:10px;border-radius:10px;">
        <div style="font-size:10px;font-weight:800;text-transform:uppercase;color:#2563eb;margin-bottom:6px;">🚶 Walk to Destination (${(walkOutKm*1000).toFixed(0)}m)</div>
        ${mkS(steps.slice(Math.floor(n*.85)))}
      </div>`;
    return;
  }

  // ── BUS ──
  const p1 = Math.floor(coords.length*.15);
  const p2 = Math.floor(coords.length*.82);
  L.polyline(coords.slice(0,p1),  { color:'#2563eb', weight:5, dashArray:'8,8' }).addTo(transitLayer);
  L.polyline(coords.slice(p2),    { color:'#2563eb', weight:5, dashArray:'8,8' }).addTo(transitLayer);
  map.fitBounds(L.polyline(coords).getBounds(), { padding:[50,50] });

  const busJourney = window._cachedBusJourney;
  let busCardHtml = '';

  if (busJourney && busJourney.type === 'direct') {
    const built = await BusEngine.buildBusHudHtml(busJourney);
    busCardHtml = built.html;
    L.polyline(coords.slice(Math.max(0,p1-1),p2+1), { color:built.agencyColor, weight:8, opacity:.9 }).addTo(transitLayer);
    const mkLbl = (ll, label, c) => {
      const ico = L.divIcon({ className:'', iconSize:[null,null],
        html:`<div style="background:${c};border:2px solid white;border-radius:6px;padding:2px 6px;font-size:9px;font-weight:800;color:white;white-space:nowrap;box-shadow:0 2px 5px rgba(0,0,0,.3);">${label}</div>` });
      return L.marker(ll, { icon:ico });
    };
    if (built.boardStop?.lat) mkLbl([built.boardStop.lat,built.boardStop.lng], `🚏 ${built.boardStop.name}`, built.agencyColor).addTo(stationLayer);
    if (built.alightStop?.lat) mkLbl([built.alightStop.lat,built.alightStop.lng], `🚏 ${built.alightStop.name}`, '#475569').addTo(stationLayer);
    document.getElementById('hudTime').textContent = `${built.approxMin} min`;
  } else {
    const eta  = Math.floor(Math.random()*8)+4;
    const next = new Date(Date.now()+eta*60000).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});
    const ns   = getNearestBusStops(coords[p1][0], coords[p1][1], 1, 0.8);
    const sn   = ns.length ? ns[0].name : 'Nearest Bus Stop';
    L.polyline(coords.slice(Math.max(0,p1-1),p2+1), { color:'#d97706', weight:8, opacity:.9 }).addTo(transitLayer);
    busCardHtml = `<div style="background:white;padding:12px;border-radius:10px;border:1px solid #e2e8f0;margin-bottom:8px;">
      <div style="display:flex;align-items:center;gap:10px;">
        <span style="font-size:24px;">🚌</span>
        <div style="flex:1;"><div style="font-size:13px;font-weight:800;color:#d97706;">DTC / DIMTS Bus</div><div style="font-size:10px;color:#64748b;">Board near: ${sn}</div></div>
        <div style="text-align:right;"><div style="font-size:12px;font-weight:800;color:#dc2626;">~${eta} min</div><div style="font-size:10px;color:#64748b;">Next: ${next}</div></div>
      </div></div>`;
  }

  tw.innerHTML = `
    <div style="background:rgba(37,99,235,.05);padding:10px;border-radius:10px;margin-bottom:8px;">
      <div style="font-size:10px;font-weight:800;text-transform:uppercase;color:#2563eb;margin-bottom:6px;">🚶 Walk to Stop</div>
      ${mkS(steps.slice(0,Math.max(1,Math.floor(n*.15))))}
    </div>
    ${busCardHtml}
    <div style="background:rgba(37,99,235,.05);padding:10px;border-radius:10px;">
      <div style="font-size:10px;font-weight:800;text-transform:uppercase;color:#2563eb;margin-bottom:6px;">🚶 Walk to Destination</div>
      ${mkS(steps.slice(Math.floor(n*.85)))}
    </div>`;
}

// ── LIVE NAV ──
function startLive() {
  const from = activeOriginLatLng || userLoc;
  if (!from) { showToast('Awaiting GPS…'); return; }
  isLiveTracking=true; liveSteps=0; peakTimestamps=[];
  motionDataZ=[]; motionDataX=[]; motionDataY=[];
  document.getElementById('healthBar').style.display='none';
  document.getElementById('liveBar').style.display='flex';
  document.getElementById('btnStart').style.display='none';
  document.getElementById('btnStop').style.display='block';
  if (!isMinimized) toggleMini();
  map.flyTo(from, 19, { animate:true, duration:1.5 });
  if (typeof DeviceMotionEvent!=='undefined' && typeof DeviceMotionEvent.requestPermission==='function') {
    DeviceMotionEvent.requestPermission().then(s => { if(s==='granted') window.addEventListener('devicemotion',handleMotion,true); }).catch(()=>{});
  } else {
    window.addEventListener('devicemotion', handleMotion, true);
  }
  if (document.getElementById('voiceToggle')?.checked && 'speechSynthesis' in window)
    speechSynthesis.speak(new SpeechSynthesisUtterance('Live navigation started.'));
  showToast('Live navigation active');
}

function stopLive() {
  isLiveTracking=false;
  window.removeEventListener('devicemotion', handleMotion, true);
  document.getElementById('healthBar').style.display='flex';
  document.getElementById('liveBar').style.display='none';
  document.getElementById('btnStart').style.display='block';
  document.getElementById('btnStop').style.display='none';
  if (isMinimized) toggleMini();
  const finalSteps = liveSteps;
  const finalCals  = Math.round(liveSteps * 0.04);
  showToast(`Walk done! ${finalSteps} steps · ${finalCals} kcal`);
  const vSteps = document.getElementById('vLifetimeSteps');
  if (vSteps) vSteps.textContent = (parseInt(vSteps.textContent.replace(/,/g,'')||0)+finalSteps).toLocaleString();
  // Save completed route to DB
  const rd = simData[currentRouteMode] || simData.walk;
  if (rd && activeDestLatLng) {
    const from = activeOriginLatLng || userLoc;
    saveRouteToDB({
      from_name:    activeOriginName || 'My Location',
      to_name:      activeDestName   || 'Destination',
      from_lat:     from?.lat, from_lng: from?.lng,
      to_lat:       activeDestLatLng.lat, to_lng: activeDestLatLng.lng,
      mode:         currentRouteMode,
      dist_km:      parseFloat(rd.dist.toFixed(2)),
      duration_min: Math.ceil(rd.dist * 12),
      steps:        finalSteps || Math.round((rd.dist*1000)/0.762),
      calories:     finalCals  || Math.round((rd.dist*1000)*0.05),
      walk_score:   parseInt(document.getElementById('hudScore').textContent) || rd.score,
      surface_log:  { history: surfaceHistory.slice(-3).map(s=>({surface:s.surface,width:s.width})) },
    });
  }
}

// ── HAZARD MARKING ──
function quickHazard(type) {
  const loc = userLoc;
  if (!loc) { showToast('Waiting for GPS…'); return; }
  closeModal('hazardModal');
  const ico = L.divIcon({ className:'',
    html:`<div style="background:#dc2626;width:14px;height:14px;border-radius:50%;border:2px solid white;box-shadow:0 0 0 4px rgba(220,38,38,.3);"></div>`,
    iconSize:[14,14], iconAnchor:[7,7] });
  L.marker(loc,{icon:ico}).addTo(hazardLayer).bindPopup(`<b>${type}</b>`).openPopup();
  localHazards.push({ type, lat:loc.lat, lng:loc.lng, ts:Date.now() });
  Env.addEnvironmentReport(type, loc.lat, loc.lng);
  updateHudScore();
  addIntelCard(type, loc.lat, loc.lng);
  showToast(`Logged: ${type}`);
  refreshVaultStats();
  // Save to DB with environment context
  saveHazardToDB(type, loc.lat, loc.lng, {
    surface:        lastSurfaceResult?.surface || null,
    canopy:         Env.getCanopy(),
    lighting:       Env.getLighting(),
    footpath_type:  lastSurfaceResult?.footpathType || null,
    footpath_width: lastSurfaceResult?.width || null,
  });
}

function addIntelCard(type, lat, lng) {
  const list = document.getElementById('intelFeedList');
  if (!list) return;
  // Remove empty state if present
  const empty = list.querySelector('.empty-state');
  if (empty) empty.remove();
  const card = document.createElement('div');
  card.style.cssText = 'background:white;border-radius:14px;padding:14px;margin-bottom:10px;border:1px solid rgba(0,0,0,.07);';
  card.innerHTML = `
    <span style="display:inline-block;background:rgba(220,38,38,.1);color:#dc2626;padding:3px 8px;border-radius:6px;font-size:10px;font-weight:800;margin-bottom:6px;">${type}</span>
    <div style="font-size:13px;font-weight:700;">📍 ${lat.toFixed(4)}, ${lng.toFixed(4)}</div>
    <div style="font-size:11px;color:#64748b;margin-top:2px;">Just now · You</div>`;
  list.prepend(card);
}

// ── PHOTO + AI ──
async function processPhoto(event) {
  const file = event.target.files[0]; if (!file) return;
  const st = document.getElementById('ocrStatus');
  st.textContent = 'Compressing…';
  const reader = new FileReader();
  reader.onload = async ev => {
    const img = new Image();
    img.onload = async () => {
      const cv=document.getElementById('photoCanvas'), ctx=cv.getContext('2d');
      cv.width=400; cv.height=(img.height/img.width)*400;
      ctx.drawImage(img,0,0,cv.width,cv.height);
      const b64 = cv.toDataURL('image/jpeg',.7).split(',')[1];
      st.textContent = 'AI analysing…';
      try {
        const res  = await fetch('/api/vision',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({image_b64:b64})});
        const data = await res.json();
        const label = data.label || 'Unknown hazard';
        st.textContent = `✔ ${label}`;
        setTimeout(() => { quickHazard(`📸 ${label}`); st.textContent=''; closeModal('hazardModal'); }, 1500);
      } catch {
        st.textContent = 'AI unavailable';
        setTimeout(() => { quickHazard('📸 Photo Hazard'); st.textContent=''; closeModal('hazardModal'); }, 1200);
      }
    };
    img.src = ev.target.result;
  };
  reader.readAsDataURL(file);
}

function confirmSurface(action) {
  closeModal('surfaceModal');
  if (action === 'log') quickHazard(`🪨 ${lastKnownSurface} (AI detected)`);
  else showToast('Surface noted — not logged');
}

// ── INFRA / MAP ──
function zoomInfra(type) {
  const arr = routeCoordsData[type];
  if (!arr || !arr.length) { showToast(`No ${type} on this route`); return; }
  const colors = { footpaths:'#2563eb', crossings:'#d97706', bridges:'#92400e', underpasses:'#7c3aed' };
  arr.forEach(c => L.circleMarker(L.latLng(c[0],c[1]), { radius:10, color:'white', weight:2, fillColor:colors[type], fillOpacity:.9 }).addTo(interactiveLayer));
  map.fitBounds(L.latLngBounds(arr.map(c=>L.latLng(c[0],c[1]))), { padding:[50,50], maxZoom:17 });
}
function zoomToStep(lat, lng) { map.flyTo([lat,lng], 18, { animate:true, duration:1 }); }

function clearRoute(clearInputs) {
  interactiveLayer.clearLayers(); transitLayer.clearLayers();
  document.getElementById('hud').classList.remove('active');
  document.getElementById('routeCard').classList.remove('active');
  if (isLiveTracking) stopLive();
  if (userMarker) userMarker.addTo(map);
  if (originMarker) originMarker.addTo(map);
  if (clearInputs) {
    document.getElementById('inputFrom').value=''; document.getElementById('inputTo').value='';
    activeOriginLatLng=null; activeOriginName=''; activeDestLatLng=null; activeDestName='';
    if (originMarker) { map.removeLayer(originMarker); originMarker=null; }
    document.getElementById('nearestBusInfo').style.display='none';
    cachedMetroPlan=null; window._cachedBusJourney=null;
  }
}

function toggleMini() {
  isMinimized = !isMinimized;
  document.getElementById('hud').classList.toggle('mini', isMinimized);
}

function toggleTrees() {
  if (treeLayer) { map.removeLayer(treeLayer); treeLayer=null; showToast('Tree cover hidden'); }
  else { treeLayer=L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',{opacity:.4}).addTo(map); showToast('Tree canopy layer active'); }
}

function refreshVaultStats() {
  const el = document.getElementById('vHazards');
  if (el) el.textContent = localHazards.length;
}

// ── UTILS ──
function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent=msg; t.style.opacity='1';
  clearTimeout(t._t); t._t=setTimeout(()=>t.style.opacity='0', 3000);
}
function openModal(id)  { document.getElementById(id)?.classList.add('active'); }
function closeModal(id) { document.getElementById(id)?.classList.remove('active'); }
