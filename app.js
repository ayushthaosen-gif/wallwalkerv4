'use strict';

// ── API CONFIG ──
const API = window.location.hostname === 'localhost'
  ? 'http://localhost:3000'
  : '';  // Same origin on Render — empty string works

// ── CITY DETECTION — decides which transit data to load ──
const CITY_BBOXES = {
  delhi: [28.40, 76.84, 28.88, 77.35],
  dc:    [38.79, -77.12, 38.99, -76.91],
};
let detectedCity = null;
let wmataInjected = false;

function detectCityFromCoords(lat, lng) {
  for (const [city, [a, b, c, d]] of Object.entries(CITY_BBOXES)) {
    if (lat >= a && lat <= c && lng >= b && lng <= d) return city;
  }
  return 'unknown';
}

function applyCity(city, lat, lng) {
  if (detectedCity === city) return;
  detectedCity = city;
  localStorage.setItem('gw_city', city);
  window._searchCountry = city === 'delhi' ? 'in' : city === 'dc' ? 'us' : '';
  console.log(`✅ City detected: ${city}`);
  if (city === 'dc') {
    injectWmataScripts();
    // Fly to DC coords if map is still centred on Delhi default
    if (lat && map) {
      const c = map.getCenter();
      if (Math.abs(c.lat - 28.6139) < 0.5) map.flyTo([lat, lng], 14, { animate: true, duration: 1.5 });
    }
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
  applyCity(city, lat, lng);
  if (map) map.setView([lat, lng], 13);
  if (_adminSpoofOn) userLoc = L.latLng(lat, lng);
  showToast(`Admin: ${city === 'unknown' ? `${lat.toFixed(2)},${lng.toFixed(2)}` : city}`);
  _updateAdminStatus();
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

async function loadHazardsFromDB() {
  // Use GPS if available, IP-detected centre if not — always load something
  const loc = userLoc || (map ? map.getCenter() : null);
  const url  = loc
    ? `${API}/api/hazards?lat=${loc.lat}&lng=${loc.lng}&radius=20&limit=200`
    : `${API}/api/hazards?limit=200`;
  try {
    const res = await fetch(url);
    const hazards = await res.json();
    if (!Array.isArray(hazards)) return;
    hazardLayer.clearLayers();
    const list = document.getElementById('intelFeedList');
    if (list) list.innerHTML = '';
    hazards.forEach(h => {
      // Map marker
      const ico = L.divIcon({ className:'',
        html:`<div style="background:#dc2626;width:10px;height:10px;border-radius:50%;border:2px solid white;opacity:.7;"></div>`,
        iconSize:[10,10], iconAnchor:[5,5] });
      L.marker([h.lat,h.lng],{icon:ico}).addTo(hazardLayer)
       .bindPopup(`<b>${h.type}</b>${h.surface?'<br>Surface: '+h.surface:''}${h.canopy?'<br>Canopy: '+h.canopy:''}<br><small>${new Date(h.created_at).toLocaleDateString()}</small>`);
      // Intel feed card
      if (list) {
        const card = document.createElement('div');
        card.style.cssText = 'background:white;border-radius:12px;padding:12px;margin-bottom:8px;border:1px solid #e2e8f0;display:flex;align-items:center;gap:10px;cursor:pointer;';
        card.innerHTML = `<div style="font-size:22px;">${h.type.split(' ')[0]}</div>
          <div style="flex:1;">
            <div style="font-size:13px;font-weight:700;">${h.type}</div>
            <div style="font-size:11px;color:#94a3b8;">${h.surface||''} ${h.ai_label?'· '+h.ai_label:''}</div>
          </div>
          <div style="font-size:10px;color:#94a3b8;text-align:right;">${new Date(h.created_at).toLocaleDateString()}<br>${h.lat.toFixed(3)},${h.lng.toFixed(3)}</div>`;
        card.onclick = () => map.setView([h.lat, h.lng], 17);
        list.appendChild(card);
      }
    });
    if (list && !hazards.length) list.innerHTML = '<div class="empty-state"><div class="empty-icon">📋</div><div>No hazards reported yet</div></div>';
    localHazards = hazards;
  } catch(e) { console.warn('Hazard load failed:', e.message); }
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

// #3 — smart marker delta registry
const _visibleMarkers = new Map(); // stopId → L.Marker

// #6 — off-route detection
let currentRouteCoords = [];
let offRouteCount = 0;

// Hazard heatmap layer
let heatLayer = null;

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

// ── MAP ──
function initMap() {
  interactiveLayer = L.layerGroup();
  transitLayer     = L.layerGroup();
  stationLayer     = L.layerGroup();
  hazardLayer      = L.layerGroup();

  map = L.map('map', { zoomControl:false, attributionControl:false })
         .setView([28.6139, 77.2090], 13);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom:19 }).addTo(map);
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
    loadHazardsFromDB();

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
      m.bindPopup(`<div style="min-width:200px;"><b>🚏 ${s.name}</b>
        <div style="font-size:10px;color:#94a3b8;margin:2px 0 6px;">Stop ${s.id} · DTC/DIMTS</div>
        ${shimmerLoading}
        ${navBtns(s.lat,s.lng,s.name,'#d97706')}</div>`, {maxWidth:300});
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
      m.bindPopup(`<div style="min-width:200px;"><b>🚇 ${s.name}</b>
        <div style="font-size:10px;color:#94a3b8;margin:2px 0 6px;">Delhi Metro</div>
        ${shimmerLoading}
        ${navBtns(s.lat,s.lng,s.name,color)}</div>`, {maxWidth:300});
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
    const cc  = window._searchCountry ? `&countrycodes=${window._searchCountry}` : '';
    const r   = await fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(q)}&limit=6&addressdetails=1${ref}${cc}`);
    const data = await r.json();
    // Save to cache for offline fallback
    localStorage.setItem('gw_search_cache_'+q.slice(0,10), JSON.stringify(data.slice(0,3)));
    const dd  = document.getElementById('resultsDropdown');
    if (!data.length) { closeDropdown(); return; }
    let html = field==='from'
      ? `<div class="result-item" onclick="useMyLocation()"><div><div class="result-name">📍 My Current Location</div><div class="result-sub">Use live GPS</div></div><div class="result-gps">GPS</div></div>`
      : '';
    html += data.map(item => {
      const parts = item.display_name.split(',');
      const name  = parts[0].trim();
      const sub   = parts.slice(1,3).join(', ').trim();
      const dist  = userLoc ? (L.latLng(item.lat,item.lon).distanceTo(userLoc)/1000).toFixed(1)+' km' : '--';
      const fn    = field==='from'
        ? `setOrigin(${item.lat},${item.lon},'${name.replace(/'/g,"\\'")}')`
        : `setDest(${item.lat},${item.lon},'${name.replace(/'/g,"\\'")}')`;
      return `<div class="result-item" onclick="${fn}">
        <div><div class="result-name">${name}</div><div class="result-sub">${sub}</div></div>
        <div class="result-dist">${dist}</div></div>`;
    }).join('');
    dd.innerHTML=html; dd.classList.add('open');
  } catch {
    // Offline fallback — use cached results
    const cached = getCachedSearchResults(q);
    if (!cached.length) return;
    const dd = document.getElementById('resultsDropdown');
    let html = field==='from'
      ? `<div class="result-item" onclick="useMyLocation()"><div><div class="result-name">📍 My Current Location</div><div class="result-sub">Use live GPS</div></div><div class="result-gps">GPS</div></div>`
      : '';
    html += cached.map(item => {
      const parts = item.display_name.split(',');
      const name  = parts[0].trim();
      const sub   = parts.slice(1,3).join(', ').trim();
      const fn    = field==='from'
        ? `setOrigin(${item.lat},${item.lon},'${name.replace(/'/g,"\\'")}')`
        : `setDest(${item.lat},${item.lon},'${name.replace(/'/g,"\\'")}')`;
      return `<div class="result-item" onclick="${fn}">
        <div><div class="result-name">📴 ${name}</div><div class="result-sub">${sub} · Cached</div></div></div>`;
    }).join('');
    dd.innerHTML=html; dd.classList.add('open');
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
  const baseScore = Math.max(40, 100 - Math.round(baseDist * 6) - hazardPen);
  const isLong    = baseDist > 3; // long distance → show multimodal option

  simData = {
    walk:       { dist: baseDist,       score: baseScore,                  mode:'walk' },
    safe:       { dist: baseDist*1.15,  score: Math.min(98,baseScore+12), mode:'safe' },
    transit:    { dist: baseDist,       score: 80,                         mode:'transit' },
    multimodal: { dist: baseDist,       score: 90,                         mode:'multimodal' },
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

  // ── METRO ──
  let metroFound = false;
  if (isModeEnabled('metro') && typeof MetroEngine !== 'undefined' && typeof METRO_DATA !== 'undefined') {
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
  } else {
    document.getElementById('opt-metro').style.display = 'none';
  }

  // ── BUS ──
  let busFound = false;
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
  } else {
    document.getElementById('opt-bus').style.display = isModeEnabled('bus') ? 'flex' : 'none';
    if (isModeEnabled('bus')) {
      document.getElementById('metaBus').textContent  = `🚌 ${Math.ceil(simData.transit.dist*4)+8} min`;
      document.getElementById('scoreBus').textContent = simData.transit.score;
    }
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

  // ── AUTO-RICKSHAW estimate ──
  if (isModeEnabled('auto')) {
    // Show as info in nearest bus strip if no other transit
    const autoMin = Math.ceil(baseDist / 0.5); // ~30 km/h in city
    if (!metroFound && !busFound && busEl) {
      busEl.innerHTML = `🛺 Auto ~${autoMin} min · 🚶 Walk ~${Math.ceil(baseDist*12)} min`;
      busEl.style.display = 'block';
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
  // multimodal uses transit routing under the hood
  currentRouteMode = type === 'multimodal' ? 'transit' : type;
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
  const btnLbl  = document.getElementById('btnMiniToggle');
  const restore = document.getElementById('hudRestoreBtn');
  if (btnLbl)  btnLbl.textContent  = '▼ Min';
  if (restore) restore.classList.remove('visible');

  const rd     = simData[type] || simData[currentRouteMode] || simData.walk;
  const steps  = route.legs[0].steps;
  const coords = route.geometry.coordinates.map(c => [c[1], c[0]]);
  currentRouteCoords = coords; // #6 — store for off-route detection
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
    type==='safe'                            ? 'var(--safe)'    :
    (type==='transit'||type==='multimodal')  ? 'var(--transit)' : 'var(--primary)';

  const estSteps = Math.round((rd.dist*1000)/0.762);
  const estCals  = Math.round((rd.dist*1000)*0.05);

  const isTransitMode = type === 'transit' || type === 'multimodal';
  if (isTransitMode) {
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
  if (!isTransitMode) {
    stepsBox.innerHTML = itinHtml; stepsBox.style.display='block'; transitWrap.style.display='none';
  } else {
    stepsBox.style.display='none'; transitWrap.style.display='block';
    buildTransitView(coords, steps, rd);
  }

  if (!isTransitMode) {
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
  updateScoreBreakdown(); // #22
  updateHudModeSwitcher(type); // #7
  // #21 — show share button
  const bShare = document.getElementById('btnShare');
  if (bShare) bShare.style.display = 'block';
  if (document.getElementById('voiceToggle')?.checked && 'speechSynthesis' in window) {
    const label = isTransitMode ? 'metro route' : type==='safe' ? 'safest walk' : 'shortest walk';
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
        st.textContent = '⚠ AI offline — saved as Photo Hazard';
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
    window._cachedWmataPlan=null; window._cachedWmataBus=null;
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

function toggleMini() {
  isMinimized = !isMinimized;
  const hud     = document.getElementById('hud');
  const btnLbl  = document.getElementById('btnMiniToggle');
  const restore = document.getElementById('hudRestoreBtn');

  hud.classList.toggle('mini', isMinimized);

  if (isMinimized) {
    // Update button label
    if (btnLbl) { btnLbl.textContent = '▲ Max'; }
    // Show floating restore bubble with current time/dist
    if (restore) {
      const time = document.getElementById('hudTime')?.textContent || '';
      const dist = document.getElementById('hudDist')?.textContent || '';
      const label = document.getElementById('hudRestoreLabel');
      if (label) label.textContent = `🚶 ${time} · ${dist} · tap to expand`;
      restore.classList.add('visible');
    }
  } else {
    // Maximised
    if (btnLbl) { btnLbl.textContent = '▼ Min'; }
    if (restore) restore.classList.remove('visible');
  }
}

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
      <button onclick="pickRoute('${m.type}')"
        style="padding:6px 14px;border-radius:20px;border:2px solid ${m.color};
               background:${m.type===activeType?m.color:'white'};
               color:${m.type===activeType?'white':m.color};
               font-size:12px;font-weight:800;cursor:pointer;font-family:inherit;transition:all .2s;">
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

// Offline search cache helper
function getCachedSearchResults(q) {
  try { return JSON.parse(localStorage.getItem('gw_search_cache_'+q.slice(0,10))) || []; } catch { return []; }
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
