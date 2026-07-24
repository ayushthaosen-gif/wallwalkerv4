'use strict';

// ── API CONFIG ──
const API = window.location.hostname === 'localhost'
  ? 'http://localhost:3000'
  : window.location.hostname.includes('github.io')
    ? 'https://wallwalkerv4.onrender.com'   // GitHub Pages → Render backend
    : '';  // Same origin on Render

// ── CITY DETECTION — decides which transit data to load ──
const CITY_BBOXES = {
  // Delhi NCR — widened to match actual transit-data coverage: bus stops extend to
  // lng 77.41 and Delhi Metro stations extend to lat 28.34 / lng 77.54 (Gurgaon,
  // Noida, Faridabad, Ghaziabad border stations), which the old narrower box was clipping.
  delhi: [28.30, 76.80, 28.90, 77.60],
  dc:    [38.79, -77.12, 38.99, -76.91],
  nyc:   [40.47, -74.26, 40.93, -73.70],
};
let detectedCity = null;
let wmataInjected = false;
let nycInjected = false;

function detectCityFromCoords(lat, lng) {
  for (const [city, [a, b, c, d]] of Object.entries(CITY_BBOXES)) {
    if (lat >= a && lat <= c && lng >= b && lng <= d) return city;
  }
  return 'unknown';
}

function applyCity(city, lat, lng) {
  if (detectedCity === city) return;
  // Clear previous city's transit markers before switching
  if (detectedCity && detectedCity !== city && typeof stationLayer !== 'undefined') {
    stationLayer.clearLayers();
    if (typeof _visibleMarkers !== 'undefined') _visibleMarkers.clear();
    if (detectedCity === 'nyc') {
      stopVehicleTracking();
      ['btnNycLayers','btnSubwayNet','btnVehicles'].forEach(id => {
        const b = document.getElementById(id); if (b) b.style.display = 'none';
      });
    }
    if (detectedCity === 'delhi') {
      stopDelhiVehicleTracking();
      ['btnDelhiVehicles','btnDelhiStreetlights','btnDelhiSubways'].forEach(id => {
        const b = document.getElementById(id); if (b) b.style.display = 'none';
      });
      if (streetlightHeatLayer) { map.removeLayer(streetlightHeatLayer); streetlightHeatLayer = null; }
      if (subwayLayer) { map.removeLayer(subwayLayer); subwayLayer = null; }
    }
    if (detectedCity === 'dc') {
      const b = document.getElementById('btnDcLayers'); if (b) b.style.display = 'none';
    }
  }
  detectedCity = city;
  localStorage.setItem('gw_city', city);
  window._searchCountry = city === 'delhi' ? 'in' : (city === 'dc' || city === 'nyc') ? 'us' : '';
  console.log(`✅ City detected: ${city}`);
  if (city === 'dc') {
    injectWmataScripts();
    setTimeout(loadDcLayers, 1500);
    const dcBtn = document.getElementById('btnDcLayers');
    if (dcBtn) dcBtn.style.display = 'block';
    if (lat && map) {
      const c = map.getCenter();
      if (Math.abs(c.lat - 28.6139) < 0.5) map.flyTo([lat, lng], 14, { animate: true, duration: 1.5 });
    }
  }
  if (city === 'nyc') {
    injectNycScripts();
    setTimeout(loadNycLayers, 1500);
    const nycBtn = document.getElementById('btnNycLayers');
    if (nycBtn) nycBtn.style.display = 'block';
    const netBtn = document.getElementById('btnSubwayNet');
    if (netBtn) netBtn.style.display = 'block';
    const vehBtn = document.getElementById('btnVehicles');
    if (vehBtn) vehBtn.style.display = 'block';
    if (lat && map) {
      const c = map.getCenter();
      if (Math.abs(c.lat - 28.6139) < 0.5) map.flyTo([lat, lng], 13, { animate: true, duration: 1.5 });
    }
  }
  if (city === 'delhi') {
    const delhiVehBtn = document.getElementById('btnDelhiVehicles');
    if (delhiVehBtn) delhiVehBtn.style.display = 'block';
    // Start live tracking (gracefully no-ops if DELHI_OTD_KEY not set)
    startDelhiVehicleTracking();
    ['btnDelhiStreetlights','btnDelhiSubways'].forEach(id => {
      const b = document.getElementById(id); if (b) b.style.display = 'block';
    });
  }
  _applyCityModeToggles(city);
}

// Auto-rickshaw is a Delhi-only mode — hide the toggle and drop it from
// enabledModes elsewhere so route comparisons for DC/NYC never show "Auto".
function _applyCityModeToggles(city) {
  const autoBtn = document.querySelector('.mode-toggle[data-mode="auto"]');
  if (city === 'delhi') {
    if (autoBtn) autoBtn.style.display = '';
    enabledModes.add('auto');
    if (autoBtn) autoBtn.classList.add('active');
  } else {
    if (autoBtn) { autoBtn.style.display = 'none'; autoBtn.classList.remove('active'); }
    enabledModes.delete('auto');
  }
}

function injectWmataScripts() {
  if (wmataInjected) return;
  wmataInjected = true;
  ['wmata_stations.js','wmata_lines.js','wmata_bus_stops.js',
   'wmata_bus_routes_p1.js','wmata_bus_routes_p2.js','wmata_park_ride.js'].forEach(src => {
    if (document.querySelector(`script[src="${src}"]`)) return;
    const s = document.createElement('script'); s.src = src; s.async = true;
    document.head.appendChild(s);
  });
  const l = document.createElement('script'); l.src = 'wmata_loader.js'; l.defer = true;
  document.head.appendChild(l);
  console.log('📦 WMATA scripts injected');
  pollWmataData();
}

function injectNycScripts() {
  if (nycInjected) return;
  nycInjected = true;
  window._nycReady = false;

  // Chain loads in order: subway data → engine → bus stops → rail stations
  function load(src, cb) {
    if (document.querySelector(`script[src="${src}"]`)) { cb(); return; }
    const s = document.createElement('script');
    s.src = src;
    s.onload = cb;
    s.onerror = () => console.warn('⚠ Failed to load', src);
    document.head.appendChild(s);
  }

  load('nyc_subway.js', () =>
    load('nyc_engine.js', () =>
      load('nyc_shapes.js', () =>
        load('nyc_bus_stops.js', () =>
          load('nyc_rail_stations.js', () => {
            window._nycReady = true;
            console.log('✅ NYC data ready — '
              + Object.keys(window.NYC_SUBWAY?.stations||{}).length + ' subway stations, '
              + Object.keys(window.NYC_BUS_STOPS||{}).length + ' bus stops, '
              + Object.keys(window.NYC_RAIL_STATIONS||{}).length + ' rail stations, '
              + Object.keys(window.NYC_SHAPES||{}).length + ' route shapes');
            const loc = userLoc || (_adminCoords ? L.latLng(_adminCoords.lat, _adminCoords.lng) : null);
            if (loc) showNearbyTransit(loc.lat, loc.lng);
            // Draw subway network lines on the map
            drawSubwayNetworkLayer();
            // Start live vehicle tracking + load alerts
            startVehicleTracking();
            _loadAlerts();
          })
        )
      )
    )
  );
  console.log('📦 NYC scripts injecting');
}

// ── IP GEOLOCATION — 3 fallback APIs, fires immediately without GPS ──
async function detectCityByIP() {
  const cached = localStorage.getItem('gw_city');
  if (cached) { applyCity(cached, null, null); return; }

  const apis = [
    async () => {
      const r = await fetch('https://ip-api.com/json/?fields=lat,lon,status', { signal: AbortSignal.timeout(3000) });
      const d = await r.json();
      if (d.status === 'success') return [d.lat, d.lon];
      throw new Error('ip-api failed');
    },
    async () => {
      const r = await fetch('https://ipapi.co/json/', { signal: AbortSignal.timeout(3000) });
      const d = await r.json();
      if (d.latitude) return [d.latitude, d.longitude];
      throw new Error('ipapi.co failed');
    },
    async () => {
      const r = await fetch('https://freeipapi.com/api/json/', { signal: AbortSignal.timeout(3000) });
      const d = await r.json();
      if (d.latitude) return [d.latitude, d.longitude];
      throw new Error('freeipapi failed');
    },
  ];

  for (const fn of apis) {
    try {
      const [lat, lng] = await fn();
      const city = detectCityFromCoords(lat, lng);
      console.log(`🌐 IP location → ${city} (${lat.toFixed(3)}, ${lng.toFixed(3)})`);
      applyCity(city, lat, lng);
      // Pre-centre map if GPS hasn't fired yet
      if (!userLoc && map && city !== 'delhi') map.setView([lat, lng], 13);
      if (!userLoc) showNearbyTransit(lat, lng);
      return;
    } catch(e) { console.warn('IP geo fallback:', e.message); }
  }
  applyCity('delhi', 28.6139, 77.2090); // ultimate fallback
}


// ══════════════════════════════════════════════
// ADMIN MODE — location override for debugging
// ══════════════════════════════════════════════
let _isAdmin      = false;
let _adminSpoofOn = false;
let _adminCoords  = null; // { lat, lng } last teleport coords

function toggleAdminKeySection() {
  const el = document.getElementById('adminKeySection');
  el.style.display = el.style.display === 'none' ? 'block' : 'none';
  if (el.style.display === 'block') setTimeout(() => document.getElementById('adminKeyInput').focus(), 50);
}

function toggleProfileAdminSection() {
  const el = document.getElementById('profileAdminSection');
  el.style.display = el.style.display === 'none' ? 'block' : 'none';
  if (el.style.display === 'block') setTimeout(() => document.getElementById('profileAdminKeyInput').focus(), 50);
}

function adminLoginFromProfile() {
  const key = (document.getElementById('profileAdminKeyInput').value || '').trim();
  const errEl = document.getElementById('profileAdminError');
  errEl.textContent = '';
  if (!key) { errEl.textContent = 'Enter the admin key'; return; }
  if (!_verifyAdminKey(key)) { errEl.textContent = 'Invalid key'; return; }
  localStorage.setItem('gw_admin_token', 'local');
  _isAdmin = true;
  document.getElementById('profileAdminKeyInput').value = '';
  closeModal('profileModal');
  _activateAdminUI();
  openModal('adminModal');
  _updateAdminStatus();
}

function _verifyAdminKey(key) {
  return key === 'flyforfun';
}

function adminLogin() {
  const key = (document.getElementById('adminKeyInput').value || '').trim();
  const errEl = document.getElementById('adminLoginError');
  errEl.textContent = '';
  if (!key) { errEl.textContent = 'Enter the admin key'; return; }
  if (!_verifyAdminKey(key)) { errEl.textContent = 'Invalid key'; return; }
  localStorage.setItem('gw_admin_token', 'local');
  _isAdmin = true;
  document.getElementById('adminKeyInput').value = '';
  closeModal('loginModal');
  _activateAdminUI();
  openModal('adminModal');
  _updateAdminStatus();
}

function initAdminSession() {
  const token = localStorage.getItem('gw_admin_token');
  if (token) { _isAdmin = true; _activateAdminUI(); }
}

function _activateAdminUI() {
  const badge = document.getElementById('badgeAdmin');
  if (badge) badge.style.display = 'flex';
  // If profile modal admin section is open, replace it with "active" indicator
  const profileSec = document.getElementById('profileAdminSection');
  if (profileSec) profileSec.style.display = 'none';
}

function _updateAdminStatus() {
  const city    = document.getElementById('adminCityDisplay');
  const country = document.getElementById('adminCountryDisplay');
  const gps     = document.getElementById('adminGpsDisplay');
  const spoof   = document.getElementById('adminSpoofDisplay');
  if (city)    city.textContent    = detectedCity || '—';
  if (country) country.textContent = window._searchCountry || '—';
  if (gps)     gps.textContent     = userLoc ? `${userLoc.lat.toFixed(4)}, ${userLoc.lng.toFixed(4)}` : '—';
  if (spoof)   spoof.textContent   = _adminSpoofOn ? 'ON' : 'off';
  // Highlight active preset
  document.querySelectorAll('.admin-city-btn').forEach(b => b.classList.remove('active'));
  if (_adminCoords) {
    document.querySelectorAll('.admin-city-btn').forEach(b => {
      const fn = b.getAttribute('onclick') || '';
      const m  = fn.match(/adminSetCity\('[^']*',([^,]+),([^)]+)\)/);
      if (m && Math.abs(parseFloat(m[1]) - _adminCoords.lat) < 0.01) b.classList.add('active');
    });
  }
  const spoofBtn = document.getElementById('adminSpoofToggle');
  if (spoofBtn) { spoofBtn.textContent = _adminSpoofOn ? 'ON' : 'OFF'; spoofBtn.style.background = _adminSpoofOn ? '#0f172a' : 'white'; spoofBtn.style.color = _adminSpoofOn ? 'white' : '#0f172a'; }
}

function adminSetCity(city, lat, lng) {
  _adminCoords  = { lat, lng };
  detectedCity  = null; // reset so applyCity() runs even for same city
  localStorage.removeItem('gw_city');
  // Auto-enable spoof so the chosen city is immediately the active location
  _adminSpoofOn = true;
  userLoc = L.latLng(lat, lng);
  applyCity(city, lat, lng);
  if (map) map.setView([lat, lng], 13);
  showToast(`Admin: ${city === 'unknown' ? `${lat.toFixed(2)},${lng.toFixed(2)}` : city} · GPS spoofed`);
  _updateAdminStatus();
  // Trigger transit display — if NYC scripts are still loading the onload callback handles it
  if (window._nycReady || city !== 'nyc') {
    showNearbyTransit(lat, lng);
  }
}

function adminSetCustomCoords() {
  const lat = parseFloat((document.getElementById('adminLat').value || '').trim());
  const lng = parseFloat((document.getElementById('adminLng').value || '').trim());
  if (isNaN(lat) || isNaN(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    showToast('Invalid coordinates'); return;
  }
  const city = detectCityFromCoords(lat, lng);
  adminSetCity(city, lat, lng);
}

function adminToggleSpoof() {
  _adminSpoofOn = !_adminSpoofOn;
  if (_adminSpoofOn && _adminCoords) {
    userLoc = L.latLng(_adminCoords.lat, _adminCoords.lng);
    showNearbyTransit(_adminCoords.lat, _adminCoords.lng);
  }
  _updateAdminStatus();
}

function adminClearCache() {
  localStorage.removeItem('gw_city');
  detectedCity  = null;
  _adminCoords  = null;
  _adminSpoofOn = false;
  detectCityByIP();
  showToast('City cache cleared — re-detecting…');
  _updateAdminStatus();
}

function adminExitMode() {
  if (!confirm('Exit admin mode? The 🔑 badge will disappear.')) return;
  localStorage.removeItem('gw_admin_token');
  _isAdmin      = false;
  _adminSpoofOn = false;
  _adminCoords  = null;
  const badge   = document.getElementById('badgeAdmin');
  if (badge) badge.style.display = 'none';
  closeModal('adminModal');
  showToast('Admin mode deactivated');
}

// ══════════════════════════════════════════════
// PWA INSTALL
// ══════════════════════════════════════════════
let _deferredInstallPrompt = null;

function initPWA() {
  const dismissed = localStorage.getItem('gw_install_dismissed');
  const installed  = window.matchMedia('(display-mode: standalone)').matches
                  || window.navigator.standalone === true;

  if (installed || dismissed) return; // already installed or user dismissed

  const ua       = navigator.userAgent;
  const isIOS    = /iphone|ipad|ipod/i.test(ua);
  const isAndroid= /android/i.test(ua);
  const isSafari = /safari/i.test(ua) && !/chrome/i.test(ua);

  // Android/Chrome: listen for beforeinstallprompt
  window.addEventListener('beforeinstallprompt', e => {
    e.preventDefault();
    _deferredInstallPrompt = e;
    // Show the banner after 30 seconds on the page
    setTimeout(() => showInstallBanner(), 30000);
  });

  // iOS Safari: show manual instructions after delay
  if (isIOS && isSafari) {
    setTimeout(() => {
      showPlatform('ios');
      openModal('iosInstallModal');
    }, 20000);
    return;
  }

  // Android non-Chrome or other: show Android steps
  if (isAndroid && !window.addEventListener.toString().includes('beforeinstallprompt')) {
    setTimeout(() => {
      showPlatform('android');
      openModal('iosInstallModal');
    }, 25000);
  }
}

function showInstallBanner() {
  const dismissed = localStorage.getItem('gw_install_dismissed');
  const installed  = window.matchMedia('(display-mode: standalone)').matches;
  if (dismissed || installed) return;
  document.getElementById('installBanner').style.display = 'block';
}

function hideInstallBanner() {
  document.getElementById('installBanner').style.display = 'none';
}

async function triggerInstall() {
  if (_deferredInstallPrompt) {
    _deferredInstallPrompt.prompt();
    const { outcome } = await _deferredInstallPrompt.userChoice;
    _deferredInstallPrompt = null;
    hideInstallBanner();
    if (outcome === 'accepted') {
      localStorage.setItem('gw_install_dismissed', '1');
      showToast('GaitWay added to home screen! 🎉');
    }
  } else {
    // Fallback: show manual instructions
    hideInstallBanner();
    const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
    showPlatform(isIOS ? 'ios' : 'android');
    openModal('iosInstallModal');
  }
}

function dismissInstall() {
  hideInstallBanner();
  localStorage.setItem('gw_install_dismissed', '1');
}

function showPlatform(platform) {
  document.getElementById('iosSteps').style.display     = platform==='ios'     ? 'block' : 'none';
  document.getElementById('androidSteps').style.display = platform==='android' ? 'block' : 'none';
  document.getElementById('tabIos').style.background     = platform==='ios'     ? '#2563eb' : '#f1f5f9';
  document.getElementById('tabIos').style.color          = platform==='ios'     ? 'white'   : '#64748b';
  document.getElementById('tabAndroid').style.background = platform==='android' ? '#16a34a' : '#f1f5f9';
  document.getElementById('tabAndroid').style.color      = platform==='android' ? 'white'   : '#64748b';
}

// Also add install shortcut in vault (show button if not installed)
function checkInstallState() {
  const installed = window.matchMedia('(display-mode: standalone)').matches
                 || window.navigator.standalone === true;
  const el = document.getElementById('installShortcut');
  if (!el) return;
  if (installed) {
    el.innerHTML = '<div style="color:#16a34a;font-size:12px;font-weight:700;">✅ Running as installed app</div>';
  } else {
    el.innerHTML = '<button onclick="triggerInstall()" style="width:100%;background:#2563eb;color:white;border:none;padding:12px;border-radius:12px;font-size:13px;font-weight:800;cursor:pointer;font-family:inherit;">📲 Add to Home Screen</button>';
  }
}

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

const _geocodeCache = new Map();
async function _reverseGeocode(lat, lng) {
  const key = `${lat.toFixed(3)},${lng.toFixed(3)}`;
  if (_geocodeCache.has(key)) return _geocodeCache.get(key);
  try {
    const r = await fetch(`https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json`, { signal: AbortSignal.timeout(4000) });
    const d = await r.json();
    const road = d.address?.road || d.address?.suburb || d.address?.neighbourhood || '';
    const area = d.address?.suburb || d.address?.city_district || d.address?.city || '';
    const name = [road, area].filter(Boolean).join(', ') || `${lat.toFixed(3)}, ${lng.toFixed(3)}`;
    _geocodeCache.set(key, name);
    return name;
  } catch { return `${lat.toFixed(3)}, ${lng.toFixed(3)}`; }
}

function _relTime(dateStr) {
  const diff = Date.now() - new Date(dateStr).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1)  return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return new Date(dateStr).toLocaleDateString([], { month:'short', day:'numeric' });
}

let _lastHazardFetch = 0;
async function loadHazardsFromDB(force) {
  const now = Date.now();
  if (!force && now - _lastHazardFetch < 5000) return; // debounce: 5s minimum between fetches
  _lastHazardFetch = now;
  // Load all hazards globally (no radius filter) — DB has a hard LIMIT 1000 server-side
  const url = `${API}/api/hazards?limit=500`;
  try {
    const res = await fetch(url);
    const hazards = await res.json();
    if (!Array.isArray(hazards)) {
      console.warn('Hazard load: unexpected response', hazards);
      if (!res.ok) showToast(`⚠️ Hazards unavailable — DB error`, 4000);
      return;
    }
    localHazards = hazards;

    // Feed lighting/canopy hazards into Env so estimates work across sessions
    if (typeof Env !== 'undefined') Env.seedReportsFromHazards(hazards);

    // Map markers
    hazardLayer.clearLayers();
    hazards.forEach(h => {
      const ico = L.divIcon({ className:'',
        html:`<div style="background:#dc2626;width:10px;height:10px;border-radius:50%;border:2px solid white;opacity:.7;"></div>`,
        iconSize:[10,10], iconAnchor:[5,5] });
      L.marker([h.lat,h.lng],{icon:ico}).addTo(hazardLayer)
       .bindPopup(`<b>${h.type}</b>${h.ai_label?'<br>'+h.ai_label:''}${h.surface?'<br>Surface: '+h.surface:''}<br><small>${_relTime(h.created_at)}</small>`);
    });

    const list = document.getElementById('intelFeedList');
    if (!list) return;
    if (!hazards.length) { list.innerHTML = '<div class="empty-state"><div class="empty-icon">📋</div><div>No hazards reported yet</div></div>'; return; }

    // Group by location (3dp ≈ 100m) then by type
    const groups = new Map();
    hazards.forEach(h => {
      const key = `${h.lat.toFixed(3)},${h.lng.toFixed(3)}`;
      if (!groups.has(key)) groups.set(key, { lat:h.lat, lng:h.lng, items:[], roadName:'📍 Loading…' });
      groups.get(key).items.push(h);
    });

    // Render skeleton first, then fill road names async
    list.innerHTML = '';
    const today = new Date().toDateString();
    let lastSection = '';

    for (const [locKey, grp] of groups) {
      // Date section header
      const grpDate = new Date(grp.items[0].created_at).toDateString();
      const section = grpDate === today ? 'Today' : grpDate === new Date(Date.now()-86400000).toDateString() ? 'Yesterday' : new Date(grp.items[0].created_at).toLocaleDateString([],{weekday:'long',month:'short',day:'numeric'});
      if (section !== lastSection) {
        const hdr = document.createElement('div');
        hdr.style.cssText = 'font-size:11px;font-weight:800;color:#94a3b8;text-transform:uppercase;letter-spacing:.5px;padding:12px 4px 6px;';
        hdr.textContent = section;
        list.appendChild(hdr);
        lastSection = section;
      }

      // Location group card
      const card = document.createElement('div');
      card.style.cssText = 'background:white;border-radius:14px;margin-bottom:10px;border:1px solid #e2e8f0;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,.04);cursor:pointer;';
      card.onclick = () => map.setView([grp.lat, grp.lng], 17);

      // Count by type
      const typeCounts = {};
      grp.items.forEach(h => { typeCounts[h.type] = (typeCounts[h.type]||0)+1; });
      const typeRows = Object.entries(typeCounts).map(([type, cnt]) =>
        `<div style="display:flex;align-items:center;gap:8px;padding:8px 14px;border-bottom:1px solid #f8fafc;">
          <span style="font-size:18px;">${type.split(' ')[0]}</span>
          <span style="flex:1;font-size:13px;font-weight:700;color:#0f172a;">${type.replace(/^\S+\s*/,'')}</span>
          ${cnt>1?`<span style="background:#f1f5f9;color:#64748b;font-size:10px;font-weight:800;padding:2px 7px;border-radius:20px;">×${cnt}</span>`:''}
          <span style="font-size:10px;color:#94a3b8;">${_relTime(grp.items.find(h=>h.type===type).created_at)}</span>
        </div>`
      ).join('');

      // Env tags
      const sample = grp.items[0];
      const tags = [sample.canopy&&`🌳 ${sample.canopy}`, sample.lighting&&`💡 ${sample.lighting}`, sample.surface&&`🛤 ${sample.surface}`].filter(Boolean);

      card.innerHTML = `
        <div style="padding:10px 14px 6px;display:flex;align-items:center;gap:8px;">
          <span style="font-size:11px;font-weight:800;color:#2563eb;flex:1;" id="road_${locKey.replace('.','_').replace(',','_')}">📍 Loading…</span>
          <span style="font-size:10px;color:#94a3b8;">Anonymous</span>
        </div>
        ${typeRows}
        ${tags.length?`<div style="padding:6px 14px 10px;display:flex;gap:6px;flex-wrap:wrap;">${tags.map(t=>`<span style="background:#f1f5f9;color:#475569;font-size:10px;font-weight:600;padding:2px 8px;border-radius:20px;">${t}</span>`).join('')}</div>`:'<div style="height:8px;"></div>'}`;
      list.appendChild(card);
    }

    // Async fill road names — skip already-cached entries immediately, queue uncached ones at 150ms apart
    let delay = 0;
    for (const [locKey, grp] of groups) {
      const cacheKey = `${grp.lat.toFixed(3)},${grp.lng.toFixed(3)}`;
      const elId = 'road_' + locKey.replace('.','_').replace(',','_');
      if (_geocodeCache.has(cacheKey)) {
        // Already cached — update immediately, no delay
        const el = document.getElementById(elId);
        if (el) el.textContent = '📍 ' + _geocodeCache.get(cacheKey);
      } else {
        setTimeout(async () => {
          const name = await _reverseGeocode(grp.lat, grp.lng);
          const el = document.getElementById(elId);
          if (el) el.textContent = '📍 ' + name;
        }, delay);
        delay += 150; // Nominatim allows ~1 req/s; 150ms keeps us safe and cuts total time in half
      }
    }
  } catch(e) { console.warn('Hazard load failed:', e.message); }
}

async function saveHazardToDB(type, lat, lng, extra={}) {
  try {
    const res  = await fetch(`${API}/api/hazards`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ type, lat, lng, user_id: userId, ...extra }),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return { ok: true, id: data.id };
  } catch(e) {
    console.warn('Hazard save failed:', e.message);
    return { ok: false, error: e.message };
  }
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

// #3 — smart marker delta registry
const _visibleMarkers = new Map(); // stopId → L.Marker

// #6 — off-route detection
let currentRouteCoords = [];
let offRouteCount = 0;

// HUD snap state: 'full' | 'half' | 'peek'
let hudSnap = 'full';

// Live nav step tracking
let _routeSteps   = [];
let _liveStepIdx  = 0;

// Delhi PAPL streetlight/underpass sampling for the active route (null when not applicable)
let _routeLightingStats = null;

// Hazard heatmap layer
let heatLayer = null;

// Delhi PAPL infra layers
let streetlightHeatLayer = null;
let subwayLayer = null;

// ── TRANSPORT MODE PREFERENCES ──
// Which modes the user has toggled ON
let enabledModes = new Set(['walk','metro','bus','auto']);

function toggleMode(mode) {
  const btn = document.querySelector(`.mode-toggle[data-mode="${mode}"]`);
  if (!btn) return;
  if (enabledModes.has(mode)) {
    // Don't allow disabling walk entirely
    if (mode === 'walk' && enabledModes.size === 1) { showToast('At least one mode must be on'); return; }
    enabledModes.delete(mode);
    btn.classList.remove('active');
  } else {
    enabledModes.add(mode);
    btn.classList.add('active');
  }
  // Recompute routes with new mode preferences
  const from = activeOriginLatLng || userLoc;
  if (from && activeDestLatLng) prepareComparison(from, activeDestLatLng);
}

function isModeEnabled(mode) { return enabledModes.has(mode); }

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

// ── HAZARD RETRY QUEUE — persists failed saves across sessions ──
const _HAZARD_QUEUE_KEY = 'gw_hazard_queue';

function _queueHazard(type, lat, lng, extra) {
  try {
    const q = JSON.parse(localStorage.getItem(_HAZARD_QUEUE_KEY) || '[]');
    q.push({ type, lat, lng, extra, ts: Date.now() });
    localStorage.setItem(_HAZARD_QUEUE_KEY, JSON.stringify(q));
  } catch(e) { console.warn('Queue write failed:', e.message); }
}

async function _flushHazardQueue() {
  try {
    const q = JSON.parse(localStorage.getItem(_HAZARD_QUEUE_KEY) || '[]');
    if (!q.length) return;
    console.log(`🔄 Retrying ${q.length} queued hazard(s)…`);
    const stillPending = [];
    for (const item of q) {
      const r = await saveHazardToDB(item.type, item.lat, item.lng, item.extra || {});
      if (!r.ok) stillPending.push(item);
    }
    localStorage.setItem(_HAZARD_QUEUE_KEY, JSON.stringify(stillPending));
    const flushed = q.length - stillPending.length;
    if (flushed > 0) {
      showToast(`✅ ${flushed} pending hazard${flushed > 1 ? 's' : ''} synced`);
      loadHazardsFromDB(true);
    }
  } catch(e) { console.warn('Queue flush failed:', e.message); }
}

// ── DB HEALTH CHECK — runs once after init ──
async function _checkDbHealth() {
  try {
    const res  = await fetch('/api/health');
    const data = await res.json();
    if (!data.ok) {
      const msg = data.db.startsWith('error:') ? data.db.replace('error:', '').trim() : data.db;
      showToast(`⚠️ Database offline: ${msg.slice(0, 60)}`, 7000);
      console.error('DB health check failed:', data);
      return;
    }
    // Tables missing? (first-time setup)
    if (typeof data.tables.hazards === 'string' && data.tables.hazards.includes('missing')) {
      showToast('⚠️ Hazards table missing — run supabase_schema.sql', 8000);
      console.error('Missing tables:', data.tables);
      return;
    }
    // All good — try to flush any queued hazards from previous offline sessions
    _flushHazardQueue();
  } catch(e) {
    console.warn('Health check error:', e.message);
  }
}

// ── SPLASH DISMISS ──
const _splashShownAt = Date.now();
function _hideSplash() {
  const el = document.getElementById('splash');
  if (!el) return;
  // Show for at least 1 400 ms so the animation plays fully
  const remaining = Math.max(0, 1400 - (Date.now() - _splashShownAt));
  setTimeout(() => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 560);
  }, remaining);
}

// ── INIT ──
window.onload = () => {
  Env.init();
  window._onEnvUpdate = updateSurfaceReadout;
  initTabs();
  initMap();
  initSensors();
  initSearchBoxes();
  detectCityByIP();   // IP geo — fires immediately, no GPS needed
  pollBusData();
  setTimeout(loadHazardsFromDB, 2000); // load hazards without waiting for GPS
  initUserSession();
  initAdminSession(); // admin mode restore on page reload
  initPWA();
  checkInstallState();
  parseShareParams(); // #21 — auto-fill route from URL params
  _hideSplash();      // dismiss loading screen once core init is done
  setTimeout(_checkDbHealth, 3000); // check DB after splash gone
};

// #21 — Parse shared route URL params
function parseShareParams() {
  const p = new URLSearchParams(location.search);
  const from = p.get('from'), to = p.get('to');
  if (!from || !to) return;
  const [fLat, fLng] = from.split(',').map(Number);
  const [tLat, tLng] = to.split(',').map(Number);
  const fn = p.get('fn') || 'Origin', tn = p.get('tn') || 'Destination';
  const mode = p.get('mode') || 'walk';
  setTimeout(() => {
    setOrigin(fLat, fLng, fn);
    setDest(tLat, tLng, tn);
    setTimeout(() => pickRoute(mode), 800);
  }, 1500);
}

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
      if (this.dataset.target === 'intel-tab') loadHazardsFromDB();
    });
  });
}

// ── DC LAYERS ──
let dcParksLayer   = null;
let dcLandmarkLayer = null;
let _satelliteOn   = false;
let _osmTile, _satTile;

const DC_LANDMARKS = [
  { name:'🏛 US Capitol',          lat:38.8899, lng:-77.0091 },
  { name:'🏠 White House',         lat:38.8977, lng:-77.0366 },
  { name:'🗿 Washington Monument', lat:38.8895, lng:-77.0353 },
  { name:'🪖 Lincoln Memorial',    lat:38.8893, lng:-77.0502 },
  { name:'🌊 Jefferson Memorial',  lat:38.8814, lng:-77.0365 },
  { name:'⭐ Pentagon',            lat:38.8719, lng:-77.0563 },
  { name:'✈️ Reagan Airport',      lat:38.8521, lng:-77.0379 },
  { name:'🏥 Georgetown Univ',     lat:38.9076, lng:-77.0723 },
  { name:'🎨 National Mall',       lat:38.8893, lng:-77.0227 },
  { name:'🌳 Rock Creek Park',     lat:38.9517, lng:-77.0526 },
  { name:'🏛 Library of Congress', lat:38.8887, lng:-77.0047 },
  { name:'🎭 Kennedy Center',      lat:38.8963, lng:-77.0566 },
];

async function loadDcLayers() {
  if (detectedCity !== 'dc') return;

  // ── Landmarks ──
  if (!dcLandmarkLayer) {
    dcLandmarkLayer = L.layerGroup().addTo(map);
    DC_LANDMARKS.forEach(lm => {
      const ico = L.divIcon({ className:'', iconSize:[null,null],
        html:`<div style="background:white;border:2px solid #1565c0;border-radius:8px;padding:2px 7px;font-size:10px;font-weight:800;color:#1565c0;white-space:nowrap;box-shadow:0 2px 6px rgba(0,0,0,.2);">${lm.name}</div>` });
      L.marker([lm.lat, lm.lng], { icon:ico }).addTo(dcLandmarkLayer)
       .bindPopup(`<b>${lm.name}</b><br><button onclick="setDest(${lm.lat},${lm.lng},'${lm.name.replace(/'/,"\\'")}');closeModal('poiModal')" style="margin-top:6px;padding:4px 10px;background:#2563eb;color:white;border:none;border-radius:6px;cursor:pointer;font-size:12px;">Navigate Here</button>`);
    });
  }

  // ── Parks (Overpass API) ──
  if (dcParksLayer) return;
  const cached = sessionStorage.getItem('dc_parks_geojson');
  let geojson;
  if (cached) {
    geojson = JSON.parse(cached);
  } else {
    try {
      const q = `[out:json][timeout:20];way["leisure"="park"](38.79,-77.12,38.99,-76.91);out geom;`;
      const r = await fetch(`https://overpass-api.de/api/interpreter?data=${encodeURIComponent(q)}`, { signal: AbortSignal.timeout(10000) });
      const d = await r.json();
      geojson = { type:'FeatureCollection', features: d.elements.filter(e=>e.geometry).map(e => ({
        type:'Feature',
        properties:{ name: e.tags?.name || 'Park' },
        geometry:{ type:'Polygon', coordinates:[ e.geometry.map(p=>[p.lon,p.lat]) ] }
      }))};
      sessionStorage.setItem('dc_parks_geojson', JSON.stringify(geojson));
    } catch(e) { console.warn('DC parks load failed:', e.message); showToast('Parks load failed — tap 🌳 to retry'); return; }
  }
  dcParksLayer = L.geoJSON(geojson, {
    style:{ color:'#16a34a', weight:1.5, fillColor:'#22c55e', fillOpacity:.18 },
    onEachFeature:(f,l) => l.bindPopup(`<b>🌳 ${f.properties.name}</b>`)
  }).addTo(map);
  showToast(`🌳 ${geojson.features.length} DC parks loaded`);
  console.log(`🌳 DC parks loaded: ${geojson.features.length}`);
}

function toggleSatellite(forceOn) {
  const btn = document.getElementById('btnSatellite');
  const turnOn = forceOn !== undefined ? forceOn : !_satelliteOn;
  if (turnOn) {
    _osmTile?.remove();
    _satTile = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom:19, attribution:'Esri' });
    _satTile.addTo(map); _satTile.bringToBack();
    if (btn) { btn.textContent='🗺 Map'; btn.style.background='#0f172a'; btn.style.color='white'; }
    _satelliteOn = true;
  } else {
    _satTile?.remove();
    _osmTile = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom:19 });
    _osmTile.addTo(map); _osmTile.bringToBack();
    if (btn) { btn.textContent='🛰 Sat'; btn.style.background='white'; btn.style.color='#0f172a'; }
    _satelliteOn = false;
  }
  localStorage.setItem('gw_satellite', _satelliteOn ? '1' : '0');
}

// ── NYC LAYERS ──
let nycParksLayer    = null;
let nycLandmarkLayer = null;
let nycSubwayLayer   = null;
let nycNetworkLayer  = null;  // subway route polylines
let nycVehicleLayer  = null;  // live train/bus positions
let _vehicleTimer    = null;  // refresh interval handle
let _nycAlerts       = [];    // cached alert objects {routeIds,stopIds,header,effectLabel}

function drawSubwayNetworkLayer() {
  if (!window.NYC_SHAPES || !window.NycEngine) return;
  if (detectedCity !== 'nyc') return;
  if (nycNetworkLayer) { nycNetworkLayer.addTo(map); return; } // re-show if hidden
  nycNetworkLayer = L.layerGroup().addTo(map);
  window.NycEngine.drawSubwayNetwork(map, nycNetworkLayer);
  // Bring station markers above the network lines
  if (stationLayer) stationLayer.bringToFront();
}

function toggleSubwayNetwork(show) {
  if (!nycNetworkLayer) { drawSubwayNetworkLayer(); return; }
  if (show === false) map.removeLayer(nycNetworkLayer);
  else if (!map.hasLayer(nycNetworkLayer)) nycNetworkLayer.addTo(map);
  else map.removeLayer(nycNetworkLayer);
}

// ── Live vehicle positions ──────────────────────────────────────────────────

const _STATUS_LABEL = ['Arriving','At stop','En route'];

async function _refreshVehicles() {
  if (detectedCity !== 'nyc') return;
  try {
    const res  = await fetch('/api/nyc/vehicle-positions');
    const data = await res.json();
    if (!data.ok || !data.vehicles) return;

    // Rebuild vehicle layer
    if (!nycVehicleLayer) nycVehicleLayer = L.layerGroup().addTo(map);
    else nycVehicleLayer.clearLayers();

    const lineColors = window.NYC_SUBWAY?.lines || {};

    data.vehicles.forEach(v => {
      const color = (lineColors[v.routeId]?.color) || '#888';
      const tc    = (lineColors[v.routeId]?.textColor) || '#fff';

      // Arrow pointing in bearing direction + colored circle badge
      const arrowSvg = v.bearing != null && v.bearing > 0
        ? `<div style="position:absolute;top:-8px;left:50%;transform:translateX(-50%) rotate(${v.bearing}deg);font-size:10px;line-height:1;">▲</div>`
        : '';

      const ico = L.divIcon({
        className: '',
        html: `<div style="position:relative;width:22px;height:22px;">
          ${arrowSvg}
          <div style="background:${color};color:${tc};border:2px solid white;border-radius:50%;
            width:20px;height:20px;line-height:20px;text-align:center;
            font-size:10px;font-weight:800;box-shadow:0 2px 6px rgba(0,0,0,.4);
            position:absolute;bottom:0;left:1px;">${v.routeId}</div>
        </div>`,
        iconSize: [22, 30],
        iconAnchor: [11, 20],
      });

      const statusLabel = _STATUS_LABEL[v.status] || 'En route';
      const dirLabel    = v.directionId === 0 ? ' · Uptown/Outbound' : v.directionId === 1 ? ' · Downtown/Inbound' : '';
      const stopNote    = v.stopId ? `<div style="font-size:10px;color:#94a3b8;margin-top:2px;">Near stop ${v.stopId}</div>` : '';

      const m = L.marker([v.lat, v.lng], { icon: ico, zIndexOffset: 200 });
      m.bindPopup(`<div style="min-width:150px;">
        <b style="color:${color};">🚇 Line ${v.routeId}</b>${dirLabel}
        <div style="font-size:11px;color:#475569;margin-top:2px;">${statusLabel}</div>
        ${stopNote}
      </div>`, { maxWidth: 220 });
      nycVehicleLayer.addLayer(m);
    });

    // Keep vehicles below station markers
    if (stationLayer) stationLayer.bringToFront();

    console.log(`🚇 ${data.vehicles.length} vehicles plotted`);
  } catch(e) {
    console.warn('Vehicle refresh failed:', e.message);
  }
}

function startVehicleTracking() {
  if (_vehicleTimer) return;
  _refreshVehicles();
  _vehicleTimer = setInterval(_refreshVehicles, 30000);
}

function stopVehicleTracking() {
  if (_vehicleTimer) { clearInterval(_vehicleTimer); _vehicleTimer = null; }
  if (nycVehicleLayer) { map.removeLayer(nycVehicleLayer); nycVehicleLayer = null; }
}

function toggleVehicles() {
  if (_vehicleTimer) {
    stopVehicleTracking();
    const btn = document.getElementById('btnVehicles');
    if (btn) { btn.style.background = 'white'; btn.style.color = '#475569'; }
  } else {
    startVehicleTracking();
    const btn = document.getElementById('btnVehicles');
    if (btn) { btn.style.background = '#1e293b'; btn.style.color = 'white'; }
  }
}

// ════════════════════════════════════════════
// DELHI OTD LIVE VEHICLE POSITIONS
// ════════════════════════════════════════════

// DMRC line color lookup by OTD GTFS route_id (case-insensitive substring match)
const DELHI_METRO_ROUTE_COLORS = {
  'RED':    '#e53935',
  'YELLOW': '#fdd835',
  'BLUE':   '#1565c0',
  'GREEN':  '#43a047',
  'VIOLET': '#8e24aa',
  'MAGENTA':'#d81b60',
  'PINK':   '#e91e63',
  'ORANGE': '#fb8c00',
  'AQUA':   '#00acc1',
  'GRAY':   '#757575',
  'GREY':   '#757575',
  'RAPID':  '#00897b',
};

function _delhiRouteColor(routeId) {
  const up = (routeId || '').toUpperCase();
  for (const [key, color] of Object.entries(DELHI_METRO_ROUTE_COLORS)) {
    if (up.startsWith(key) || up.includes(key)) return color;
  }
  return '#1565c0'; // fallback: DMRC blue
}

let delhiVehicleLayer = null;
let _delhiVehicleTimer = null;

async function _refreshDelhiVehicles() {
  if (detectedCity !== 'delhi') return;
  try {
    const res  = await fetch('/api/delhi/vehicle-positions');
    const data = await res.json();
    if (!data.ok || !data.vehicles) {
      if (data.error) console.warn('Delhi vehicles:', data.error);
      return;
    }

    if (!delhiVehicleLayer) delhiVehicleLayer = L.layerGroup().addTo(map);
    else delhiVehicleLayer.clearLayers();

    data.vehicles.forEach(v => {
      const color  = _delhiRouteColor(v.routeId);
      // Shorten route label to 3 chars for badge
      const label  = (v.routeId || '?').replace(/[\s_-]+/g, '').substring(0, 3).toUpperCase();

      const arrowSvg = v.bearing
        ? `<div style="position:absolute;top:-8px;left:50%;transform:translateX(-50%) rotate(${v.bearing}deg);font-size:10px;line-height:1;color:${color};">▲</div>`
        : '';

      const ico = L.divIcon({
        className: '',
        html: `<div style="position:relative;width:22px;height:22px;">
          ${arrowSvg}
          <div style="background:${color};color:${color === '#fdd835' ? '#333' : 'white'};border:2px solid white;border-radius:50%;
            width:20px;height:20px;line-height:20px;text-align:center;
            font-size:8px;font-weight:800;box-shadow:0 2px 6px rgba(0,0,0,.4);
            position:absolute;bottom:0;left:1px;">${label}</div>
        </div>`,
        iconSize: [22, 30],
        iconAnchor: [11, 20],
      });

      const statusLabel = _STATUS_LABEL[v.status] || 'En route';
      const stopNote    = v.stopId ? `<div style="font-size:10px;color:#94a3b8;margin-top:2px;">Near stop ${v.stopId}</div>` : '';

      const m = L.marker([v.lat, v.lng], { icon: ico, zIndexOffset: 200 });
      m.bindPopup(`<div style="min-width:150px;">
        <b style="color:${color};">🚇 ${v.routeId || 'Metro'}</b>
        <div style="font-size:11px;color:#475569;margin-top:2px;">${statusLabel}</div>
        ${stopNote}
      </div>`, { maxWidth: 220 });
      delhiVehicleLayer.addLayer(m);
    });

    if (stationLayer) stationLayer.bringToFront();
    console.log(`🚇 ${data.vehicles.length} Delhi metro vehicles plotted`);
  } catch(e) {
    console.warn('Delhi vehicle refresh failed:', e.message);
  }
}

function startDelhiVehicleTracking() {
  if (_delhiVehicleTimer) return;
  _refreshDelhiVehicles();
  _delhiVehicleTimer = setInterval(_refreshDelhiVehicles, 30000);
}

function stopDelhiVehicleTracking() {
  if (_delhiVehicleTimer) { clearInterval(_delhiVehicleTimer); _delhiVehicleTimer = null; }
  if (delhiVehicleLayer) { map.removeLayer(delhiVehicleLayer); delhiVehicleLayer = null; }
}

function toggleDelhiVehicles() {
  if (_delhiVehicleTimer) {
    stopDelhiVehicleTracking();
    const btn = document.getElementById('btnDelhiVehicles');
    if (btn) { btn.style.background = 'white'; btn.style.color = '#475569'; }
  } else {
    startDelhiVehicleTracking();
    const btn = document.getElementById('btnDelhiVehicles');
    if (btn) { btn.style.background = '#1e293b'; btn.style.color = 'white'; }
  }
}

// ── Service alerts ──────────────────────────────────────────────────────────

async function _loadAlerts() {
  if (detectedCity !== 'nyc') return;
  try {
    const res  = await fetch('/api/nyc/alerts');
    const data = await res.json();
    if (!data.ok) return;
    _nycAlerts = data.alerts || [];
    // Build route → alerts index for quick popup lookup
    window._nycAlertsByRoute = {};
    _nycAlerts.forEach(a => {
      a.routeIds.forEach(r => {
        if (!window._nycAlertsByRoute[r]) window._nycAlertsByRoute[r] = [];
        window._nycAlertsByRoute[r].push(a);
      });
    });
    const active = _nycAlerts.filter(a => a.effect !== 9).length;  // 9 = NO_EFFECT
    if (active > 0) showToast(`🚨 ${active} active MTA service alert${active > 1 ? 's' : ''}`, 4000);
    console.log(`🔔 ${_nycAlerts.length} MTA alerts loaded (${active} active)`);
  } catch(e) {
    console.warn('Alerts load failed:', e.message);
  }
}

// Build alert HTML snippet for a station popup (given array of line IDs)
function _alertHtmlForLines(lines) {
  if (!window._nycAlertsByRoute || !lines) return '';
  const seen = new Set();
  const alerts = [];
  lines.forEach(l => {
    (window._nycAlertsByRoute[l] || []).forEach(a => {
      const key = a.header + a.routeIds.join('');
      if (!seen.has(key) && a.effect !== 9) { seen.add(key); alerts.push(a); }
    });
  });
  if (!alerts.length) return '';
  return alerts.slice(0, 2).map(a => `
    <div style="background:#fef2f2;border:1px solid #fca5a5;border-radius:6px;padding:5px 8px;margin-top:5px;">
      <div style="font-size:10px;font-weight:700;color:#dc2626;">⚠ ${a.effectLabel.replace(/_/g,' ')}</div>
      <div style="font-size:10px;color:#7f1d1d;margin-top:1px;">${a.header}</div>
    </div>`).join('');
}

// ════════════════════════════════════════════
// DC WMATA LIVE ARRIVALS
// ════════════════════════════════════════════

const WMATA_LINE_COLORS_CLIENT = {
  RD:'#E3222B', BL:'#0D5CA8', OR:'#E97F1B',
  GR:'#0C8C44', YL:'#FBBF07', SV:'#9DAAB6',
};

async function _fetchDcTrainArrivals(stationCode, allCodes) {
  const el = document.getElementById('arr_dc_' + stationCode);
  if (!el) return;
  try {
    const codes = (allCodes && allCodes.length ? allCodes : [stationCode]).join(',');
    const res  = await fetch('/api/dc/train-arrivals?codes=' + encodeURIComponent(codes));
    const data = await res.json();
    if (!el.isConnected) return;
    if (!data.ok || !data.trains || !data.trains.length) {
      el.innerHTML = '<span style="font-size:10px;color:#94a3b8;">No predictions available</span>';
      return;
    }
    // Group by line, show next 2 per line
    const byLine = {};
    data.trains.forEach(t => {
      if (!byLine[t.line]) byLine[t.line] = [];
      if (byLine[t.line].length < 2) byLine[t.line].push(t);
    });
    let html = '<div style="display:flex;flex-direction:column;gap:3px;margin-top:4px;">';
    Object.entries(byLine).forEach(([line, trains]) => {
      const color = WMATA_LINE_COLORS_CLIENT[line] || '#888';
      const tc    = line === 'YL' ? '#333' : '#fff';
      trains.forEach(t => {
        const when = t.min === 'ARR' ? 'Arriving' : t.min === 'BRD' ? 'Boarding' : `${t.min} min`;
        html += `<div style="display:flex;align-items:center;gap:6px;">
          <span style="background:${color};color:${tc};font-size:9px;font-weight:800;padding:2px 6px;border-radius:4px;white-space:nowrap;">${line}</span>
          <span style="font-size:11px;color:#334155;flex:1;">${t.destination}</span>
          <span style="font-size:11px;font-weight:700;color:${color};">${when}</span>
        </div>`;
      });
    });
    html += '</div>';
    const age = Math.round(Date.now() / 1000 - (data.fetchedAt || Date.now() / 1000));
    html += `<div style="font-size:9px;color:#94a3b8;margin-top:3px;">Live · ${age}s ago</div>`;
    if (el.isConnected) el.innerHTML = html;
  } catch(e) {
    if (el && el.isConnected) el.innerHTML = '<span style="font-size:10px;color:#94a3b8;">Arrivals unavailable</span>';
  }
}

async function _fetchDcBusArrivals(stopId) {
  const el = document.getElementById('arr_dc_bus_' + stopId);
  if (!el) return;
  try {
    const res  = await fetch('/api/dc/bus-arrivals?stop=' + encodeURIComponent(stopId));
    const data = await res.json();
    if (!el.isConnected) return;
    if (!data.ok || !data.predictions || !data.predictions.length) {
      el.innerHTML = '<span style="font-size:10px;color:#94a3b8;">No predictions</span>';
      return;
    }
    const byRoute = {};
    data.predictions.forEach(p => {
      if (!byRoute[p.routeId]) byRoute[p.routeId] = [];
      if (byRoute[p.routeId].length < 2) byRoute[p.routeId].push(p);
    });
    let html = '<div style="display:flex;flex-direction:column;gap:3px;margin-top:4px;">';
    Object.entries(byRoute).forEach(([route, preds]) => {
      const times = preds.map(p => p.minutes <= 0 ? 'Now' : p.minutes + ' min').join(', ');
      html += `<div style="display:flex;align-items:center;gap:5px;">
        <span style="background:#E97F1B;color:white;border-radius:4px;padding:1px 6px;font-size:10px;font-weight:800;">${route}</span>
        <span style="font-size:11px;color:#334155;">${times}</span>
      </div>`;
    });
    html += '</div>';
    const age = Math.round(Date.now() / 1000 - (data.fetchedAt || Date.now() / 1000));
    html += `<div style="font-size:9px;color:#94a3b8;margin-top:3px;">Live · ${age}s ago</div>`;
    if (el.isConnected) el.innerHTML = html;
  } catch(e) {
    if (el && el.isConnected) el.innerHTML = '<span style="font-size:10px;color:#94a3b8;">Arrivals unavailable</span>';
  }
}

async function _loadDcIncidents() {
  if (detectedCity !== 'dc') return;
  try {
    const res  = await fetch('/api/dc/incidents');
    const data = await res.json();
    if (!data.ok || !data.incidents) return;
    // Build line → incidents index for popup injection
    window._dcIncidentsByLine = {};
    data.incidents.forEach(inc => {
      inc.lines.forEach(l => {
        if (!window._dcIncidentsByLine[l]) window._dcIncidentsByLine[l] = [];
        window._dcIncidentsByLine[l].push(inc);
      });
    });
    const active = data.incidents.length;
    if (active > 0) showToast(`🚨 ${active} WMATA service alert${active > 1 ? 's' : ''}`, 4000);
    console.log(`🔔 ${active} DC incidents loaded`);
  } catch(e) {
    console.warn('DC incidents load failed:', e.message);
  }
}

const NYC_LANDMARKS = [
  { name:'🗽 Statue of Liberty',   lat:40.6892, lng:-74.0445 },
  { name:'🌇 Times Square',        lat:40.7580, lng:-73.9855 },
  { name:'🌳 Central Park',        lat:40.7851, lng:-73.9683 },
  { name:'🏙 Empire State Bldg',   lat:40.7484, lng:-73.9857 },
  { name:'🌉 Brooklyn Bridge',     lat:40.7061, lng:-73.9969 },
  { name:'🚉 Grand Central',       lat:40.7527, lng:-73.9772 },
  { name:'🎭 Broadway District',   lat:40.7590, lng:-73.9845 },
  { name:'🏛 Met Museum',          lat:40.7794, lng:-73.9632 },
  { name:'💰 Wall Street',         lat:40.7074, lng:-74.0113 },
  { name:'🌿 High Line',           lat:40.7480, lng:-74.0048 },
  { name:'✈️ JFK Airport',         lat:40.6413, lng:-73.7781 },
  { name:'✈️ LaGuardia Airport',   lat:40.7769, lng:-73.8740 },
  { name:'🏟 Yankee Stadium',      lat:40.8296, lng:-73.9262 },
  { name:'🎡 Coney Island',        lat:40.5755, lng:-73.9707 },
];

async function loadNycLayers() {
  if (detectedCity !== 'nyc') return;

  // Landmarks
  if (!nycLandmarkLayer) {
    nycLandmarkLayer = L.layerGroup().addTo(map);
    NYC_LANDMARKS.forEach(lm => {
      const ico = L.divIcon({ className:'', iconSize:[null,null],
        html:`<div style="background:white;border:2px solid #1565c0;border-radius:8px;padding:2px 7px;font-size:10px;font-weight:800;color:#1565c0;white-space:nowrap;box-shadow:0 2px 6px rgba(0,0,0,.2);">${lm.name}</div>` });
      L.marker([lm.lat, lm.lng], { icon:ico }).addTo(nycLandmarkLayer)
       .bindPopup(`<b>${lm.name}</b><br><button onclick="setDest(${lm.lat},${lm.lng},'${lm.name.replace(/'/,"\\'")}');closeModal('poiModal')" style="margin-top:6px;padding:4px 10px;background:#2563eb;color:white;border:none;border-radius:6px;cursor:pointer;font-size:12px;">Navigate Here</button>`);
    });
  }

  // Subway stops are drawn via refreshTransitOnView once _nycReady is true

  // Parks via Overpass
  if (nycParksLayer) return;
  const cached = sessionStorage.getItem('nyc_parks_geojson');
  let geojson;
  if (cached) {
    geojson = JSON.parse(cached);
  } else {
    try {
      const q = `[out:json][timeout:25];way["leisure"="park"](40.55,-74.10,40.90,-73.75);out geom;`;
      const r = await fetch(`https://overpass-api.de/api/interpreter?data=${encodeURIComponent(q)}`, { signal: AbortSignal.timeout(15000) });
      const d = await r.json();
      geojson = { type:'FeatureCollection', features: d.elements.filter(e=>e.geometry).map(e => ({
        type:'Feature',
        properties:{ name: e.tags?.name || 'Park' },
        geometry:{ type:'Polygon', coordinates:[ e.geometry.map(p=>[p.lon,p.lat]) ] }
      }))};
      sessionStorage.setItem('nyc_parks_geojson', JSON.stringify(geojson));
    } catch(e) { console.warn('NYC parks load failed:', e.message); showToast('Parks load failed — tap 🗽 to retry'); return; }
  }
  nycParksLayer = L.geoJSON(geojson, {
    style:{ color:'#16a34a', weight:1.5, fillColor:'#22c55e', fillOpacity:.18 },
    onEachFeature:(f,l) => l.bindPopup(`<b>🌳 ${f.properties.name}</b>`)
  }).addTo(map);
  showToast(`🌳 ${geojson.features.length} NYC parks loaded`);
  console.log(`🌳 NYC parks loaded: ${geojson.features.length}`);
}

// ── MAP ──
function initMap() {
  interactiveLayer = L.layerGroup();
  transitLayer     = L.layerGroup();
  stationLayer     = L.layerGroup();
  hazardLayer      = L.layerGroup();

  map = L.map('map', { zoomControl:false, attributionControl:false })
         .setView([28.6139, 77.2090], 13);
  _osmTile = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom:19 }).addTo(map);
  // Restore satellite preference
  if (localStorage.getItem('gw_satellite') === '1') setTimeout(() => toggleSatellite(true), 100);
  interactiveLayer.addTo(map);
  transitLayer.addTo(map);
  stationLayer.addTo(map);
  hazardLayer.addTo(map);

  // Refresh transit stops on pan/zoom
  let transitRefreshTimer = null;
  map.on('moveend zoomend', () => {
    clearTimeout(transitRefreshTimer);
    transitRefreshTimer = setTimeout(() => {
      const c = map.getCenter(), z = map.getZoom();
      if (z >= 13) refreshTransitOnView(c.lat, c.lng, z);
      else {
        stationLayer.clearLayers();
        _visibleMarkers.clear(); // #3 — clear registry when zoomed out
        if (typeof WmataEngine !== 'undefined' && WmataEngine.wmataDataReady())
          WmataEngine.drawWmataMetroLines(stationLayer);
      }
      if (streetlightHeatLayer) _refreshStreetlightHeat();
      if (subwayLayer) _refreshSubwayMarkers();
    }, 400);
  });

  // Tap map → POI action sheet
  map.on('click', e => {
    if (e.originalEvent._markerHandled) return;
    showPoiSheet(e.latlng.lat, e.latlng.lng, null);
  });

  // Long-press → drop destination
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

    if (firstFix) {
      // GPS is authoritative — override IP detection
      const city = detectCityFromCoords(e.latlng.lat, e.latlng.lng);
      applyCity(city, e.latlng.lat, e.latlng.lng);
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
    loadHazardsFromDB(true); // force: GPS lock is authoritative, bypass debounce

    // #6 — off-route detection
    if (isLiveTracking && currentRouteCoords.length > 1 && activeDestLatLng) {
      const nearestDist = currentRouteCoords.reduce((min, c) => {
        return Math.min(min, L.latLng(c[0], c[1]).distanceTo(userLoc));
      }, Infinity);
      if (nearestDist > 80) {
        offRouteCount++;
        if (offRouteCount === 3) {
          showToast('Off route — recalculate?');
          offRouteCount = 0;
        }
      } else {
        offRouteCount = 0;
      }
    }

    // #20 — ETA countdown
    if (isLiveTracking && activeDestLatLng) {
      const remM = Math.ceil(userLoc.distanceTo(activeDestLatLng) / 83);
      const etaEl = document.getElementById('liveEta');
      if (etaEl) etaEl.textContent = remM + ' min left';
      // Advance to next step when within 20m of the next maneuver
      if (_routeSteps.length && _liveStepIdx < _routeSteps.length - 1) {
        const nextStep = _routeSteps[_liveStepIdx + 1];
        const nextLL   = L.latLng(nextStep.maneuver.location[1], nextStep.maneuver.location[0]);
        if (userLoc.distanceTo(nextLL) < 20) {
          _liveStepIdx++;
          _updateLiveStepCard();
          if (navigator.vibrate) navigator.vibrate(40); // haptic on turn
          const instr = _routeSteps[_liveStepIdx];
          if (document.getElementById('voiceToggle')?.checked && 'speechSynthesis' in window) {
            const dir  = instr.maneuver.modifier ? instr.maneuver.modifier.replace('-',' ') : '';
            const act  = instr.maneuver.type==='turn' ? `Turn ${dir}` : 'Continue';
            const road = instr.name ? `onto ${instr.name}` : '';
            speechSynthesis.cancel();
            speechSynthesis.speak(new SpeechSynthesisUtterance(`${act} ${road}`.trim()));
          }
        }
      }
    }
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
      console.log(`✅ Bus GTFS: ${Object.keys(BUS_STOPS_V2).length} stops`);
    }
  }, 300);
}
function pollWmataData() {
  const check = setInterval(() => {
    if (typeof WmataEngine !== 'undefined' && WmataEngine.wmataDataReady()) {
      clearInterval(check);
      console.log(`✅ WMATA: ${Object.keys(WMATA_STATIONS).length} stations`);
      WmataEngine.drawWmataMetroLines(stationLayer);
      const loc = userLoc || (detectedCity === 'dc' ? L.latLng(38.9072, -77.0369) : null);
      if (loc) WmataEngine.refreshWmataOnView(loc.lat, loc.lng, map.getZoom()||14, stationLayer);
      // Load service incidents once WMATA data is ready
      _loadDcIncidents();
    }
  }, 300);
}
function getNearestBusStops(lat, lng, n=5, km=0.8) {
  return (typeof BusEngine !== 'undefined' && BusEngine.busDataReady())
    ? BusEngine.getNearestBusStops(lat, lng, n, km) : [];
}

// Refresh transit stops based on current map view
// #3 — uses delta registry to avoid flicker (only add/remove markers that enter/leave viewport)
function refreshTransitOnView(lat, lng, zoom) {
  const bounds = map.getBounds();
  const paddedBounds = bounds.pad(0.2);

  const busRadius   = zoom >= 17 ? 0.3 : zoom >= 15 ? 0.5 : 0.8;
  const busCount    = zoom >= 17 ? 10  : zoom >= 15 ? 8   : 6;
  const metroRadius = zoom >= 15 ? 1.0 : 1.8;
  const metroCount  = zoom >= 15 ? 6   : 4;

  // Navigate/Start buttons injected into every popup
  const navBtns = (slat, slng, sname, color) => `
    <div style="display:flex;gap:6px;margin-top:8px;">
      <button onclick="poiNavigateTo(${slat},${slng},'${sname.replace(/'/g,"\\'")}');map.closePopup();"
        style="flex:1;background:${color};color:white;border:none;border-radius:8px;padding:8px;font-size:11px;font-weight:800;cursor:pointer;font-family:inherit;">🧭 Navigate Here</button>
      <button onclick="poiSetFrom(${slat},${slng},'${sname.replace(/'/g,"\\'")}');map.closePopup();"
        style="flex:1;background:#f1f5f9;border:1px solid #e2e8f0;border-radius:8px;padding:8px;font-size:11px;font-weight:700;cursor:pointer;font-family:inherit;color:#475569;">📍 Start Here</button>
    </div>`;

  // Shimmer loading placeholder (#9)
  const shimmerLoading = `
    <div class="shimmer-line" style="width:80%;"></div>
    <div class="shimmer-line" style="width:60%;"></div>
    <div class="shimmer-line" style="width:70%;"></div>`;

  // ── Delhi Bus stops ──
  if (typeof BusEngine !== 'undefined' && BusEngine.busDataReady()) {
    BusEngine.getNearestBusStops(lat, lng, busCount, busRadius).forEach(s => {
      const key = 'bus_' + s.id;
      if (_visibleMarkers.has(key)) return; // already on map
      const ico = L.divIcon({ className:'',
        html:`<div style="background:white;border:2px solid #d97706;border-radius:50%;width:${zoom>=16?22:18}px;height:${zoom>=16?22:18}px;display:flex;align-items:center;justify-content:center;font-size:11px;box-shadow:0 2px 6px rgba(0,0,0,.25);">🚏</div>`,
        iconSize:[20,20], iconAnchor:[10,10] });
      const m = L.marker([s.lat,s.lng],{icon:ico}).addTo(stationLayer);
      m.on('click', e => { e.originalEvent._markerHandled = true; });
      m.bindPopup(`<div style="min-width:260px;font-family:-apple-system,BlinkMacSystemFont,'DM Sans',sans-serif;">
        <div style="display:flex;align-items:center;gap:10px;padding-bottom:10px;border-bottom:2px solid #f1f5f9;margin-bottom:4px;">
          <div style="width:36px;height:36px;border-radius:50%;background:#92400e;display:flex;align-items:center;justify-content:center;flex-shrink:0;font-size:18px;">🚏</div>
          <div style="min-width:0;">
            <div style="font-size:15px;font-weight:900;color:#0f172a;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${s.name}</div>
            <div style="font-size:10px;color:#64748b;font-weight:600;">Stop ${s.id} · DTC / DIMTS</div>
          </div>
        </div>
        ${shimmerLoading}
        ${navBtns(s.lat,s.lng,s.name,'#d97706')}</div>`, {maxWidth:320});
      m.on('popupopen', async () => {
        const html = await BusEngine.buildStopInfoHtml(s.id, s.name, 'bus');
        if (m.isPopupOpen()) m.getPopup().setContent(html + navBtns(s.lat,s.lng,s.name,'#d97706')).update();
      });
      _visibleMarkers.set(key, { marker: m, lat: s.lat, lng: s.lng });
    });
  }

  // ── Delhi Metro stations ──
  if (typeof MetroEngine !== 'undefined' && typeof METRO_DATA !== 'undefined') {
    MetroEngine.getNearestMetroStations(lat, lng, metroCount, metroRadius).forEach(s => {
      const key = 'metro_' + s.id;
      if (_visibleMarkers.has(key)) return; // already on map
      const color = MetroEngine.parseLineColor(
        Object.values(METRO_DATA?.routes||{}).find(r =>
          METRO_DATA.route_stops[Object.keys(METRO_DATA.routes).find(k=>METRO_DATA.routes[k]===r)]?.includes(String(s.id))
        )?.name || '') || '#1565c0';
      const ico = L.divIcon({ className:'',
        html:`<div style="background:${color};border:2px solid white;border-radius:5px;padding:3px 6px;font-size:10px;font-weight:800;color:white;white-space:nowrap;box-shadow:0 2px 6px rgba(0,0,0,.35);">🚇 ${zoom>=15?s.name:s.name.split(' ')[0]}</div>`,
        iconSize:[null,null] });
      const m = L.marker([s.lat,s.lng],{icon:ico}).addTo(stationLayer);
      m.on('click', e => { e.originalEvent._markerHandled = true; });
      m.bindPopup(`<div style="min-width:260px;font-family:-apple-system,BlinkMacSystemFont,'DM Sans',sans-serif;">
        <div style="display:flex;align-items:center;gap:10px;padding-bottom:10px;border-bottom:2px solid #f1f5f9;margin-bottom:4px;">
          <div style="width:36px;height:36px;border-radius:50%;background:${color};display:flex;align-items:center;justify-content:center;flex-shrink:0;font-size:18px;">🚇</div>
          <div style="min-width:0;">
            <div style="font-size:15px;font-weight:900;color:#0f172a;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${s.name}</div>
            <div style="font-size:10px;color:#64748b;font-weight:600;">Delhi Metro</div>
          </div>
        </div>
        ${shimmerLoading}
        ${navBtns(s.lat,s.lng,s.name,color)}</div>`, {maxWidth:320});
      m.on('popupopen', async () => {
        const html = await MetroEngine.buildMetroStopInfoHtml(s.id, s.name);
        if (m.isPopupOpen()) m.getPopup().setContent(html + navBtns(s.lat,s.lng,s.name,color)).update();
      });
      _visibleMarkers.set(key, { marker: m, lat: s.lat, lng: s.lng });
    });
  }

  // ── WMATA (DC) stations + stops ──
  if (typeof WmataEngine !== 'undefined' && WmataEngine.wmataDataReady()) {
    WmataEngine.refreshWmataOnView(lat, lng, zoom, stationLayer);
  }

  // ── NYC Subway stations ──
  if (detectedCity === 'nyc' && window._nycReady && typeof NycEngine !== 'undefined') {
    NycEngine.getNearestStations(lat, lng, metroCount + 4, metroRadius + 0.5).forEach(s => {
      const key = 'nyc_' + s.id;
      if (_visibleMarkers.has(key)) return;
      const color = NycEngine.lineColor(s.lines[0]);
      const badgesHtml = s.lines.map(l => {
        const c = NycEngine.lineColor(l);
        const tc = ['N','Q','R','W'].includes(l) ? '#000' : '#fff';
        return `<span style="background:${c};color:${tc};border-radius:50%;width:14px;height:14px;line-height:14px;text-align:center;font-size:9px;font-weight:700;display:inline-block;margin:1px;">${l}</span>`;
      }).join('');
      const ico = L.divIcon({ className:'', iconSize:[null,null],
        html:`<div style="background:white;border:2.5px solid ${color};border-radius:6px;padding:2px 5px;font-size:9px;font-weight:800;color:${color};white-space:nowrap;box-shadow:0 2px 6px rgba(0,0,0,.3);">🚇 ${zoom>=15?s.name:s.name.split('/')[0].trim()}</div>` });
      const m = L.marker([s.lat, s.lng], { icon:ico }).addTo(stationLayer);
      m.on('click', e => { e.originalEvent._markerHandled = true; });
      const adaTag = s.ada === 'full'    ? '<span style="font-size:9px;background:#e0f2fe;color:#0369a1;padding:1px 5px;border-radius:4px;margin-left:4px;">♿ Full</span>'
                   : s.ada === 'partial' ? '<span style="font-size:9px;background:#fef9c3;color:#854d0e;padding:1px 5px;border-radius:4px;margin-left:4px;">♿ Partial</span>' : '';
      const shimmer = `<div style="font-size:11px;color:#94a3b8;margin:6px 0 4px;font-style:italic;">Loading arrivals…</div>`;
      const alertHtml = _alertHtmlForLines(s.lines);
      m.bindPopup(`<div style="min-width:270px;font-family:-apple-system,BlinkMacSystemFont,'DM Sans',sans-serif;">
        <div style="display:flex;align-items:center;gap:10px;padding-bottom:10px;border-bottom:2px solid #f1f5f9;margin-bottom:6px;">
          <div style="width:36px;height:36px;border-radius:50%;background:${color};display:flex;align-items:center;justify-content:center;flex-shrink:0;font-size:18px;">🚇</div>
          <div style="min-width:0;flex:1;">
            <div style="font-size:15px;font-weight:900;color:#0f172a;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${s.name}${adaTag}</div>
            <div style="display:flex;gap:3px;flex-wrap:wrap;margin-top:3px;">${badgesHtml}</div>
          </div>
        </div>
        <div style="font-size:10px;color:#64748b;margin-bottom:4px;font-weight:600;">${s.borough||'NYC'} · ${(s.dist*1000).toFixed(0)}m away</div>
        ${alertHtml}
        <div id="arr_${key}" style="margin:4px 0;">${shimmer}</div>
        ${navBtns(s.lat,s.lng,s.name,color)}
      </div>`, { maxWidth:320 });
      m.on('popupopen', () => _fetchSubwayArrivals(key, s.gtfs_stop_ids || [], s.lines));
      _visibleMarkers.set(key, { marker:m, lat:s.lat, lng:s.lng });
    });
  }

  // ── NYC Bus stops (static MTA data) ──
  if (detectedCity === 'nyc' && window._nycReady && window.NYC_BUS_STOPS) {
    if (zoom >= 15) {
      const busRadius = zoom >= 17 ? 0.3 : zoom >= 16 ? 0.5 : 0.8;
      Object.values(window.NYC_BUS_STOPS).forEach(s => {
        const key = 'nycbus_' + s.id;
        if (_visibleMarkers.has(key)) return;
        const dist = Math.sqrt((s.lat-lat)**2 + (s.lng-lng)**2) * 111;
        if (dist > busRadius) return;
        if (!paddedBounds.contains(L.latLng(s.lat, s.lng))) return;
        const routeLabel = (s.routes||[]).slice(0,3).join(', ');
        const ico = L.divIcon({ className:'',
          html:`<div style="background:white;border:2px solid #dc2626;border-radius:50%;width:${zoom>=17?22:18}px;height:${zoom>=17?22:18}px;display:flex;align-items:center;justify-content:center;font-size:11px;box-shadow:0 2px 6px rgba(0,0,0,.25);">🚌</div>`,
          iconSize:[20,20], iconAnchor:[10,10] });
        const m = L.marker([s.lat, s.lng], { icon:ico }).addTo(stationLayer);
        m.on('click', e => { e.originalEvent._markerHandled = true; });
        m.bindPopup(`<div style="min-width:250px;font-family:-apple-system,BlinkMacSystemFont,'DM Sans',sans-serif;">
          <div style="display:flex;align-items:center;gap:10px;padding-bottom:10px;border-bottom:2px solid #f1f5f9;margin-bottom:6px;">
            <div style="width:36px;height:36px;border-radius:50%;background:#dc2626;display:flex;align-items:center;justify-content:center;flex-shrink:0;font-size:18px;">🚌</div>
            <div style="min-width:0;">
              <div style="font-size:15px;font-weight:900;color:#0f172a;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${s.name}</div>
              <div style="font-size:10px;color:#64748b;font-weight:600;">MTA Bus${routeLabel ? ' · Routes ' + routeLabel : ''}</div>
            </div>
          </div>
          <div id="arr_${key}" style="font-size:11px;color:#94a3b8;margin:4px 0 6px;font-style:italic;">Loading arrivals…</div>
          ${navBtns(s.lat,s.lng,s.name,'#dc2626')}
        </div>`, { maxWidth:300 });
        m.on('popupopen', () => _fetchBusArrivals(key, s.id, s.routes || []));
        _visibleMarkers.set(key, { marker:m, lat:s.lat, lng:s.lng });
      });
    } else if (zoom >= 13) {
      const hintKey = 'nyc_bus_hint';
      if (!_visibleMarkers.has(hintKey)) {
        const ico = L.divIcon({ className:'', iconSize:[null,null],
          html:`<div style="background:white;border:1.5px solid #dc2626;border-radius:8px;padding:3px 8px;font-size:10px;font-weight:700;color:#dc2626;box-shadow:0 1px 5px rgba(0,0,0,.2);white-space:nowrap;">🚌 Zoom in for bus stops</div>` });
        const m = L.marker([lat, lng], { icon:ico, interactive:false }).addTo(stationLayer);
        _visibleMarkers.set(hintKey, { marker:m, lat, lng });
      }
    }
  }

  // ── NYC Rail stations (LIRR + Metro-North) ──
  if (detectedCity === 'nyc' && window._nycReady && window.NYC_RAIL_STATIONS) {
    Object.values(window.NYC_RAIL_STATIONS).forEach(s => {
      const key = 'nycrl_' + s.id;
      if (_visibleMarkers.has(key)) return;
      if (!paddedBounds.contains(L.latLng(s.lat, s.lng))) return;
      const isLIRR = s.railroad === 'LIRR';
      const color  = isLIRR ? '#9E5330' : '#1A5E38';
      const emoji  = isLIRR ? '🚆' : '🚄';
      const label  = isLIRR ? 'LIRR' : 'Metro-North';
      const ico = L.divIcon({ className:'', iconSize:[null,null],
        html:`<div style="background:${color};border:2px solid white;border-radius:6px;padding:2px 6px;font-size:9px;font-weight:800;color:white;white-space:nowrap;box-shadow:0 2px 6px rgba(0,0,0,.35);">${emoji} ${zoom>=14?s.name:s.name.split(' ')[0]}</div>` });
      const adaBadge = s.ada !== 'none' ? `<span style="font-size:9px;background:#e0f2fe;color:#0369a1;padding:1px 5px;border-radius:4px;margin-left:4px;">♿ ${s.ada}</span>` : '';
      const m = L.marker([s.lat, s.lng], { icon:ico }).addTo(stationLayer);
      m.on('click', e => { e.originalEvent._markerHandled = true; });
      m.bindPopup(`<div style="min-width:250px;font-family:-apple-system,BlinkMacSystemFont,'DM Sans',sans-serif;">
        <div style="display:flex;align-items:center;gap:10px;padding-bottom:10px;border-bottom:2px solid #f1f5f9;margin-bottom:8px;">
          <div style="width:36px;height:36px;border-radius:50%;background:${color};display:flex;align-items:center;justify-content:center;flex-shrink:0;font-size:18px;">${emoji}</div>
          <div style="min-width:0;">
            <div style="font-size:15px;font-weight:900;color:#0f172a;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${s.name}${adaBadge}</div>
            <div style="font-size:10px;color:#64748b;font-weight:600;">${label} · ${s.branch}${s.zone ? ' · Zone ' + s.zone : ''}</div>
          </div>
        </div>
        ${navBtns(s.lat,s.lng,s.name,color)}
      </div>`, { maxWidth:300 });
      _visibleMarkers.set(key, { marker:m, lat:s.lat, lng:s.lng });
    });
  }

  // Remove markers that have drifted outside padded bounds
  _visibleMarkers.forEach((entry, id) => {
    if (!paddedBounds.contains(L.latLng(entry.lat, entry.lng))) {
      stationLayer.removeLayer(entry.marker);
      _visibleMarkers.delete(id);
    }
  });
}

// Show transit near a location (GPS first fix or IP fallback)
function showNearbyTransit(lat, lng) {
  const zoom = map.getZoom() || 14;
  refreshTransitOnView(lat, lng, zoom);
}

// (NYC bus stops now served from static nyc_bus_stops.js — no Overpass needed)

// ── NYC LIVE ARRIVALS ──

async function _fetchSubwayArrivals(key, gtfsStopIds, lines) {
  const el = document.getElementById('arr_' + key);
  if (!el) return;
  try {
    const params = new URLSearchParams({
      gtfs_stop_ids: (gtfsStopIds || []).join(','),
      lines: (lines || []).join(',')
    });
    const res = await fetch('/api/nyc/subway-arrivals?' + params);
    const data = await res.json();
    if (!el.isConnected) return; // popup closed
    if (!data.ok || !data.arrivals || !data.arrivals.length) {
      el.innerHTML = '<span style="font-size:10px;color:#94a3b8;">No arrivals data</span>';
      return;
    }
    // Group by routeId, keep next 2 per route
    const byRoute = {};
    data.arrivals.forEach(a => {
      if (!byRoute[a.routeId]) byRoute[a.routeId] = [];
      if (byRoute[a.routeId].length < 2) byRoute[a.routeId].push(a);
    });
    let html = '<div style="display:flex;flex-wrap:wrap;gap:4px;margin-top:4px;">';
    Object.entries(byRoute).forEach(([routeId, arr]) => {
      const color = (window.NycEngine && window.NycEngine.lineColor(routeId)) || '#888';
      const textColor = ['N','Q','R','W'].includes(routeId) ? '#000' : '#fff';
      const times = arr.map(a => a.minsAway <= 0 ? 'Now' : a.minsAway + ' min').join(', ');
      html += `<div style="display:flex;align-items:center;gap:3px;">
        <span style="background:${color};color:${textColor};border-radius:50%;width:18px;height:18px;line-height:18px;text-align:center;font-size:10px;font-weight:700;display:inline-block;">${routeId}</span>
        <span style="font-size:11px;color:#334155;">${times}</span>
      </div>`;
    });
    html += '</div>';
    const age = Math.round(Date.now() / 1000 - (data.fetchedAt || Date.now() / 1000));
    html += `<div style="font-size:9px;color:#94a3b8;margin-top:3px;">Live · ${age}s ago</div>`;
    if (el.isConnected) el.innerHTML = html;
  } catch (e) {
    if (el && el.isConnected) el.innerHTML = '<span style="font-size:10px;color:#94a3b8;">Arrivals unavailable</span>';
  }
}

async function _fetchBusArrivals(key, stopId, routes) {
  const el = document.getElementById('arr_' + key);
  if (!el) return;
  try {
    const params = new URLSearchParams({
      stop_id: stopId,
      routes: (routes || []).join(',')
    });
    const res = await fetch('/api/nyc/bus-arrivals?' + params);
    const data = await res.json();
    if (!el.isConnected) return;
    if (!data.ok || !data.arrivals || !data.arrivals.length) {
      el.innerHTML = '<span style="font-size:10px;color:#94a3b8;">No arrivals data</span>';
      return;
    }
    const byRoute = {};
    data.arrivals.forEach(a => {
      if (!byRoute[a.routeId]) byRoute[a.routeId] = [];
      if (byRoute[a.routeId].length < 2) byRoute[a.routeId].push(a);
    });
    let html = '<div style="display:flex;flex-direction:column;gap:3px;margin-top:4px;">';
    Object.entries(byRoute).forEach(([routeId, arr]) => {
      const times = arr.map(a => a.minsAway <= 0 ? 'Now' : a.minsAway + ' min').join(', ');
      html += `<div style="display:flex;align-items:center;gap:4px;">
        <span style="background:#dc2626;color:#fff;border-radius:4px;padding:1px 5px;font-size:10px;font-weight:700;">${routeId}</span>
        <span style="font-size:11px;color:#334155;">${times}</span>
      </div>`;
    });
    html += '</div>';
    const age = Math.round(Date.now() / 1000 - (data.fetchedAt || Date.now() / 1000));
    html += `<div style="font-size:9px;color:#94a3b8;margin-top:3px;">Live · ${age}s ago</div>`;
    if (el.isConnected) el.innerHTML = html;
  } catch (e) {
    if (el && el.isConnected) el.innerHTML = '<span style="font-size:10px;color:#94a3b8;">Arrivals unavailable</span>';
  }
}

// Fetch next-train wait from GTFS-RT and refine the NYC subway ETA display
async function _refinNycSubwayEta(journey) {
  if (!journey || !journey.from) return;
  const gtfsIds = journey.from.gtfs_stop_ids || [];
  const lines = journey.type === 'transfer'
    ? [journey.line1, journey.line2]
    : [journey.line];
  if (!gtfsIds.length || !lines.length) return;
  try {
    const params = new URLSearchParams({ gtfs_stop_ids: gtfsIds.join(','), lines: lines.join(',') });
    const res = await fetch('/api/nyc/subway-arrivals?' + params);
    const data = await res.json();
    if (!data.ok || !data.arrivals || !data.arrivals.length) return;
    // Find next arrival for the journey line
    const targetLine = journey.type === 'transfer' ? journey.line1 : journey.line;
    const next = data.arrivals.find(a => a.routeId === targetLine);
    if (!next || next.minsAway == null) return;
    const waitMin = Math.max(0, next.minsAway);
    const wIn  = journey.walkToStation  || 0;
    const wOut = journey.walkFromStation || 0;
    const rideMin = (journey.numStops || 6) * 2 + (journey.transfers || 0) * 4;
    const lineLabel = journey.type === 'transfer' ? `${journey.line1}→${journey.line2}` : journey.line;
    const totalMin = Math.round(wIn*12) + waitMin + rideMin + Math.round(wOut*12);
    // Update comparison panel
    const metaMel = document.getElementById('metaMetro');
    if (metaMel) metaMel.textContent = `🚇 ${totalMin} min · line ${lineLabel} · wait ${waitMin} min`;
    // Update HUD if route is active
    const hudEl = document.getElementById('hudTime');
    if (hudEl && window._activeNycJourney === journey) {
      hudEl.textContent = `${totalMin} min`;
    }
  } catch (_) { /* silent */ }
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
  updateScoreBreakdown(); // #22 — keep breakdown in sync
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

  toInput.addEventListener('focus', () => { if (!toInput.value.trim()) showDestHistory(); });
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

// ── Search result normalizers (module-level so offline fallback can use them) ──
function _normNominatim(item) {
  const parts = (item.display_name || '').split(',');
  return {
    name: parts[0].trim(),
    sub:  parts.slice(1, 3).join(', ').trim(),
    lat:  parseFloat(item.lat),
    lng:  parseFloat(item.lon),
    pid:  'nom_' + item.place_id,
  };
}
function _normPhoton(f) {
  const p   = f.properties || {};
  const addrParts = [
    p.housenumber && p.street ? `${p.housenumber} ${p.street}` : p.street,
    p.city || p.town || p.village,
    p.state,
    p.country,
  ].filter(Boolean);
  const name = p.name || addrParts[0] || 'Location';
  const sub  = addrParts.slice(p.name ? 0 : 1).slice(0, 2).join(', ');
  return {
    name,
    sub,
    lat: f.geometry.coordinates[1],
    lng: f.geometry.coordinates[0],
    pid: 'ph_' + (p.osm_type || '') + (p.osm_id || ''),
  };
}
function _normGoogle(item) {
  return {
    name: item.name,
    sub:  item.address || '',
    lat:  item.lat,
    lng:  item.lng,
    pid:  'gp_' + item.place_id,
  };
}
// Remove items from `b` that are within 130 m of any item in `a`
function _dedupResults(a, b) {
  return b.filter(s =>
    !a.some(p => L.latLng(p.lat, p.lng).distanceTo(L.latLng(s.lat, s.lng)) < 130)
  );
}
// Render one normalised result row
function _searchRow(item, field, cls = '') {
  const distM   = userLoc ? L.latLng(item.lat, item.lng).distanceTo(userLoc) : null;
  const distTxt = distM != null
    ? (distM < 1000 ? Math.round(distM) + ' m' : (distM / 1000).toFixed(1) + ' km')
    : '';
  const safeName = item.name.replace(/'/g, "\\'");
  const fn = field === 'from'
    ? `setOrigin(${item.lat},${item.lng},'${safeName}')`
    : `setDest(${item.lat},${item.lng},'${safeName}')`;
  return `<div class="result-item${cls ? ' ' + cls : ''}" onclick="${fn}">
    <div>
      <div class="result-name">${item.name}</div>
      ${item.sub ? `<div class="result-sub">${item.sub}</div>` : ''}
    </div>
    ${distTxt ? `<div class="result-dist">${distTxt}</div>` : ''}
  </div>`;
}

async function doSearch(q, field) {
  const dd = document.getElementById('resultsDropdown');

  // Build local viewbox (Nominatim only)
  let viewbox = null;
  if (userLoc) {
    const d = 0.15;  // ±0.15° ≈ 15 km
    viewbox = `${userLoc.lng - d},${userLoc.lat + d},${userLoc.lng + d},${userLoc.lat - d}`;
  } else if (detectedCity && CITY_BBOXES[detectedCity]) {
    const [a, b, c, dv] = CITY_BBOXES[detectedCity];
    viewbox = `${b},${c},${dv},${a}`;
  }

  const gpsRow = field === 'from'
    ? `<div class="result-item" onclick="useMyLocation()">
         <div><div class="result-name">📍 My Current Location</div><div class="result-sub">Use live GPS</div></div>
         <div class="result-gps">GPS</div>
       </div>`
    : '';

  try {
    const locParam = userLoc ? `&lat=${userLoc.lat}&lon=${userLoc.lng}` : '';

    // ── 1. Nominatim — local area only (viewbox + bounded) ──
    const nomProm = viewbox
      ? fetch(`https://nominatim.openstreetmap.org/search?format=json&addressdetails=1&q=${encodeURIComponent(q)}&limit=3&viewbox=${viewbox}&bounded=1${locParam}`)
          .then(r => r.json()).then(d => d.map(_normNominatim)).catch(() => [])
      : Promise.resolve([]);

    // ── 2. Photon by Komoot — OSM with Elasticsearch, far better address lookup ──
    const photonParam = userLoc ? `&lat=${userLoc.lat}&lon=${userLoc.lng}` : '';
    const photonProm = fetch(`https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=7${photonParam}`)
      .then(r => r.json()).then(d => (d.features || []).map(_normPhoton)).catch(() => []);

    // ── 3. Google Places (proxied — best for businesses & exact addresses) ──
    const gpParam = userLoc ? `&lat=${userLoc.lat}&lng=${userLoc.lng}` : '';
    const googleProm = fetch(`/api/places/search?q=${encodeURIComponent(q)}${gpParam}`)
      .then(r => r.ok ? r.json() : [])
      .then(d => Array.isArray(d) ? d.map(_normGoogle) : [])
      .catch(() => []);

    const [nomLocal, photonRaw, googleRaw] = await Promise.all([nomProm, photonProm, googleProm]);

    // Merge photon + google, dedup against local then against each other
    const photonDeduped = _dedupResults(nomLocal, photonRaw);
    const googleDeduped = _dedupResults([...nomLocal, ...photonDeduped], googleRaw);

    // Sort merged results by distance when user location is known
    const worldData = [...photonDeduped, ...googleDeduped]
      .sort((a, b) => {
        if (!userLoc) return 0;
        return L.latLng(a.lat, a.lng).distanceTo(userLoc)
             - L.latLng(b.lat, b.lng).distanceTo(userLoc);
      })
      .slice(0, 8);

    if (!nomLocal.length && !worldData.length) { closeDropdown(); return; }

    // Cache for offline fallback (normalised format)
    localStorage.setItem('gw_search_cache_' + q.slice(0, 10),
      JSON.stringify([...nomLocal, ...worldData].slice(0, 5)));

    let html = gpsRow;

    if (nomLocal.length) {
      html += `<div class="result-section">📍 Near you</div>`;
      html += nomLocal.map(i => _searchRow(i, field)).join('');
    }

    if (worldData.length) {
      html += `<div class="result-section">🔍 Results</div>`;
      html += worldData.map(i => _searchRow(i, field, 'result-world')).join('');
    }

    dd.innerHTML = html;
    dd.classList.add('open');

  } catch {
    // Offline fallback — use cached normalised results
    const cached = getCachedSearchResults(q);
    if (!cached.length) { closeDropdown(); return; }
    let html = gpsRow + `<div class="result-section">📴 Cached</div>`;
    html += cached.map(item => {
      // Support both old Nominatim format and new normalised format
      const norm = item.pid ? item : _normNominatim({ ...item, lon: item.lng || item.lon });
      return _searchRow(norm, field, 'result-world');
    }).join('');
    dd.innerHTML = html;
    dd.classList.add('open');
  }
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
  _saveDestHistory(name, lat, lon);
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
  walkabilityBase = 100; cachedMetroPlan = null; window._cachedBusJourney = null; window._cachedNycJourney = null;
  _routeLightingStats = null;

  // Loading skeleton — show card immediately with shimmer placeholders
  document.getElementById('routeCard').classList.add('active');
  ['Walk','Safe','Metro','Bus','Auto','Cycle','Multimodal'].forEach(m => {
    const meta = document.getElementById(`meta${m}`);
    if (meta) meta.innerHTML = '<span class="shimmer-line" style="width:90px;height:11px;display:inline-block;vertical-align:middle;border-radius:4px;"></span>';
    const score = document.getElementById(`score${m}`);
    if (score) score.textContent = '—';
  });

  const baseDist  = (fromLL.distanceTo(toLL) / 1000) * 1.3;
  // Route-card score = pure route quality (distance-based only).
  // Hazard penalties are applied exactly once in computeWalkabilityScore() via updateHudScore().
  // Keeping them out of baseScore prevents double-counting that drives the HUD score to 0.
  const baseScore = Math.max(40, 100 - Math.round(baseDist * 6));
  const isLong    = baseDist > 3; // long distance → show multimodal option

  simData = {
    walk:       { dist: baseDist,       score: baseScore,                  mode:'walk' },
    safe:       { dist: baseDist*1.15,  score: Math.min(98,baseScore+12), mode:'safe' },
    transit:    { dist: baseDist,       score: 80,                         mode:'transit' },
    bus:        { dist: baseDist,       score: 78,                         mode:'bus' },
    multimodal: { dist: baseDist,       score: 90,                         mode:'multimodal' },
    auto:       { dist: baseDist,       score: 65,                         mode:'auto' },
    cycle:      { dist: baseDist,       score: 82,                         mode:'cycle' },
  };

  // Walk options — always shown if walk enabled
  const walkVisible = isModeEnabled('walk');
  document.getElementById('opt-walk').style.display = walkVisible ? 'flex' : 'none';
  document.getElementById('opt-safe').style.display = walkVisible ? 'flex' : 'none';
  if (walkVisible) {
    document.getElementById('metaWalk').textContent  = `${Math.ceil(simData.walk.dist*12)} min · ${simData.walk.dist.toFixed(1)} km`;
    document.getElementById('scoreWalk').textContent = simData.walk.score;
    document.getElementById('metaSafe').textContent  = `${Math.ceil(simData.safe.dist*13)} min · ${simData.safe.dist.toFixed(1)} km`;
    document.getElementById('scoreSafe').textContent = simData.safe.score;
  }

  const busEl    = document.getElementById('nearestBusInfo');
  const busLabel = document.getElementById('busOptLabel');

  // ── NYC SUBWAY / DELHI METRO ──
  let metroFound = false;
  let nycSubwayFound = false;

  // If in NYC but scripts haven't finished loading yet, show a loading placeholder
  if (isModeEnabled('metro') && detectedCity === 'nyc' && !window._nycReady) {
    document.getElementById('opt-metro').style.display = 'flex';
    document.getElementById('metaMetro').textContent   = '🚇 Loading transit data…';
    document.getElementById('scoreMetro').textContent  = '—';
    // Re-run prepareComparison once scripts are ready
    const _waitFrom = fromLL, _waitTo = toLL;
    const _nycLoadPoll = setInterval(() => {
      if (window._nycReady) { clearInterval(_nycLoadPoll); prepareComparison(_waitFrom, _waitTo); }
    }, 300);
  }

  if (isModeEnabled('metro') && detectedCity === 'nyc' && typeof NycEngine !== 'undefined') {
    const journey = NycEngine.planJourney(fromLL.lat, fromLL.lng, toLL.lat, toLL.lng);
    if (journey && journey.type !== 'suggestion') {
      window._cachedNycJourney = journey;
      const wIn  = journey.walkToStation  || 0;
      const wOut = journey.walkFromStation || 0;
      const rideMin = (journey.numStops || 6) * 2 + (journey.transfers || 0) * 4;
      const approxMin = Math.round(wIn*12) + rideMin + Math.round(wOut*12);
      const lineLabel = journey.type === 'transfer'
        ? `${journey.line1}→${journey.line2}`
        : journey.line;
      document.getElementById('opt-metro').style.display = 'flex';
      document.getElementById('metaMetro').textContent   = `🚇 ${approxMin} min · line ${lineLabel} · ${journey.numStops||'?'} stops`;
      document.getElementById('scoreMetro').textContent  = 90;
      if (busEl) { busEl.innerHTML=`🚇 <b>${journey.from.name}</b> → <b>${journey.to.name}</b>`; busEl.style.display='block'; }
      nycSubwayFound = true;
      metroFound = true;
      // Async: refine ETA with live next-train wait time
      _refinNycSubwayEta(journey);
    } else {
      document.getElementById('opt-metro').style.display = 'none';
    }
  }

  // ── DELHI METRO ──
  if (!nycSubwayFound && isModeEnabled('metro') && typeof MetroEngine !== 'undefined' && typeof METRO_DATA !== 'undefined') {
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
          simData.transit.score = 92; simData.transit.metroMin = metroMin; simData.transit.totalStops = totalStops;
          document.getElementById('opt-metro').style.display = 'flex';
          document.getElementById('metaMetro').textContent   = `🚇 ${metroMin} min · ${totalStops} stops · walk ${(f.dist*1000).toFixed(0)}m`;
          document.getElementById('scoreMetro').textContent  = 92;
          if (busEl) { busEl.innerHTML=`🚉 <b>${f.name}</b> → <b>${t.name}</b>`; busEl.style.display='block'; }
          metroFound = true;
          break outer;
        }
      }
    }
  }

  // ── DC WMATA METRO ──
  if (!metroFound && isModeEnabled('metro') && detectedCity === 'dc' &&
      typeof WmataEngine !== 'undefined' && WmataEngine.wmataDataReady()) {
    const plan = WmataEngine.planWmataMetroJourney(fromLL.lat, fromLL.lng, toLL.lat, toLL.lng);
    if (plan) {
      window._cachedWmataPlan = plan;
      const approxMin = Math.round(plan.walkInKm*12) + 8 + Math.round(plan.walkOutKm*12);
      const lineUC = plan.line ? plan.line.charAt(0).toUpperCase() + plan.line.slice(1) : 'Metro';
      document.getElementById('opt-metro').style.display = 'flex';
      document.getElementById('metaMetro').textContent   = `🚇 ${approxMin} min · ${lineUC} Line`;
      document.getElementById('scoreMetro').textContent  = 90;
      if (busEl) { busEl.innerHTML=`🚇 <b>${plan.board.name}</b> → <b>${plan.alight.name}</b>`; busEl.style.display='block'; }
      metroFound = true;
    }
  }

  if (!metroFound && !nycSubwayFound) {
    document.getElementById('opt-metro').style.display = 'none';
  }

  // ── BUS ──
  let busFound = false;

  // ── DELHI BUS ──
  if (isModeEnabled('bus') && typeof BusEngine !== 'undefined' && BusEngine.busDataReady()) {
    const bj = BusEngine.findBusRoutes(fromLL.lat, fromLL.lng, toLL.lat, toLL.lng);
    if (bj && bj.type === 'direct') {
      const opt = bj.options[0];
      const approxMin = Math.round(bj.walkInKm*12) + opt.numStops*2 + Math.round(bj.walkOutKm*12) + 6;
      document.getElementById('opt-bus').style.display  = 'flex';
      document.getElementById('metaBus').textContent    = `🚌 ${opt.routeName} · ${approxMin} min · ${opt.numStops} stops`;
      document.getElementById('scoreBus').textContent   = 78;
      if (busLabel) busLabel.textContent = `🚌 ${opt.routeName}`;
      if (!metroFound && busEl) { busEl.innerHTML=`🚌 <b>${opt.routeName}</b> · Board: ${opt.boardStop.name}`; busEl.style.display='block'; }
      window._cachedBusJourney = bj;
      busFound = true;
    } else {
      document.getElementById('opt-bus').style.display  = 'flex';
      document.getElementById('metaBus').textContent    = `🚌 ${Math.ceil(simData.transit.dist*4)+8} min · ${simData.transit.dist.toFixed(1)} km`;
      document.getElementById('scoreBus').textContent   = simData.transit.score;
      if (busLabel) busLabel.textContent = '🚌 Bus';
    }
  }

  // ── DC WMATA BUS ──
  if (!busFound && isModeEnabled('bus') && detectedCity === 'dc' &&
      typeof WmataEngine !== 'undefined' && WmataEngine.wmataRoutesReady()) {
    const bj = WmataEngine.findWmataBusRoute(fromLL.lat, fromLL.lng, toLL.lat, toLL.lng);
    if (bj) {
      window._cachedWmataBus = bj;
      const opt = bj.options[0];
      const approxMin = Math.round(bj.walkInKm*12) + 15 + Math.round(bj.walkOutKm*12);
      document.getElementById('opt-bus').style.display = 'flex';
      document.getElementById('metaBus').textContent   = `🚌 ${opt.routeId} · ${approxMin} min`;
      document.getElementById('scoreBus').textContent  = 75;
      if (busLabel) busLabel.textContent = `🚌 ${opt.routeId}`;
      if (!metroFound && busEl) { busEl.innerHTML=`🚌 <b>${opt.routeId}</b> · Board: ${opt.boardStop.name}`; busEl.style.display='block'; }
      busFound = true;
    }
  }

  // ── NYC MTA BUS ──
  if (!busFound && isModeEnabled('bus') && detectedCity === 'nyc' && window._nycReady) {
    const bj = _findNycBusRoute(fromLL.lat, fromLL.lng, toLL.lat, toLL.lng);
    if (bj) {
      window._cachedNycBus = bj;
      const approxMin = Math.round(bj.walkInKm*12) + 15 + Math.round(bj.walkOutKm*12);
      document.getElementById('opt-bus').style.display = 'flex';
      document.getElementById('metaBus').textContent   = `🚌 ${bj.routeName} · ${approxMin} min`;
      document.getElementById('scoreBus').textContent  = 72;
      if (busLabel) busLabel.textContent = `🚌 ${bj.routeName}`;
      if (!metroFound && busEl) { busEl.innerHTML=`🚌 <b>${bj.routeName}</b> · Board: ${bj.boardStop.name}`; busEl.style.display='block'; }
      busFound = true;
    }
  }

  // ── NYC COMMUTER RAIL (LIRR / Metro-North) in metro slot when no subway found ──
  if (!metroFound && isModeEnabled('metro') && detectedCity === 'nyc' && window._nycReady) {
    const rj = _findNycRailRoute(fromLL.lat, fromLL.lng, toLL.lat, toLL.lng);
    if (rj) {
      window._cachedNycRail = rj;
      const approxMin = Math.round(rj.walkInKm*12) + 20 + Math.round(rj.walkOutKm*12);
      const rrLabel = rj.railroad === 'MNR' ? 'Metro-North' : 'LIRR';
      document.getElementById('opt-metro').style.display = 'flex';
      document.getElementById('metaMetro').textContent   = `🚆 ${approxMin} min · ${rrLabel} · ${rj.branch}`;
      document.getElementById('scoreMetro').textContent  = 85;
      metroFound = true;
    }
  }

  // ── FALLBACK: generic bus if mode enabled but no route found ──
  if (!busFound && isModeEnabled('bus')) {
    document.getElementById('opt-bus').style.display = 'flex';
    document.getElementById('metaBus').textContent   = `🚌 ${Math.ceil(simData.transit.dist*4)+8} min`;
    document.getElementById('scoreBus').textContent  = simData.transit.score;
    if (busLabel) busLabel.textContent = '🚌 Bus';
  } else if (!busFound) {
    document.getElementById('opt-bus').style.display = 'none';
  }

  // ── MULTIMODAL (long distances) ──
  // Show if distance > 3km AND at least metro or bus is enabled alongside walk
  const multimodal = isModeEnabled('walk') && (isModeEnabled('metro') || isModeEnabled('bus')) && isLong;
  document.getElementById('opt-multimodal').style.display = multimodal ? 'flex' : 'none';
  if (multimodal) {
    // Best combo: walk to nearest transit, ride, walk out
    let mmMin = 0, mmDesc = '';
    if (metroFound && cachedMetroPlan) {
      const { walkInKm, walkOutKm } = cachedMetroPlan;
      const totalStops = cachedMetroPlan.plan.filter(l=>l.type==='metro').reduce((a,l)=>a+l.numStops,0);
      mmMin  = Math.round(walkInKm*12) + totalStops*2 + Math.round(walkOutKm*12) + 4;
      mmDesc = `🚶${(walkInKm*1000).toFixed(0)}m + 🚇${totalStops} stops + 🚶${(walkOutKm*1000).toFixed(0)}m`;
    } else if (busFound && window._cachedBusJourney) {
      const bj = window._cachedBusJourney; const opt = bj.options[0];
      mmMin  = Math.round(bj.walkInKm*12) + opt.numStops*2 + Math.round(bj.walkOutKm*12) + 6;
      mmDesc = `🚶${(bj.walkInKm*1000).toFixed(0)}m + 🚌${opt.numStops} stops + 🚶${(bj.walkOutKm*1000).toFixed(0)}m`;
    } else {
      // Estimate: walk 500m to stop + ride + walk 500m
      mmMin  = Math.ceil(baseDist / 4) + 10;
      mmDesc = 'Walk + Bus/Metro combination';
    }
    simData.multimodal.mmMin = mmMin;
    document.getElementById('metaMultimodal').textContent  = `${mmMin} min · ${mmDesc}`;
    document.getElementById('scoreMultimodal').textContent = Math.min(95, baseScore + 15);
    simData.multimodal.score = Math.min(95, baseScore + 15);
  }

  // ── AUTO-RICKSHAW ──
  const autoMin = Math.ceil(baseDist / 0.5); // ~30 km/h city average
  if (isModeEnabled('auto')) {
    simData.auto.dist = baseDist;
    document.getElementById('opt-auto').style.display = 'flex';
    document.getElementById('metaAuto').textContent = `~${autoMin} min · ${baseDist.toFixed(1)} km`;
    document.getElementById('scoreAuto').textContent = 65;
  } else {
    document.getElementById('opt-auto').style.display = 'none';
  }

  // ── CYCLE ──
  const cycleMin = Math.ceil(baseDist * 60 / 15); // ~15 km/h cycling
  if (isModeEnabled('cycle')) {
    simData.cycle.dist = baseDist;
    document.getElementById('opt-cycle').style.display = 'flex';
    document.getElementById('metaCycle').textContent = `~${cycleMin} min · ${baseDist.toFixed(1)} km`;
    document.getElementById('scoreCycle').textContent = 82;
  } else {
    document.getElementById('opt-cycle').style.display = 'none';
  }

  interactiveLayer.clearLayers();
  L.marker(toLL).addTo(interactiveLayer).bindPopup(`<b>To:</b> ${activeDestName}`);
  map.flyTo(toLL, 14);
  document.getElementById('routeCard').classList.add('active');
  document.getElementById('searchBox').style.display = 'none';
  _updateCompareStrip(null); // build compare strip once all options are populated
}


// ── ROUTING ──
async function pickRoute(type) {
  document.getElementById('routeCard').classList.remove('active');
  interactiveLayer.clearLayers(); transitLayer.clearLayers();
  // multimodal uses transit routing under the hood
  currentRouteMode = type === 'multimodal' ? 'transit' : type;
  const from = activeOriginLatLng || userLoc;
  if (!from || !activeDestLatLng) { showToast('Set both locations first'); return; }
  showToast('Calculating route…');
  try {
    // Choose routing profile based on mode
    let profile;
    if      (type === 'auto')  profile = 'routed-car/route/v1/driving';
    else if (type === 'cycle') profile = 'routed-bike/route/v1/bike';
    else                       profile = 'routed-foot/route/v1/foot';
    const url = `https://routing.openstreetmap.de/${profile}/${from.lng},${from.lat};${activeDestLatLng.lng},${activeDestLatLng.lat}?overview=full&geometries=geojson&steps=true`;
    const res = await fetch(url);
    const d   = await res.json();
    showHud(type, d.routes[0], from);
  } catch { showToast('Routing failed — check connection'); }
}

// ── HUD ──
function showHud(type, route, fromLL) {
  const hud = document.getElementById('hud');
  hud.classList.add('active');
  setHudSnap('full');

  const rd     = simData[type] || simData[currentRouteMode] || simData.walk;
  const steps  = route.legs[0].steps;
  const coords = route.geometry.coordinates.map(c => [c[1], c[0]]);
  currentRouteCoords = coords; // #6 — store for off-route detection
  routeCoordsData = { footpaths:[], bridges:[], underpasses:[], crossings:[] };
  let itinHtml = '';

  // Mode-specific step verbs and icons
  const _startVerb = type==='auto' ? 'Start driving' : type==='cycle' ? 'Start cycling' : 'Start walking';
  const _contVerb  = type==='auto' ? 'Drive'          : type==='cycle' ? 'Cycle'          : 'Continue';
  const _modeIcon  = type==='auto' ? '🛺'             : type==='cycle' ? '🚲'             : null;

  steps.forEach((step, i) => {
    const loc  = [step.maneuver.location[1], step.maneuver.location[0]];
    const road = step.name ? `onto ${step.name}` : 'forward';
    const dir  = step.maneuver.modifier ? step.maneuver.modifier.replace('-',' ') : '';
    const act  = step.maneuver.type==='turn' ? `Turn ${dir}` : (i===0 ? _startVerb : _contVerb);
    const instr = `${act} ${road}`.trim();
    const low   = instr.toLowerCase();

    // Enrich with footpath type from Env (walking only — skip for driving/cycling)
    const enriched = _modeIcon ? { emoji: _modeIcon } : Env.enrichStep(instr, null);

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

  // Refine walkability score from actual OSM step data
  _routeLightingStats = null;
  if (type === 'walk' || type === 'safe') {
    const totalDist = steps.reduce((s, st) => s + (st.distance || 0), 0) || 1;
    let penalty = 0;
    steps.forEach(st => {
      const w = (st.distance || 0) / totalDist;
      const name = (st.name || '').toLowerCase();
      const ref  = (st.ref  || '').toLowerCase();
      // Penalise busy roads / highways
      if (/motorway|trunk|primary/.test(st.road_class || '')) penalty += w * 25;
      else if (/secondary|tertiary/.test(st.road_class || ''))  penalty += w * 10;
      // Penalise if step has no footway / crossing is missing
      if (!name && !ref) penalty += w * 4;
    });
    // Crossings add minor score boost — more structure = safer walk
    const crossingBonus = Math.min(8, routeCoordsData.crossings.length * 1.5);

    // Delhi: sample the real PAPL streetlight/underpass survey along the route steps
    // instead of relying only on OSM instruction text — verified underpasses replace
    // guesses from "underpass" keyword matching, and lit coverage feeds the score directly.
    let lightingBonus = 0, verifiedUnderpassBonus = 0;
    if (detectedCity === 'delhi' && typeof DelhiInfraEngine !== 'undefined' && DelhiInfraEngine.delhiStreetlightsReady()) {
      let litSamples = 0;
      const verifiedUnderpasses = [];
      steps.forEach(st => {
        const [slng, slat] = st.maneuver.location;
        if (DelhiInfraEngine.isLitPoint(slat, slng)) litSamples++;
        const up = DelhiInfraEngine.nearestSubway(slat, slng);
        if (up && !verifiedUnderpasses.some(p => Math.abs(p[0]-up.lat)<0.0003 && Math.abs(p[1]-up.lng)<0.0003)) {
          verifiedUnderpasses.push([up.lat, up.lng]);
        }
      });
      const litRatio = steps.length ? litSamples / steps.length : 0;
      lightingBonus = Math.round((litRatio - 0.5) * 16); // roughly -8..+8
      verifiedUnderpassBonus = Math.min(6, verifiedUnderpasses.length * 2);
      _routeLightingStats = { litRatio, verifiedUnderpasses: verifiedUnderpasses.length, sampled: steps.length };
      // Merge verified underpasses into the infra breakdown (more reliable than text matching)
      verifiedUnderpasses.forEach(([la, lo]) => {
        if (!routeCoordsData.underpasses.some(p => Math.abs(p[0]-la)<0.0003 && Math.abs(p[1]-lo)<0.0003)) {
          routeCoordsData.underpasses.push([la, lo]);
        }
      });
    }

    walkabilityBase = Math.max(35, Math.min(100,
      rd.score - Math.round(penalty) + Math.round(crossingBonus) + lightingBonus + verifiedUnderpassBonus));
  } else {
    walkabilityBase = rd.score;
  }

  document.getElementById('cntFoot').textContent   = routeCoordsData.footpaths.length;
  document.getElementById('cntCross').textContent  = routeCoordsData.crossings.length;
  document.getElementById('cntBridge').textContent = routeCoordsData.bridges.length;
  document.getElementById('cntUnder').textContent  = routeCoordsData.underpasses.length;
  // Safety net: guard against NaN/falsy walkabilityBase before score display
  if (!walkabilityBase || isNaN(walkabilityBase)) walkabilityBase = rd?.score || 50;
  updateHudScore();

  // Score in plain English
  const _scoreText = (s, t) => {
    if (t==='auto')  return 'Driving route · traffic may vary';
    if (t==='cycle') return 'Cycling route · check road surface';
    if (s >= 85) return 'Excellent route · minimal hazards';
    if (s >= 70) return 'Good route · some obstacles ahead';
    if (s >= 55) return 'Fair route · check hazard map';
    return 'Challenging · multiple hazards';
  };
  const _stEl = document.getElementById('hudScoreText');
  if (_stEl) _stEl.textContent = _scoreText(walkabilityBase, type);

  // Store steps for live turn-by-turn
  _routeSteps  = steps;
  _liveStepIdx = 0;

  document.getElementById('hudScore').style.color =
    type==='safe'                                         ? 'var(--safe)'    :
    (type==='transit'||type==='multimodal'||type==='bus') ? 'var(--transit)' :
    type==='auto'                                         ? '#c2410c'        :
    type==='cycle'                                        ? '#16a34a'        :
    'var(--primary)';

  const estSteps = Math.round((rd.dist*1000)/0.762);
  const estCals  = Math.round((rd.dist*1000)*0.05);

  // bus also uses the transit view (departure board + real walk legs)
  const isTransitMode = type === 'transit' || type === 'multimodal' || type === 'bus';

  // HUD time by mode
  const routeDurMin = route.duration ? Math.round(route.duration / 60) : null;
  if (type === 'auto') {
    document.getElementById('hudTime').textContent = `${routeDurMin || Math.ceil(rd.dist / 0.5)} min`;
    document.getElementById('hudTime').style.color = '#c2410c';
  } else if (type === 'cycle') {
    document.getElementById('hudTime').textContent = `${routeDurMin || Math.ceil(rd.dist * 60 / 15)} min`;
    document.getElementById('hudTime').style.color = '#16a34a';
  } else if (isTransitMode) {
    document.getElementById('hudTime').textContent = `${Math.ceil(rd.dist*4)+8} min`;
    document.getElementById('hudTime').style.color = 'var(--transit)';
  } else {
    document.getElementById('hudTime').textContent = `${Math.ceil(rd.dist*12)} min`;
    document.getElementById('hudTime').style.color = 'var(--text)';
  }

  const routeActualKm = route.legs[0].distance ? (route.legs[0].distance / 1000) : rd.dist;
  document.getElementById('hudDist').textContent  = `${routeActualKm.toFixed(2)} km`;
  document.getElementById('hudSteps').textContent = estSteps.toLocaleString();
  document.getElementById('hudCals').textContent  = estCals.toLocaleString();

  // Arrival time
  const _hudTimeMin = (() => {
    if (type==='auto')  return routeDurMin || Math.ceil(rd.dist / 0.5);
    if (type==='cycle') return routeDurMin || Math.ceil(rd.dist * 60 / 15);
    if (isTransitMode)  return Math.ceil(rd.dist*4)+8;
    return Math.ceil(rd.dist*12);
  })();
  const _arrival = new Date(Date.now() + _hudTimeMin * 60000);
  const _arrivalStr = _arrival.toLocaleTimeString([], { hour:'numeric', minute:'2-digit' });
  const _arrEl = document.getElementById('hudArrival');
  if (_arrEl) _arrEl.textContent = `Arrive ~${_arrivalStr}`;

  const stepsBox    = document.getElementById('stepsBox');
  const transitWrap = document.getElementById('transitWrap');

  if (isTransitMode) {
    stepsBox.style.display='none'; transitWrap.style.display='block';
    buildTransitView(coords, steps, rd, type);
  } else {
    transitWrap.style.display='none'; stepsBox.style.display='block';
    // For auto/cycle prepend a mode header card
    let modeHeader = '';
    if (type === 'auto') {
      modeHeader = `<div style="border-left:3px solid #c2410c;padding:8px 10px;margin-bottom:8px;display:flex;align-items:center;gap:10px;background:#f8fafc;border-radius:0 6px 6px 0;">
        <span style="font-size:20px;">🛺</span>
        <div><div style="font-size:13px;font-weight:700;color:#c2410c;">Auto Rickshaw</div>
        <div style="font-size:11px;color:var(--muted);">Driving route · ${routeActualKm.toFixed(1)} km</div></div></div>`;
    } else if (type === 'cycle') {
      modeHeader = `<div style="border-left:3px solid #16a34a;padding:8px 10px;margin-bottom:8px;display:flex;align-items:center;gap:10px;background:#f8fafc;border-radius:0 6px 6px 0;">
        <span style="font-size:20px;">🚲</span>
        <div><div style="font-size:13px;font-weight:700;color:#16a34a;">Cycling Route</div>
        <div style="font-size:11px;color:var(--muted);">Bike route · ${routeActualKm.toFixed(1)} km</div></div></div>`;
    }
    stepsBox.innerHTML = modeHeader + itinHtml;
  }

  if (!isTransitMode) {
    const color = type==='safe' ? '#7c3aed' : type==='auto' ? '#c2410c' : type==='cycle' ? '#16a34a' : '#2563eb';
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
  updateScoreBreakdown(); // #22
  updateHudModeSwitcher(type); // #7
  _updateCompareStrip(type); // compare strip active state
  // #21 — show share button
  const bShare = document.getElementById('btnShare');
  if (bShare) bShare.style.display = 'block';
  if (document.getElementById('voiceToggle')?.checked && 'speechSynthesis' in window) {
    const label = isTransitMode ? 'transit route' : type==='auto' ? 'auto rickshaw route' : type==='cycle' ? 'cycling route' : type==='safe' ? 'safest walk' : 'shortest walk';
    const minDisplay = document.getElementById('hudTime')?.textContent?.replace(' min','') || Math.ceil(rd.dist*12);
    speechSynthesis.speak(new SpeechSynthesisUtterance(`Route: ${label}. ${minDisplay} minutes.`));
  }
}

// ── NYC MTA BUS ROUTE FINDER ──
// Finds a NYC MTA bus route connecting two locations via shared route IDs on nearby stops.
function _findNycBusRoute(fromLat, fromLng, toLat, toLng) {
  if (!window.NYC_BUS_STOPS) return null;
  const nearStop = (lat, lng, n, maxKm) => {
    const res = [];
    Object.values(window.NYC_BUS_STOPS).forEach(s => {
      const d = Math.sqrt((s.lat - lat) ** 2 + (s.lng - lng) ** 2) * 111;
      if (d <= maxKm) res.push({ ...s, dist: d });
    });
    res.sort((a, b) => a.dist - b.dist);
    return res.slice(0, n);
  };
  const fromStops = nearStop(fromLat, fromLng, 10, 0.6);
  const toStops   = nearStop(toLat,   toLng,   10, 0.6);
  if (!fromStops.length || !toStops.length) return null;
  const toRouteMap = {};
  toStops.forEach(s => (s.routes || []).forEach(r => { if (!toRouteMap[r]) toRouteMap[r] = s; }));
  for (const fs of fromStops) {
    for (const r of (fs.routes || [])) {
      if (toRouteMap[r]) {
        const ts = toRouteMap[r];
        return { routeName: r, boardStop: fs, alightStop: ts, walkInKm: fs.dist, walkOutKm: ts.dist };
      }
    }
  }
  return null;
}

// ── NYC RAIL STATION FINDER ──
// Finds LIRR / Metro-North stations near both ends on the same branch.
function _findNycRailRoute(fromLat, fromLng, toLat, toLng) {
  if (!window.NYC_RAIL_STATIONS) return null;
  const nearRail = (lat, lng, maxKm) => {
    const res = [];
    Object.values(window.NYC_RAIL_STATIONS).forEach(s => {
      const d = Math.sqrt((s.lat - lat) ** 2 + (s.lng - lng) ** 2) * 111;
      if (d <= maxKm) res.push({ ...s, dist: d });
    });
    res.sort((a, b) => a.dist - b.dist);
    return res;
  };
  const fromStations = nearRail(fromLat, fromLng, 3.0);
  const toStations   = nearRail(toLat,   toLng,   3.0);
  if (!fromStations.length || !toStations.length) return null;
  // Try same railroad + branch
  for (const fs of fromStations) {
    for (const ts of toStations) {
      if (fs.id !== ts.id && fs.railroad === ts.railroad && fs.branch === ts.branch) {
        return { railroad: fs.railroad, branch: fs.branch, boardStation: fs, alightStation: ts,
                 walkInKm: fs.dist, walkOutKm: ts.dist };
      }
    }
  }
  // Fallback: same railroad, any branch
  for (const fs of fromStations) {
    for (const ts of toStations) {
      if (fs.id !== ts.id && fs.railroad === ts.railroad) {
        return { railroad: fs.railroad, branch: fs.branch || '', boardStation: fs, alightStation: ts,
                 walkInKm: fs.dist, walkOutKm: ts.dist };
      }
    }
  }
  return null;
}

// ── WALK ROUTE HELPER ──
// Fetches real walking directions between two lat/lng points.
async function _fetchWalkRoute(fromLL, toLL) {
  try {
    const url = `https://routing.openstreetmap.de/routed-foot/route/v1/foot/${fromLL.lng},${fromLL.lat};${toLL.lng},${toLL.lat}?overview=false&steps=true`;
    const r = await fetch(url);
    const d = await r.json();
    return d.routes?.[0]?.legs?.[0]?.steps || [];
  } catch { return []; }
}

// ── TRANSIT VIEW ──
async function buildTransitView(coords, steps, rd, type) {
  const tw = document.getElementById('transitWrap');

  // Helper: render a list of OSRM walk steps as HTML rows
  const mkS = (list, distLabel) => {
    if (!list || !list.length) return `<div style="font-size:11px;color:#94a3b8;padding:4px 0;">${distLabel || 'Short walk'}</div>`;
    return list.map(s => {
      const road = s.name ? `onto ${s.name}` : 'forward';
      const dir  = s.maneuver?.modifier ? s.maneuver.modifier.replace('-',' ') : '';
      const act  = s.maneuver?.type==='turn' ? `Turn ${dir}` : 'Continue';
      return `<div style="display:flex;gap:8px;padding:5px 0;border-bottom:1px solid rgba(0,0,0,.04);font-size:11px;font-weight:600;">
        <span>🚶</span><span style="flex:1;text-transform:capitalize;">${act} ${road}</span>
        <span style="color:#2563eb;font-weight:800;">${Math.round(s.distance)}m</span></div>`;
    }).join('');
  };

  // Common: user origin and destination for walk leg fetching
  const userFrom = activeOriginLatLng || userLoc;
  const userDest = activeDestLatLng;

  // Gate: metro-type sections (transit/multimodal) vs bus-type sections
  const _isMetroType = (type === 'transit' || type === 'multimodal');
  const _isBusType   = (type === 'bus');

  // ── NYC SUBWAY ──
  if (_isMetroType && window._cachedNycJourney && detectedCity === 'nyc') {
    const journey = window._cachedNycJourney;
    const wIn  = journey.walkToStation  || 0;
    const wOut = journey.walkFromStation || 0;

    // Walk legs as dashed straight lines to/from actual station coords
    const originCoord = coords[0];
    const destCoord   = coords[coords.length - 1];
    L.polyline([originCoord, [journey.from.lat, journey.from.lng]], { color:'#2563eb', weight:5, dashArray:'8,8' }).addTo(transitLayer);
    L.polyline([[journey.to.lat, journey.to.lng], destCoord],        { color:'#2563eb', weight:5, dashArray:'8,8' }).addTo(transitLayer);

    // Subway line segment — straight colored line between stations (shapes loaded separately)
    if (typeof NycEngine !== 'undefined') {
      const lineColor = journey.type === 'transfer' ? NycEngine.lineColor(journey.line1) : NycEngine.lineColor(journey.line);
      L.polyline([[journey.from.lat, journey.from.lng], [journey.to.lat, journey.to.lng]], { color:lineColor, weight:8, opacity:.9 }).addTo(transitLayer);

      const mkStn = (ll, label, c) => {
        const ico = L.divIcon({ className:'', iconSize:[null,null],
          html:`<div style="background:${c};border:2px solid white;border-radius:4px;padding:2px 5px;font-size:10px;font-weight:800;color:white;white-space:nowrap;box-shadow:0 2px 6px rgba(0,0,0,.3);">${label}</div>` });
        return L.marker(ll, { icon:ico });
      };
      mkStn([journey.from.lat, journey.from.lng], `🚇 ${journey.from.name}`, '#1565c0').addTo(stationLayer);
      mkStn([journey.to.lat,   journey.to.lng],   `🚇 ${journey.to.name}`,   '#8e24aa').addTo(stationLayer);
    }

    map.fitBounds(L.latLngBounds([
      originCoord, destCoord,
      [journey.from.lat, journey.from.lng], [journey.to.lat, journey.to.lng]
    ]), { padding:[50,50] });
    const walkMin = Math.round(wIn*12);
    const exitMin = Math.round(wOut*12);
    const rideMin = (journey.numStops || 6) * 2 + (journey.transfers || 0) * 4;
    document.getElementById('hudTime').textContent = `${walkMin + rideMin + exitMin} min`;
    // Mark as active so live ETA refiner can update HUD
    window._activeNycJourney = journey;
    // Async refine with live next-train wait
    _refinNycSubwayEta(journey);

    const journeyHtml = typeof NycEngine !== 'undefined'
      ? NycEngine.buildJourneyHtml(journey)
      : '<div style="padding:12px">NYC subway route found.</div>';

    // Fetch real walk legs
    const walkInSteps  = userFrom ? await _fetchWalkRoute(userFrom, { lat: journey.from.lat, lng: journey.from.lng }) : [];
    const walkOutSteps = userDest ? await _fetchWalkRoute({ lat: journey.to.lat, lng: journey.to.lng }, userDest) : [];

    tw.innerHTML = `
      <div style="background:rgba(37,99,235,.05);padding:10px;border-radius:10px;margin-bottom:8px;">
        <div style="font-size:10px;font-weight:800;text-transform:uppercase;color:#2563eb;margin-bottom:6px;">🚶 Walk to Subway (${(wIn*1000).toFixed(0)}m · ~${walkMin}min)</div>
        ${mkS(walkInSteps, `${(wIn*1000).toFixed(0)}m walk`)}
      </div>
      <div style="background:#e8f0fe;padding:4px;border-radius:10px;border-left:4px solid #1565c0;margin-bottom:8px;">
        ${journeyHtml}
      </div>
      <div style="background:rgba(37,99,235,.05);padding:10px;border-radius:10px;">
        <div style="font-size:10px;font-weight:800;text-transform:uppercase;color:#2563eb;margin-bottom:6px;">🚶 Walk to Destination (${(wOut*1000).toFixed(0)}m · ~${exitMin}min)</div>
        ${mkS(walkOutSteps, `${(wOut*1000).toFixed(0)}m walk`)}
      </div>`;
    return;
  }

  // ── DC WMATA METRO ──
  if (_isMetroType && window._cachedWmataPlan && detectedCity === 'dc') {
    const plan = window._cachedWmataPlan;
    const { board, alight, color, walkInKm, walkOutKm } = plan;
    const { html: wmataMetroHtml, approxMin: wmataMetroMin } =
      typeof WmataEngine !== 'undefined' ? WmataEngine.buildWmataMetroHudHtml(plan) : { html:'', approxMin:30 };

    // Map: dashed walk lines + solid metro line between stations
    const wmOrigin = coords[0];
    const wmDest   = coords[coords.length - 1];
    if (board?.lat)  L.polyline([wmOrigin, [board.lat, board.lng]],     { color:'#2563eb', weight:5, dashArray:'8,8' }).addTo(transitLayer);
    if (alight?.lat) L.polyline([[alight.lat, alight.lng], wmDest],      { color:'#2563eb', weight:5, dashArray:'8,8' }).addTo(transitLayer);
    if (board?.lat && alight?.lat)
      L.polyline([[board.lat, board.lng], [alight.lat, alight.lng]], { color: color || '#0D5CA8', weight:7, opacity:.9 }).addTo(transitLayer);
    const mkStn = (ll, label, c) => {
      const ico = L.divIcon({ className:'', iconSize:[null,null],
        html:`<div style="background:${c};border:2px solid white;border-radius:4px;padding:2px 5px;font-size:10px;font-weight:800;color:white;white-space:nowrap;box-shadow:0 2px 6px rgba(0,0,0,.3);">${label}</div>` });
      return L.marker(ll, { icon:ico });
    };
    if (board?.lat)  mkStn([board.lat,  board.lng],  `🚇 ${board.name}`,  color || '#0D5CA8').addTo(stationLayer);
    if (alight?.lat) mkStn([alight.lat, alight.lng], `🚇 ${alight.name}`, '#8e24aa').addTo(stationLayer);
    map.fitBounds(L.latLngBounds([
      wmOrigin, wmDest,
      ...(board?.lat  ? [[board.lat,  board.lng]]  : []),
      ...(alight?.lat ? [[alight.lat, alight.lng]] : [])
    ]), { padding:[50,50] });
    document.getElementById('hudTime').textContent = `${wmataMetroMin} min`;

    const walkInSteps  = (userFrom && board?.lat)  ? await _fetchWalkRoute(userFrom, { lat: board.lat,  lng: board.lng })  : [];
    const walkOutSteps = (userDest && alight?.lat) ? await _fetchWalkRoute({ lat: alight.lat, lng: alight.lng }, userDest) : [];
    const walkInMin  = Math.round(walkInKm  * 12);
    const walkOutMin = Math.round(walkOutKm * 12);

    tw.innerHTML = `
      <div style="background:rgba(37,99,235,.05);padding:10px;border-radius:10px;margin-bottom:8px;">
        <div style="font-size:10px;font-weight:800;text-transform:uppercase;color:#2563eb;margin-bottom:6px;">🚶 Walk to Metro Station (${(walkInKm*1000).toFixed(0)}m · ~${walkInMin}min)</div>
        ${mkS(walkInSteps, `${(walkInKm*1000).toFixed(0)}m walk`)}
      </div>
      <div style="background:#e8f0fe;padding:12px;border-radius:10px;border-left:4px solid ${color||'#0D5CA8'};margin-bottom:8px;">
        ${wmataMetroHtml}
      </div>
      <div style="background:rgba(37,99,235,.05);padding:10px;border-radius:10px;">
        <div style="font-size:10px;font-weight:800;text-transform:uppercase;color:#2563eb;margin-bottom:6px;">🚶 Walk to Destination (${(walkOutKm*1000).toFixed(0)}m · ~${walkOutMin}min)</div>
        ${mkS(walkOutSteps, `${(walkOutKm*1000).toFixed(0)}m walk`)}
      </div>`;
    return;
  }

  // ── NYC COMMUTER RAIL (LIRR / Metro-North) ──
  if (_isMetroType && window._cachedNycRail && detectedCity === 'nyc') {
    const rj = window._cachedNycRail;
    const { railroad, branch, boardStation, alightStation, walkInKm, walkOutKm } = rj;
    const rrLabel = railroad === 'MNR' ? 'Metro-North' : 'LIRR';
    const rrColor = railroad === 'MNR' ? '#0066CC' : '#003DA5';
    const approxMin = Math.round(walkInKm*12) + 20 + Math.round(walkOutKm*12);
    document.getElementById('hudTime').textContent = `${approxMin} min`;

    L.polyline(coords, { color: rrColor, weight:7, opacity:.9 }).addTo(transitLayer);
    const mkStn = (ll, label, c) => {
      const ico = L.divIcon({ className:'', iconSize:[null,null],
        html:`<div style="background:${c};border:2px solid white;border-radius:4px;padding:2px 5px;font-size:10px;font-weight:800;color:white;white-space:nowrap;box-shadow:0 2px 6px rgba(0,0,0,.3);">${label}</div>` });
      return L.marker(ll, { icon:ico });
    };
    mkStn([boardStation.lat, boardStation.lng],  `🚆 ${boardStation.name}`,  rrColor).addTo(stationLayer);
    mkStn([alightStation.lat, alightStation.lng], `🚆 ${alightStation.name}`, '#8e24aa').addTo(stationLayer);
    map.fitBounds(L.latLngBounds([...coords,
      [boardStation.lat, boardStation.lng], [alightStation.lat, alightStation.lng]
    ]), { padding:[50,50] });

    const walkInSteps  = userFrom ? await _fetchWalkRoute(userFrom, { lat: boardStation.lat,  lng: boardStation.lng })  : [];
    const walkOutSteps = userDest ? await _fetchWalkRoute({ lat: alightStation.lat, lng: alightStation.lng }, userDest) : [];
    const walkInMin  = Math.round(walkInKm  * 12);
    const walkOutMin = Math.round(walkOutKm * 12);

    const railCard = `
      <div style="background:white;padding:12px;border-radius:12px;border:1px solid #e2e8f0;margin-bottom:8px;">
        <div style="display:flex;align-items:center;gap:10px;">
          <div style="width:38px;height:38px;border-radius:50%;background:${rrColor};display:flex;align-items:center;justify-content:center;font-size:18px;flex-shrink:0;">🚆</div>
          <div style="flex:1;">
            <div style="font-size:13px;font-weight:800;color:${rrColor};">${rrLabel} · ${branch} Branch</div>
            <div style="font-size:11px;color:#64748b;">${boardStation.name} → ${alightStation.name}</div>
            <div style="font-size:10px;color:#94a3b8;">Zone ${boardStation.zone||'?'} → Zone ${alightStation.zone||'?'}</div>
          </div>
          <div style="text-align:right;"><div style="font-size:18px;font-weight:900;color:${rrColor};">~${approxMin}</div><div style="font-size:10px;color:#64748b;">min</div></div>
        </div>
      </div>`;

    tw.innerHTML = `
      <div style="background:rgba(37,99,235,.05);padding:10px;border-radius:10px;margin-bottom:8px;">
        <div style="font-size:10px;font-weight:800;text-transform:uppercase;color:#2563eb;margin-bottom:6px;">🚶 Walk to ${boardStation.name} (${(walkInKm*1000).toFixed(0)}m · ~${walkInMin}min)</div>
        ${mkS(walkInSteps, `${(walkInKm*1000).toFixed(0)}m walk`)}
      </div>
      ${railCard}
      <div style="background:rgba(37,99,235,.05);padding:10px;border-radius:10px;">
        <div style="font-size:10px;font-weight:800;text-transform:uppercase;color:#2563eb;margin-bottom:6px;">🚶 Walk from ${alightStation.name} (${(walkOutKm*1000).toFixed(0)}m · ~${walkOutMin}min)</div>
        ${mkS(walkOutSteps, `${(walkOutKm*1000).toFixed(0)}m walk`)}
      </div>`;
    return;
  }

  // ── DELHI METRO ──
  if (_isMetroType && cachedMetroPlan) {
    const { plan, boardStop, alightStop, walkInKm, walkOutKm } = cachedMetroPlan;
    const { html:metroHtml, approxMin, totalMetroStops } =
      await MetroEngine.buildMetroHudHtml(plan, activeOriginName, activeDestName, walkInKm, walkOutKm);

    // Map: straight dashed walk lines to/from actual station coords + metro route shape
    const originCoord = coords[0];
    const destCoord   = coords[coords.length - 1];
    L.polyline([originCoord, [boardStop.lat, boardStop.lng]],  { color:'#2563eb', weight:5, dashArray:'8,8' }).addTo(transitLayer);
    L.polyline([[alightStop.lat, alightStop.lng], destCoord],   { color:'#2563eb', weight:5, dashArray:'8,8' }).addTo(transitLayer);
    MetroEngine.drawMetroRoute(plan, transitLayer);

    const mkStn = (ll, label, c) => {
      const ico = L.divIcon({ className:'', iconSize:[null,null],
        html:`<div style="background:${c};border:2px solid white;border-radius:4px;padding:2px 5px;font-size:10px;font-weight:800;color:white;white-space:nowrap;box-shadow:0 2px 6px rgba(0,0,0,.3);">${label}</div>` });
      return L.marker(ll, { icon:ico });
    };
    mkStn([boardStop.lat,boardStop.lng], `🚇 ${boardStop.name}`, '#1565c0').addTo(stationLayer);
    mkStn([alightStop.lat,alightStop.lng], `🚇 ${alightStop.name}`, '#8e24aa').addTo(stationLayer);
    map.fitBounds(L.latLngBounds([
      originCoord, destCoord,
      [boardStop.lat, boardStop.lng], [alightStop.lat, alightStop.lng]
    ]), { padding:[50,50] });
    document.getElementById('hudTime').textContent = `${approxMin} min`;

    // Fetch real walk legs to/from metro stations
    const walkInSteps  = userFrom ? await _fetchWalkRoute(userFrom, { lat: boardStop.lat, lng: boardStop.lng }) : [];
    const walkOutSteps = userDest ? await _fetchWalkRoute({ lat: alightStop.lat, lng: alightStop.lng }, userDest) : [];
    const walkInMin    = Math.round(walkInKm * 12);
    const walkOutMin   = Math.round(walkOutKm * 12);

    tw.innerHTML = `
      <div style="background:rgba(37,99,235,.05);padding:10px;border-radius:10px;margin-bottom:8px;">
        <div style="font-size:10px;font-weight:800;text-transform:uppercase;color:#2563eb;margin-bottom:6px;">🚶 Walk to Metro Station (${(walkInKm*1000).toFixed(0)}m · ~${walkInMin}min)</div>
        ${mkS(walkInSteps, `${(walkInKm*1000).toFixed(0)}m walk`)}
      </div>
      <div style="background:#e8f0fe;padding:12px;border-radius:10px;border-left:4px solid #1565c0;margin-bottom:8px;">
        <div style="font-size:10px;font-weight:800;text-transform:uppercase;color:#1565c0;margin-bottom:8px;">🚇 Delhi Metro · ${totalMetroStops} stops · ~${approxMin} min</div>
        ${metroHtml}
      </div>
      <div style="background:rgba(37,99,235,.05);padding:10px;border-radius:10px;">
        <div style="font-size:10px;font-weight:800;text-transform:uppercase;color:#2563eb;margin-bottom:6px;">🚶 Walk to Destination (${(walkOutKm*1000).toFixed(0)}m · ~${walkOutMin}min)</div>
        ${mkS(walkOutSteps, `${(walkOutKm*1000).toFixed(0)}m walk`)}
      </div>`;
    return;
  }

  // ── DC WMATA BUS ──
  if (_isBusType && window._cachedWmataBus && detectedCity === 'dc') {
    const bj = window._cachedWmataBus;
    const { html: wmataBusHtml, approxMin: wmataBusMin, routeId, boardStop: wBoardStop, alightStop: wAlightStop } =
      typeof WmataEngine !== 'undefined' ? WmataEngine.buildWmataBusHudHtml(bj) : { html:'', approxMin:30 };
    document.getElementById('hudTime').textContent = `${wmataBusMin} min`;
    const wBoardLL  = wBoardStop?.lat  ? { lat: wBoardStop.lat,  lng: wBoardStop.lng  } : null;
    const wAlightLL = wAlightStop?.lat ? { lat: wAlightStop.lat, lng: wAlightStop.lng } : null;

    // Draw route shape on map
    if (typeof WmataEngine !== 'undefined' && routeId) WmataEngine.drawWmataBusRoute(routeId, transitLayer);
    if (wBoardLL)  L.polyline([coords[0], [wBoardLL.lat,  wBoardLL.lng]],  { color:'#2563eb', weight:5, dashArray:'8,8' }).addTo(transitLayer);
    if (wAlightLL) L.polyline([[wAlightLL.lat, wAlightLL.lng], coords[coords.length-1]], { color:'#2563eb', weight:5, dashArray:'8,8' }).addTo(transitLayer);
    const mkLbl = (ll, label, c) => {
      const ico = L.divIcon({ className:'', iconSize:[null,null],
        html:`<div style="background:${c};border:2px solid white;border-radius:6px;padding:2px 6px;font-size:9px;font-weight:800;color:white;white-space:nowrap;box-shadow:0 2px 5px rgba(0,0,0,.3);">${label}</div>` });
      return L.marker(ll, { icon:ico });
    };
    if (wBoardLL)  mkLbl([wBoardLL.lat,  wBoardLL.lng],  `🚏 ${wBoardStop.name}`,  '#E97F1B').addTo(stationLayer);
    if (wAlightLL) mkLbl([wAlightLL.lat, wAlightLL.lng], `🚏 ${wAlightStop.name}`, '#475569').addTo(stationLayer);
    map.fitBounds(L.polyline(coords).getBounds(), { padding:[50,50] });

    const walkInSteps  = (userFrom && wBoardLL)  ? await _fetchWalkRoute(userFrom, wBoardLL)  : [];
    const walkOutSteps = (userDest && wAlightLL) ? await _fetchWalkRoute(wAlightLL, userDest) : [];
    const walkInMin  = Math.round(bj.walkInKm  * 12);
    const walkOutMin = Math.round(bj.walkOutKm * 12);
    const bName = wBoardStop?.name  || 'Bus Stop';
    const aName = wAlightStop?.name || 'Bus Stop';

    tw.innerHTML = `
      <div style="background:rgba(37,99,235,.05);padding:10px;border-radius:10px;margin-bottom:8px;">
        <div style="font-size:10px;font-weight:800;text-transform:uppercase;color:#2563eb;margin-bottom:6px;">🚶 Walk to Bus Stop — ${bName} (${(bj.walkInKm*1000).toFixed(0)}m · ~${walkInMin}min)</div>
        ${mkS(walkInSteps, `${(bj.walkInKm*1000).toFixed(0)}m walk`)}
      </div>
      <div style="background:#fff7ed;padding:4px;border-radius:10px;border-left:4px solid #E97F1B;margin-bottom:8px;">
        ${wmataBusHtml}
      </div>
      <div style="background:rgba(37,99,235,.05);padding:10px;border-radius:10px;">
        <div style="font-size:10px;font-weight:800;text-transform:uppercase;color:#2563eb;margin-bottom:6px;">🚶 Walk from ${aName} to Destination (${(bj.walkOutKm*1000).toFixed(0)}m · ~${walkOutMin}min)</div>
        ${mkS(walkOutSteps, `${(bj.walkOutKm*1000).toFixed(0)}m walk`)}
      </div>`;
    return;
  }

  // ── NYC MTA BUS ──
  if (_isBusType && window._cachedNycBus && detectedCity === 'nyc') {
    const bj = window._cachedNycBus;
    const { routeName, boardStop: nBoardStop, alightStop: nAlightStop, walkInKm: nWalkIn, walkOutKm: nWalkOut } = bj;
    const approxMin = Math.round(nWalkIn*12) + 15 + Math.round(nWalkOut*12);
    document.getElementById('hudTime').textContent = `${approxMin} min`;

    L.polyline(coords, { color:'#CC0000', weight:6, opacity:.85 }).addTo(transitLayer);
    const mkLbl = (ll, label, c) => {
      const ico = L.divIcon({ className:'', iconSize:[null,null],
        html:`<div style="background:${c};border:2px solid white;border-radius:6px;padding:2px 6px;font-size:9px;font-weight:800;color:white;white-space:nowrap;box-shadow:0 2px 5px rgba(0,0,0,.3);">${label}</div>` });
      return L.marker(ll, { icon:ico });
    };
    mkLbl([nBoardStop.lat,  nBoardStop.lng],  `🚏 ${nBoardStop.name}`,  '#CC0000').addTo(stationLayer);
    mkLbl([nAlightStop.lat, nAlightStop.lng], `🚏 ${nAlightStop.name}`, '#475569').addTo(stationLayer);
    map.fitBounds(L.latLngBounds([...coords, [nBoardStop.lat, nBoardStop.lng], [nAlightStop.lat, nAlightStop.lng]]), { padding:[50,50] });

    const walkInSteps  = userFrom ? await _fetchWalkRoute(userFrom, { lat: nBoardStop.lat,  lng: nBoardStop.lng })  : [];
    const walkOutSteps = userDest ? await _fetchWalkRoute({ lat: nAlightStop.lat, lng: nAlightStop.lng }, userDest) : [];
    const walkInMin  = Math.round(nWalkIn  * 12);
    const walkOutMin = Math.round(nWalkOut * 12);

    const mtaBusCard = `
      <div style="background:white;padding:12px;border-radius:12px;border:1px solid #e2e8f0;margin-bottom:8px;">
        <div style="display:flex;align-items:center;gap:10px;">
          <div style="width:38px;height:38px;border-radius:50%;background:#CC0000;display:flex;align-items:center;justify-content:center;font-size:18px;flex-shrink:0;">🚌</div>
          <div style="flex:1;">
            <div style="font-size:13px;font-weight:800;color:#CC0000;">MTA Bus · Route ${routeName}</div>
            <div style="font-size:11px;color:#64748b;">${nBoardStop.name} → ${nAlightStop.name}</div>
          </div>
          <div style="text-align:right;"><div style="font-size:18px;font-weight:900;color:#CC0000;">~${approxMin}</div><div style="font-size:10px;color:#64748b;">min</div></div>
        </div>
      </div>`;

    tw.innerHTML = `
      <div style="background:rgba(37,99,235,.05);padding:10px;border-radius:10px;margin-bottom:8px;">
        <div style="font-size:10px;font-weight:800;text-transform:uppercase;color:#2563eb;margin-bottom:6px;">🚶 Walk to Bus Stop — ${nBoardStop.name} (${(nWalkIn*1000).toFixed(0)}m · ~${walkInMin}min)</div>
        ${mkS(walkInSteps, `${(nWalkIn*1000).toFixed(0)}m walk`)}
      </div>
      ${mtaBusCard}
      <div style="background:rgba(37,99,235,.05);padding:10px;border-radius:10px;">
        <div style="font-size:10px;font-weight:800;text-transform:uppercase;color:#2563eb;margin-bottom:6px;">🚶 Walk from ${nAlightStop.name} to Destination (${(nWalkOut*1000).toFixed(0)}m · ~${walkOutMin}min)</div>
        ${mkS(walkOutSteps, `${(nWalkOut*1000).toFixed(0)}m walk`)}
      </div>`;
    return;
  }

  // ── DELHI BUS (+ generic bus fallback) ──
  if (_isBusType) {
    const busJourney = window._cachedBusJourney;
    let busCardHtml = '';
    let busWalkInKm = 0, busWalkOutKm = 0;
    let busBoardLL = null, busAlightLL = null;

    if (busJourney && busJourney.type === 'direct') {
      const built = await BusEngine.buildBusHudHtml(busJourney);
      busCardHtml   = built.html;
      busWalkInKm   = busJourney.walkInKm  || 0;
      busWalkOutKm  = busJourney.walkOutKm || 0;
      busBoardLL    = built.boardStop?.lat  ? { lat: built.boardStop.lat,  lng: built.boardStop.lng  } : null;
      busAlightLL   = built.alightStop?.lat ? { lat: built.alightStop.lat, lng: built.alightStop.lng } : null;

      // Map: dashed walk legs + solid bus route
      const allPts = [...(busBoardLL ? [[busBoardLL.lat,busBoardLL.lng]] : []),
                      ...(busAlightLL ? [[busAlightLL.lat,busAlightLL.lng]] : [])];
      map.fitBounds(L.latLngBounds([...coords, ...allPts]), { padding:[50,50] });
      if (busBoardLL)  L.polyline([coords[0], [busBoardLL.lat,busBoardLL.lng]],  { color:'#2563eb', weight:5, dashArray:'8,8' }).addTo(transitLayer);
      if (busAlightLL) L.polyline([[busAlightLL.lat,busAlightLL.lng], coords[coords.length-1]], { color:'#2563eb', weight:5, dashArray:'8,8' }).addTo(transitLayer);
      L.polyline(coords, { color:built.agencyColor, weight:8, opacity:.9 }).addTo(transitLayer);
      const mkLbl = (ll, label, c) => {
        const ico = L.divIcon({ className:'', iconSize:[null,null],
          html:`<div style="background:${c};border:2px solid white;border-radius:6px;padding:2px 6px;font-size:9px;font-weight:800;color:white;white-space:nowrap;box-shadow:0 2px 5px rgba(0,0,0,.3);">${label}</div>` });
        return L.marker(ll, { icon:ico });
      };
      if (busBoardLL)  mkLbl([busBoardLL.lat,  busBoardLL.lng],  `🚏 ${built.boardStop.name}`,  built.agencyColor).addTo(stationLayer);
      if (busAlightLL) mkLbl([busAlightLL.lat, busAlightLL.lng], `🚏 ${built.alightStop.name}`, '#475569').addTo(stationLayer);
      document.getElementById('hudTime').textContent = `${built.approxMin} min`;
    } else {
      // No bus data found — show generic nearest-stop card
      map.fitBounds(L.polyline(coords).getBounds(), { padding:[50,50] });
      L.polyline(coords, { color:'#d97706', weight:6, opacity:.85 }).addTo(transitLayer);
      const midCoord = coords[Math.floor(coords.length/2)] || coords[0];
      const ns = typeof getNearestBusStops === 'function' ? getNearestBusStops(midCoord[0], midCoord[1], 1, 0.8) : [];
      const sn = ns.length ? ns[0].name : 'Nearest Bus Stop';
      const agencyLabel = detectedCity === 'dc' ? 'WMATA Metrobus' : detectedCity === 'nyc' ? 'MTA Bus' : 'DTC / DIMTS Bus';
      busCardHtml = `<div style="background:white;padding:12px;border-radius:10px;border:1px solid #e2e8f0;margin-bottom:8px;">
        <div style="display:flex;align-items:center;gap:10px;">
          <div style="width:38px;height:38px;border-radius:50%;background:#d97706;display:flex;align-items:center;justify-content:center;font-size:18px;flex-shrink:0;">🚌</div>
          <div style="flex:1;">
            <div style="font-size:13px;font-weight:800;color:#d97706;">${agencyLabel}</div>
            <div style="font-size:10px;color:#64748b;">Board near: ${sn}</div>
          </div>
        </div></div>`;
    }

    // Fetch real walk directions to/from bus stops
    const busWalkInSteps  = (userFrom && busBoardLL)  ? await _fetchWalkRoute(userFrom, busBoardLL)  : [];
    const busWalkOutSteps = (userDest && busAlightLL)  ? await _fetchWalkRoute(busAlightLL, userDest) : [];
    const busWalkInMin    = Math.round(busWalkInKm  * 12);
    const busWalkOutMin   = Math.round(busWalkOutKm * 12);
    const boardName  = busJourney?.boardStop?.name  || 'Bus Stop';
    const alightName = busJourney?.alightStop?.name || 'Bus Stop';

    tw.innerHTML = `
      <div style="background:rgba(37,99,235,.05);padding:10px;border-radius:10px;margin-bottom:8px;">
        <div style="font-size:10px;font-weight:800;text-transform:uppercase;color:#2563eb;margin-bottom:6px;">🚶 Walk to Bus Stop — ${boardName} (${(busWalkInKm*1000).toFixed(0)}m · ~${busWalkInMin}min)</div>
        ${mkS(busWalkInSteps, `${(busWalkInKm*1000).toFixed(0)}m walk`)}
      </div>
      ${busCardHtml}
      <div style="background:rgba(37,99,235,.05);padding:10px;border-radius:10px;">
        <div style="font-size:10px;font-weight:800;text-transform:uppercase;color:#2563eb;margin-bottom:6px;">🚶 Walk from ${alightName} to Destination (${(busWalkOutKm*1000).toFixed(0)}m · ~${busWalkOutMin}min)</div>
        ${mkS(busWalkOutSteps, `${(busWalkOutKm*1000).toFixed(0)}m walk`)}
      </div>`;
    return;
  }

  // ── METRO FALLBACK (no data found for metro type) ──
  map.fitBounds(L.polyline(coords).getBounds(), { padding:[50,50] });
  L.polyline(coords, { color:'#1565c0', weight:6, opacity:.7, dashArray:'8,8' }).addTo(transitLayer);
  tw.innerHTML = `<div style="padding:16px;color:#64748b;font-size:13px;text-align:center;">
    <div style="font-size:24px;margin-bottom:8px;">🚇</div>
    <div style="font-weight:700;color:#1e293b;margin-bottom:4px;">No transit route found</div>
    <div style="font-size:11px;">No metro or subway connection found between these locations.</div>
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
  setHudSnap('half');
  // Show live step card
  _liveStepIdx = 0;
  _updateLiveStepCard();
  const _sc = document.getElementById('liveStepCard');
  if (_sc) _sc.classList.add('active');
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
  setHudSnap('full');
  const _sc = document.getElementById('liveStepCard');
  if (_sc) _sc.classList.remove('active');
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
async function quickHazard(type) {
  const loc = userLoc;
  if (!loc) { showToast('Waiting for GPS…'); return; }
  closeModal('hazardModal');

  // Pending marker — pulsing ring, slightly translucent until DB confirms
  const icoPending = L.divIcon({ className:'',
    html:`<div style="background:#f97316;width:14px;height:14px;border-radius:50%;border:2px solid white;box-shadow:0 0 0 5px rgba(249,115,22,.35);opacity:.8;"></div>`,
    iconSize:[14,14], iconAnchor:[7,7] });
  const pendingMarker = L.marker(loc, { icon: icoPending, zIndexOffset: 500 })
    .addTo(hazardLayer).bindPopup(`<b>${type}</b> — saving…`).openPopup();

  // Update local state immediately for UX
  localHazards.push({ type, lat: loc.lat, lng: loc.lng, ts: Date.now() });
  Env.addEnvironmentReport(type, loc.lat, loc.lng);
  updateHudScore();
  addIntelCard(type, loc.lat, loc.lng);
  refreshVaultStats();

  // Save to DB — await the result
  const result = await saveHazardToDB(type, loc.lat, loc.lng, {
    surface:        lastSurfaceResult?.surface || null,
    canopy:         Env.getCanopy(),
    lighting:       Env.getLighting(),
    footpath_type:  lastSurfaceResult?.footpathType || null,
    footpath_width: lastSurfaceResult?.width || null,
  });

  // Replace pending marker with final marker
  hazardLayer.removeLayer(pendingMarker);
  if (result.ok) {
    const icoSaved = L.divIcon({ className:'',
      html:`<div style="background:#dc2626;width:10px;height:10px;border-radius:50%;border:2px solid white;opacity:.75;"></div>`,
      iconSize:[10,10], iconAnchor:[5,5] });
    L.marker(loc, { icon: icoSaved }).addTo(hazardLayer).bindPopup(`<b>${type}</b>`);
    showToast(`✅ ${type} saved`);
    // Sync full list from DB so everyone on this device sees the latest
    setTimeout(() => loadHazardsFromDB(true), 600);
  } else {
    // DB save failed — keep orange marker to signal it's unsynced
    const icoFailed = L.divIcon({ className:'',
      html:`<div style="background:#f97316;width:10px;height:10px;border-radius:50%;border:2px solid white;opacity:.75;" title="Not synced"></div>`,
      iconSize:[10,10], iconAnchor:[5,5] });
    L.marker(loc, { icon: icoFailed }).addTo(hazardLayer)
      .bindPopup(`<b>${type}</b><br><small style="color:#f97316;">⚠ Not saved to server</small>`);
    // Queue for retry next time the app has a DB connection
    _queueHazard(type, loc.lat, loc.lng, {
      surface:        lastSurfaceResult?.surface || null,
      canopy:         Env.getCanopy(),
      lighting:       Env.getLighting(),
      footpath_type:  lastSurfaceResult?.footpathType || null,
      footpath_width: lastSurfaceResult?.width || null,
    });
    showToast(`⚠️ Saved locally — will sync when DB is back`, 5000);
    console.warn('Hazard DB save failed:', result.error);
  }
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
      const cv = document.getElementById('photoCanvas'), ctx = cv.getContext('2d');
      cv.width = 400; cv.height = (img.height / img.width) * 400;
      ctx.drawImage(img, 0, 0, cv.width, cv.height);
      const b64 = cv.toDataURL('image/jpeg', .7).split(',')[1];
      st.textContent = '🔍 AI analysing…';
      try {
        const res  = await fetch(`${API}/api/vision`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ image_b64: b64 }),
        });
        const data = await res.json();

        if (data.error) throw new Error(data.error);

        if (!data.relevant || !data.hazard) {
          // Not a walkability hazard — don't log anything
          st.style.color = '#94a3b8';
          st.textContent = '🤷 No walkability hazard detected';
          setTimeout(() => { st.textContent = ''; st.style.color = ''; }, 3000);
          return;
        }

        // Show what was detected with short description
        const display = data.label ? `${data.hazard} — ${data.label}` : data.hazard;
        st.style.color = '#16a34a';
        st.textContent = `✔ ${display}`;

        // Log the classified hazard type (not a generic "📸 …" label)
        setTimeout(() => {
          quickHazard(data.hazard);
          st.textContent = '';
          st.style.color = '';
          closeModal('hazardModal');
        }, 1800);

      } catch (err) {
        console.warn('Vision error:', err.message);
        st.style.color = '#dc2626';
        st.textContent = '⚠ AI offline — tap a hazard type manually';
        setTimeout(() => { st.textContent = ''; st.style.color = ''; }, 3000);
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
    document.getElementById('searchBox').style.display = '';
    document.getElementById('inputFrom').value=''; document.getElementById('inputTo').value='';
    activeOriginLatLng=null; activeOriginName=''; activeDestLatLng=null; activeDestName='';
    if (originMarker) { map.removeLayer(originMarker); originMarker=null; }
    document.getElementById('nearestBusInfo').style.display='none';
    cachedMetroPlan=null; window._cachedBusJourney=null; window._cachedNycJourney=null;
    window._cachedWmataPlan=null; window._cachedWmataBus=null; window._activeNycJourney=null;
    window._cachedNycBus=null; window._cachedNycRail=null;
    // #3 — clear marker registry
    stationLayer.clearLayers(); _visibleMarkers.clear();
    // #6 — clear route coords
    currentRouteCoords = []; offRouteCount = 0;
    // #21 — hide share button
    const bs = document.getElementById('btnShare'); if(bs) bs.style.display='none';
  }
  // Do NOT clear transit caches on clearInputs=false — pickRoute needs them intact
}

// ── POI ACTION SHEET ──
let _poiLat=null, _poiLng=null, _poiName='';

async function showPoiSheet(lat, lng, knownName) {
  _poiLat=lat; _poiLng=lng; _poiName=knownName||'';
  document.getElementById('poiSheetName').textContent   = knownName || '📍 Fetching place…';
  document.getElementById('poiSheetAddr').textContent   = '';
  document.getElementById('poiSheetCoords').textContent = `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
  openModal('poiModal');
  if (!knownName) {
    try {
      const r = await fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}&zoom=18&addressdetails=1`);
      const d = await r.json();
      if (!document.getElementById('poiModal').classList.contains('active')) return;
      const parts = (d.display_name||'').split(',');
      _poiName = d.name || parts[0] || 'Dropped Pin';
      document.getElementById('poiSheetName').textContent = _poiName;
      document.getElementById('poiSheetAddr').textContent = parts.slice(1,3).join(', ').trim();
    } catch {
      _poiName='Dropped Pin';
      document.getElementById('poiSheetName').textContent='📍 Dropped Pin';
    }
  }
}

function poiNavigateTo(lat, lng, name) {
  if (lat!=null) { _poiLat=lat; _poiLng=lng; _poiName=name||''; }
  closeModal('poiModal');
  if (_poiLat==null) return;
  setDest(_poiLat, _poiLng, _poiName||'Selected Location');
  // Switch to Explore tab
  document.querySelectorAll('.bottom-nav .nav-item').forEach(n=>n.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(t=>t.classList.remove('active'));
  const nav=document.querySelector('[data-target="explore-tab"]');
  const tab=document.getElementById('explore-tab');
  if (nav) nav.classList.add('active');
  if (tab) { tab.classList.add('active'); setTimeout(()=>map.invalidateSize(),100); }
}

function poiSetFrom(lat, lng, name) {
  if (lat!=null) { _poiLat=lat; _poiLng=lng; _poiName=name||''; }
  closeModal('poiModal');
  if (_poiLat==null) return;
  setOrigin(_poiLat, _poiLng, _poiName||'Selected Location');
}

function poiReportHazard() {
  closeModal('poiModal');
  openModal('hazardModal');
}

// ── HUD 3-STATE SNAP ──
function setHudSnap(state) {
  hudSnap    = state;
  isMinimized = state !== 'full'; // backward compat
  const hud     = document.getElementById('hud');
  const btnLbl  = document.getElementById('btnMiniToggle');
  const restore = document.getElementById('hudRestoreBtn');

  hud.classList.remove('snap-peek', 'snap-half');
  if (state === 'peek') hud.classList.add('snap-peek');
  else if (state === 'half') hud.classList.add('snap-half');

  if (state === 'peek') {
    if (btnLbl) btnLbl.textContent = '▲ Max';
    if (restore) {
      const time = document.getElementById('hudTime')?.textContent || '';
      const dist = document.getElementById('hudDist')?.textContent || '';
      restore.textContent = `🚶 ${time} · ${dist} · tap to expand`;
      restore.classList.add('visible');
    }
  } else if (state === 'half') {
    if (btnLbl) btnLbl.textContent = '▼ Min';
    if (restore) restore.classList.remove('visible');
  } else {
    if (btnLbl) btnLbl.textContent = '▼ Min';
    if (restore) restore.classList.remove('visible');
  }
}

// Pill handle tap → cycles full→half→peek→full
function toggleMini() {
  if (hudSnap === 'full')       setHudSnap('half');
  else if (hudSnap === 'half')  setHudSnap('peek');
  else                          setHudSnap('full');
}

// Swipe-down on pill handle to snap down; swipe-up to snap up
(function _initPillSwipe() {
  let _ty0 = 0;
  document.addEventListener('touchstart', e => {
    if (e.target.closest('.pill-handle')) _ty0 = e.touches[0].clientY;
  }, { passive: true });
  document.addEventListener('touchend', e => {
    if (!e.target.closest('.pill-handle')) return;
    const dy = e.changedTouches[0].clientY - _ty0;
    if (Math.abs(dy) < 30) return; // too small — treat as tap
    if (dy > 0) { // swipe down
      if (hudSnap === 'full')      setHudSnap('half');
      else if (hudSnap === 'half') setHudSnap('peek');
    } else { // swipe up
      if (hudSnap === 'peek')      setHudSnap('half');
      else if (hudSnap === 'half') setHudSnap('full');
    }
  }, { passive: true });
})();

function toggleTrees() {
  if (treeLayer) { map.removeLayer(treeLayer); treeLayer=null; showToast('Tree cover hidden'); }
  else { treeLayer=L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',{opacity:.4}).addTo(map); showToast('Tree canopy layer active'); }
}

function refreshVaultStats() {
  const el = document.getElementById('vHazards');
  if (el) el.textContent = localHazards.length;
}

// #7 — HUD mode switcher
function updateHudModeSwitcher(activeType) {
  const sw = document.getElementById('hudModeSwitcher');
  if (!sw) return;
  const modes = [];
  if (simData.walk)                modes.push({ type:'walk',    label:'🚶 Walk',  color:'#2563eb' });
  if (cachedMetroPlan)             modes.push({ type:'transit', label:'🚇 Metro', color:'#1565c0' });
  if (window._cachedBusJourney)    modes.push({ type:'bus',     label:'🚌 Bus',   color:'#d97706' });
  if (modes.length > 1) {
    sw.style.display = 'flex';
    sw.innerHTML = modes.map(m => `
      <button class="hud-mode-tab${m.type===activeType?' active':''}"
        onclick="pickRoute('${m.type}')"
        style="${m.type===activeType?'color:'+m.color+';border-bottom-color:'+m.color+';':''}">
        ${m.label}
      </button>`).join('');
  } else {
    sw.style.display = 'none';
  }
}

// #22 — Walkability score breakdown
function updateScoreBreakdown() {
  const el = document.getElementById('scoreBreakdown');
  if (!el) return;
  const items = [
    { label: 'Footpaths',     val: Math.min(100, routeCoordsData.footpaths.length * 4),  color:'#2563eb', icon:'🚶' },
    { label: 'Shade / Canopy',val: ({dense:90,partial:60,open:30,unknown:50})[Env.getCanopy()]||50, color:'#16a34a', icon:'🌳' },
    { label: 'Crossings',     val: Math.max(0, 100 - routeCoordsData.crossings.length * 8), color:'#d97706', icon:'🚦' },
    { label: 'Hazard density',val: Math.max(0, 100 - localHazards.length * 12),          color:'#dc2626', icon:'⚠️' },
  ];
  // Real PAPL survey data (Delhi only) — replaces the synthetic estimate with measured lit coverage
  if (_routeLightingStats) {
    items.push({
      label: `Street Lighting (${_routeLightingStats.verifiedUnderpasses} underpass${_routeLightingStats.verifiedUnderpasses===1?'':'es'} verified)`,
      val:   Math.round(_routeLightingStats.litRatio * 100),
      color: '#d97706', icon: '💡',
    });
  }
  el.innerHTML = items.map(i => `
    <div style="margin-bottom:10px;">
      <div style="display:flex;justify-content:space-between;font-size:12px;font-weight:700;margin-bottom:3px;">
        <span>${i.icon} ${i.label}</span><span style="color:${i.color};">${i.val}</span>
      </div>
      <div style="background:#f1f5f9;border-radius:6px;height:8px;overflow:hidden;">
        <div style="width:${i.val}%;height:100%;background:${i.color};border-radius:6px;transition:width .4s;"></div>
      </div>
    </div>`).join('');
}

// #21 — Share route
function shareRoute() {
  const from = activeOriginLatLng || userLoc;
  if (!from || !activeDestLatLng) return;
  const url = `${location.origin}${location.pathname}?from=${from.lat.toFixed(5)},${from.lng.toFixed(5)}&to=${activeDestLatLng.lat.toFixed(5)},${activeDestLatLng.lng.toFixed(5)}&fn=${encodeURIComponent(activeOriginName||'Origin')}&tn=${encodeURIComponent(activeDestName||'Destination')}&mode=${currentRouteMode}`;
  if (navigator.share) {
    navigator.share({ title: 'GaitWay Route', text: `${activeOriginName||'Origin'} → ${activeDestName}`, url });
  } else {
    navigator.clipboard?.writeText(url).then(() => showToast('Link copied!')).catch(() => showToast(url));
  }
}

// Hazard heatmap toggle
async function toggleHeatmap() {
  if (heatLayer) { map.removeLayer(heatLayer); heatLayer=null; showToast('Heatmap hidden'); return; }
  try {
    const res = await fetch(`${API}/api/hazards?limit=1000`);
    const hazards = await res.json();
    if (!hazards.length) { showToast('No hazard data yet'); return; }
    const pts = hazards.map(h => [h.lat, h.lng, 1.0]);
    heatLayer = L.heatLayer(pts, { radius:25, blur:20, maxZoom:17, gradient:{0.4:'blue',0.65:'lime',1:'red'} }).addTo(map);
    showToast(`Heatmap: ${hazards.length} hazards`);
  } catch(e) { showToast('Could not load heatmap'); }
}

// ── DELHI STREETLIGHT DENSITY (PAPL survey, ~39.7k points) ──
function _refreshStreetlightHeat() {
  if (!streetlightHeatLayer || typeof DelhiInfraEngine === 'undefined') return;
  const b = map.getBounds();
  const pts = DelhiInfraEngine.getStreetlightsInView(b.getSouth(), b.getWest(), b.getNorth(), b.getEast())
    .map(([lat, lng, cnt]) => [lat, lng, Math.min(1, cnt / 5)]);
  streetlightHeatLayer.setLatLngs(pts);
}

function toggleDelhiStreetlights() {
  const btn = document.getElementById('btnDelhiStreetlights');
  if (streetlightHeatLayer) {
    map.removeLayer(streetlightHeatLayer);
    streetlightHeatLayer = null;
    if (btn) btn.classList.remove('active-layer');
    showToast('Streetlights hidden');
    return;
  }
  if (typeof DelhiInfraEngine === 'undefined' || !DelhiInfraEngine.delhiStreetlightsReady()) {
    showToast('Streetlight data still loading…');
    return;
  }
  streetlightHeatLayer = L.heatLayer([], { radius:14, blur:12, maxZoom:18, gradient:{0.3:'#1e3a8a',0.6:'#d97706',1:'#facc15'} }).addTo(map);
  if (btn) btn.classList.add('active-layer');
  _refreshStreetlightHeat();
  showToast('💡 Streetlight density (PAPL survey)');
}

// ── DELHI PEDESTRIAN UNDERPASSES (PAPL survey, ~417 points) ──
function _refreshSubwayMarkers() {
  if (!subwayLayer || typeof DelhiInfraEngine === 'undefined') return;
  subwayLayer.clearLayers();
  const c = map.getCenter();
  DelhiInfraEngine.getNearestSubways(c.lat, c.lng, 40, 4.0).forEach(p => {
    const ico = L.divIcon({ className:'', iconSize:[null,null],
      html:`<div style="background:#7c3aed;border:2px solid white;border-radius:50%;width:22px;height:22px;display:flex;align-items:center;justify-content:center;font-size:11px;box-shadow:0 2px 6px rgba(0,0,0,.3);">🚧</div>` });
    const m = L.marker([p.lat, p.lng], { icon: ico }).addTo(subwayLayer);
    m.on('click', e => { e.originalEvent._markerHandled = true; });
    m.bindPopup(`<div style="min-width:220px;font-family:-apple-system,BlinkMacSystemFont,'DM Sans',sans-serif;">
      <div style="display:flex;align-items:center;gap:10px;padding-bottom:8px;border-bottom:2px solid #f1f5f9;margin-bottom:6px;">
        <div style="width:34px;height:34px;border-radius:50%;background:#7c3aed;display:flex;align-items:center;justify-content:center;flex-shrink:0;font-size:16px;">🚧</div>
        <div><div style="font-size:14px;font-weight:900;color:#0f172a;">Pedestrian Underpass</div>
        <div style="font-size:10px;color:#64748b;font-weight:600;">${p.count} detected · PAPL survey</div></div>
      </div>
      <div style="display:flex;gap:6px;">
        <button onclick="poiNavigateTo(${p.lat},${p.lng},'Pedestrian Underpass');map.closePopup();"
          style="flex:1;background:#7c3aed;color:white;border:none;border-radius:8px;padding:8px;font-size:11px;font-weight:800;cursor:pointer;font-family:inherit;">🧭 Go</button>
        <button onclick="poiSetFrom(${p.lat},${p.lng},'Pedestrian Underpass');map.closePopup();"
          style="flex:1;background:#f1f5f9;border:1px solid #e2e8f0;border-radius:8px;padding:8px;font-size:11px;font-weight:700;cursor:pointer;font-family:inherit;color:#475569;">📍 From</button>
      </div>
    </div>`, { maxWidth: 260 });
  });
}

function toggleDelhiSubways() {
  const btn = document.getElementById('btnDelhiSubways');
  if (subwayLayer) {
    map.removeLayer(subwayLayer);
    subwayLayer = null;
    if (btn) btn.classList.remove('active-layer');
    showToast('Underpasses hidden');
    return;
  }
  if (typeof DelhiInfraEngine === 'undefined' || !DelhiInfraEngine.delhiSubwaysReady()) {
    showToast('Underpass data still loading…');
    return;
  }
  subwayLayer = L.layerGroup().addTo(map);
  if (btn) btn.classList.add('active-layer');
  _refreshSubwayMarkers();
  showToast('🚧 Pedestrian underpasses (PAPL survey)');
}

// Offline search cache helper — returns normalised {name,sub,lat,lng,pid} array
function getCachedSearchResults(q) {
  try { return JSON.parse(localStorage.getItem('gw_search_cache_' + q.slice(0, 10))) || []; }
  catch { return []; }
}

// ── LIVE STEP CARD ──
function _updateLiveStepCard() {
  const step = _routeSteps[_liveStepIdx];
  if (!step) return;
  const dir  = step.maneuver.modifier ? step.maneuver.modifier.replace('-',' ') : '';
  const act  = step.maneuver.type==='turn' ? `Turn ${dir}` :
               _liveStepIdx===0            ? 'Start walking' : 'Continue';
  const road = step.name ? `onto ${step.name}` : 'forward';
  const dist = step.distance > 0 ? `${Math.round(step.distance)}m` : '';
  const nextStep = _routeSteps[_liveStepIdx + 1];
  const nextDesc = nextStep
    ? `Then: ${nextStep.maneuver.type==='turn' ? 'turn '+( nextStep.maneuver.modifier||'') : 'continue'}`
    : 'Arriving at destination';
  const dirEl  = document.getElementById('liveStepDir');
  const distEl = document.getElementById('liveStepDist');
  if (dirEl)  dirEl.textContent  = `${act} ${road}`.trim();
  if (distEl) distEl.textContent = dist ? `In ${dist} · ${nextDesc}` : nextDesc;
}

// ── SEARCH HISTORY ──
function _getDestHistory() {
  try { return JSON.parse(localStorage.getItem('gw_dest_history') || '[]'); } catch { return []; }
}
function _saveDestHistory(name, lat, lng) {
  let h = _getDestHistory().filter(x => x.name !== name);
  h.unshift({ name, lat, lng });
  localStorage.setItem('gw_dest_history', JSON.stringify(h.slice(0, 5)));
}
function showDestHistory() {
  const h = _getDestHistory();
  if (!h.length) return;
  const dd = document.getElementById('resultsDropdown');
  dd.innerHTML = `<div class="result-section">Recent</div>` +
    h.map(x => {
      const safe = x.name.replace(/'/g, "\\'");
      return `<div class="result-item" onclick="setDest(${x.lat},${x.lng},'${safe}')">
        <div><div class="result-name">🕐 ${x.name}</div></div>
      </div>`;
    }).join('');
  dd.classList.add('open');
}

// ── ROUTE COMPARE STRIP ──
function _updateCompareStrip(activeType) {
  const strip = document.getElementById('routeCompareStrip');
  if (!strip) return;
  // id = suffix for meta/score element IDs; label = display text in chip
  const modes = [
    { type:'walk',       icon:'🚶', label:'Walk',  id:'Walk' },
    { type:'safe',       icon:'🛡️', label:'Safe',  id:'Safe' },
    { type:'transit',    icon:'🚇', label:'Metro', id:'Metro' },
    { type:'bus',        icon:'🚌', label:'Bus',   id:'Bus' },
    { type:'multimodal', icon:'⚡', label:'Multi', id:'Multimodal' },
    { type:'auto',       icon:'🛺', label:'Auto',  id:'Auto' },
    { type:'cycle',      icon:'🚲', label:'Cycle', id:'Cycle' },
  ];
  const chips = modes.filter(m => {
    const el = document.getElementById('opt-' + (m.type==='transit'?'metro':m.type));
    return el && el.style.display !== 'none';
  }).map(m => {
    const metaEl  = document.getElementById('meta'  + m.id);
    const scoreEl = document.getElementById('score' + m.id);
    const time   = metaEl ? metaEl.textContent.split('·')[0].trim() : '—';
    const score  = scoreEl ? scoreEl.textContent : '—';
    const active = m.type === activeType ? ' active-chip' : '';
    return `<div class="compare-chip${active}" onclick="pickRoute('${m.type}')">
      <span class="chip-icon">${m.icon}</span>
      <span class="chip-time">${time}</span>
      <span class="chip-score">${score}</span>
    </div>`;
  });
  if (chips.length > 1) {
    strip.innerHTML = chips.join('');
    strip.style.display = 'flex';
  } else {
    strip.style.display = 'none';
  }
}

// switchTab helper for intel empty state CTA
function switchTab(tabId) {
  document.querySelectorAll('.bottom-nav .nav-item').forEach(n => n.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
  const nav = document.querySelector(`[data-target="${tabId}"]`);
  const tab = document.getElementById(tabId);
  if (nav) nav.classList.add('active');
  if (tab) { tab.classList.add('active'); setTimeout(() => map?.invalidateSize(), 100); }
}

// ── UTILS ──
function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent=msg; t.style.opacity='1';
  clearTimeout(t._t); t._t=setTimeout(()=>t.style.opacity='0', 3000);
}
function openModal(id)  { document.getElementById(id)?.classList.add('active'); }
function closeModal(id) { document.getElementById(id)?.classList.remove('active'); }

// Tap the dark backdrop (not the sheet itself) to close any modal
document.addEventListener('click', e => {
  if (!e.target.classList.contains('overlay')) return;
  e.target.classList.remove('active');
});
