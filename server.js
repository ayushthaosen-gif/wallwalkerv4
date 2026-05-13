/**
 * GAITWAY BACKEND v2 — server.js
 * - Passwordless email OTP auth (email hashed with SHA-256, never stored raw)
 * - Google Gemini 2.5 Flash vision proxy
 * - Google Maps / Places proxy (add GOOGLE_MAPS_KEY env var)
 * - Hazards, Routes, Users, Leaderboard
 */

const express  = require('express');
const { Pool } = require('pg');
const cors     = require('cors');
const path     = require('path');
const crypto   = require('crypto');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, '.')));

// ── DATABASE ──
const pool = new Pool({
  host:     process.env.DB_HOST     || 'aws-0-ap-southeast-1.pooler.supabase.com',
  port:     parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME     || 'postgres',
  user:     process.env.DB_USER     || 'postgres',
  password: process.env.DB_PASSWORD,
  ssl:      { rejectUnauthorized: false },
  max: 5, idleTimeoutMillis: 30000, connectionTimeoutMillis: 15000,
});
pool.query('SELECT NOW()')
  .then(r => console.log('✅ DB connected:', r.rows[0].now))
  .catch(e => console.error('❌ DB error:', e.message));

// ── OTP STORE (in-memory, 10 min TTL) ──
const otpStore = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of otpStore) if (now > v.expires) otpStore.delete(k);
}, 60000);

// ── HELPERS ──
const SALT   = process.env.EMAIL_SALT   || 'gaitway_salt_v1';
const SECRET = process.env.TOKEN_SECRET || 'gaitway_token_secret_v1';

function hashEmail(email) {
  return crypto.createHash('sha256')
    .update(email.trim().toLowerCase() + SALT)
    .digest('hex').slice(0, 32);
}

function makeToken(userId) {
  const day = Math.floor(Date.now() / 86400000);
  return crypto.createHmac('sha256', SECRET)
    .update(userId + ':' + day).digest('hex');
}

function generateOTP() {
  return crypto.randomInt(100000, 999999).toString();
}

async function sendOTP(email, otp) {
  console.log(`\n📧 OTP for ${email}: ${otp}\n`);

  if (process.env.SENDGRID_API_KEY) {
    await fetch('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: {
        Authorization:  `Bearer ${process.env.SENDGRID_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        personalizations: [{ to: [{ email }] }],
        from: { email: process.env.FROM_EMAIL || 'noreply@gaitway.app', name: 'GaitWay' },
        subject: `GaitWay login code: ${otp}`,
        content: [{
          type: 'text/html',
          value: `<div style="font-family:-apple-system,sans-serif;max-width:420px;margin:0 auto;padding:32px;">
            <h2 style="color:#2563eb;margin:0 0 8px">🚶 GaitWay</h2>
            <p style="color:#64748b;margin:0 0 24px">Your one-time login code:</p>
            <div style="font-size:48px;font-weight:900;letter-spacing:10px;color:#0f172a;margin:0 0 24px">${otp}</div>
            <p style="color:#94a3b8;font-size:13px;margin:0">Expires in 10 minutes. Never share this code.</p>
          </div>`,
        }],
      }),
    }).catch(e => console.error('SendGrid error:', e.message));
  }
}

// ════════════════════════════════════════════
// AUTH — Passwordless OTP
// ════════════════════════════════════════════

// Step 1: Request OTP
app.post('/api/auth/request-otp', async (req, res) => {
  const { email } = req.body;
  if (!email || !email.includes('@'))
    return res.status(400).json({ error: 'Valid email required' });

  const otp       = generateOTP();
  const emailHash = hashEmail(email);
  otpStore.set(emailHash, { otp, expires: Date.now() + 600000 });
  await sendOTP(email.trim().toLowerCase(), otp);

  res.json({
    ok: true,
    message: 'Check your email for a 6-digit code.',
    // Return OTP in non-production so you can test without SendGrid
    ...(process.env.NODE_ENV !== 'production' && { dev_otp: otp }),
  });
});

// Step 2: Verify OTP → issue token
app.post('/api/auth/verify-otp', async (req, res) => {
  const { email, otp, name } = req.body;
  if (!email || !otp)
    return res.status(400).json({ error: 'email and otp required' });

  const emailHash = hashEmail(email);
  const record    = otpStore.get(emailHash);

  if (!record)
    return res.status(400).json({ error: 'No OTP requested for this email' });
  if (Date.now() > record.expires) {
    otpStore.delete(emailHash);
    return res.status(400).json({ error: 'OTP expired — request a new one' });
  }
  if (record.otp !== otp.trim())
    return res.status(400).json({ error: 'Incorrect code' });

  otpStore.delete(emailHash); // single use

  const userId = 'u_' + emailHash;
  try {
    await pool.query(
      `INSERT INTO users (id, name) VALUES ($1, $2)
       ON CONFLICT (id) DO UPDATE SET
         name = CASE WHEN $2 IS NOT NULL AND $2 != '' THEN $2 ELSE users.name END,
         updated_at = NOW()`,
      [userId, name?.trim() || 'Walker']
    );
    const { rows } = await pool.query(
      `SELECT id,name,xp,route_count,hazard_count,created_at FROM users WHERE id=$1`,
      [userId]
    );
    res.json({ ok: true, user: rows[0], token: makeToken(userId), userId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════
// USERS
// ════════════════════════════════════════════
app.post('/api/users/upsert', async (req, res) => {
  const { id, name } = req.body;
  if (!id) return res.status(400).json({ error: 'id required' });
  try {
    await pool.query(
      `INSERT INTO users (id,name) VALUES ($1,$2)
       ON CONFLICT (id) DO UPDATE SET
         name=COALESCE(NULLIF($2,'Walker'),users.name),updated_at=NOW()`,
      [id, name || 'Walker']
    );
    const { rows } = await pool.query(
      `SELECT id,name,xp,route_count,hazard_count FROM users WHERE id=$1`, [id]
    );
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/users/:id', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id,name,xp,route_count,hazard_count,created_at FROM users WHERE id=$1`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/users/:id', async (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  try {
    await pool.query(
      `UPDATE users SET name=$1,updated_at=NOW() WHERE id=$2`, [name, req.params.id]
    );
    const { rows } = await pool.query(
      `SELECT id,name,xp,route_count,hazard_count FROM users WHERE id=$1`, [req.params.id]
    );
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/leaderboard', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id,name,xp,route_count,hazard_count FROM users ORDER BY xp DESC LIMIT 20`
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════
// HAZARDS
// ════════════════════════════════════════════
function hav(la1,lo1,la2,lo2){
  const R=6371,r=Math.PI/180,dL=(la2-la1)*r,dO=(lo2-lo1)*r;
  const a=Math.sin(dL/2)**2+Math.cos(la1*r)*Math.cos(la2*r)*Math.sin(dO/2)**2;
  return R*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a));
}

app.post('/api/hazards', async (req, res) => {
  const { type,lat,lng,user_id,photo_b64,ai_label,
          surface,canopy,lighting,footpath_type,footpath_width } = req.body;
  if (!type||lat==null||lng==null)
    return res.status(400).json({ error: 'type, lat, lng required' });
  try {
    const r = await pool.query(
      `INSERT INTO hazards
         (type,lat,lng,user_id,photo_b64,ai_label,surface,canopy,lighting,footpath_type,footpath_width)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
      [type,lat,lng,user_id||null,photo_b64||null,ai_label||null,
       surface||null,canopy||null,lighting||null,footpath_type||null,footpath_width||null]
    );
    if (user_id) await pool.query(
      `INSERT INTO users (id,xp,hazard_count) VALUES ($1,50,1)
       ON CONFLICT (id) DO UPDATE SET xp=users.xp+50,hazard_count=users.hazard_count+1,updated_at=NOW()`,
      [user_id]
    );
    res.json({ id: r.rows[0].id, ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/hazards', async (req, res) => {
  const { lat,lng,radius=5,limit=200 } = req.query;
  try {
    const { rows } = await pool.query(
      `SELECT id,type,lat,lng,user_id,ai_label,surface,canopy,lighting,
              footpath_type,footpath_width,created_at
       FROM hazards ORDER BY created_at DESC LIMIT 1000`
    );
    let out = rows;
    if (lat&&lng) out=rows.filter(h=>hav(+lat,+lng,h.lat,h.lng)<=+radius).slice(0,+limit);
    res.json(out);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════
// ROUTES
// ════════════════════════════════════════════
app.post('/api/routes', async (req, res) => {
  const { user_id,from_name,to_name,from_lat,from_lng,to_lat,to_lng,
          mode,dist_km,duration_min,steps,calories,walk_score,surface_log } = req.body;
  if (!user_id) return res.status(400).json({ error: 'user_id required' });
  try {
    const r = await pool.query(
      `INSERT INTO routes
         (user_id,from_name,to_name,from_lat,from_lng,to_lat,to_lng,
          mode,dist_km,duration_min,steps,calories,walk_score,surface_log)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
      [user_id,from_name,to_name,from_lat,from_lng,to_lat,to_lng,
       mode,dist_km,duration_min,steps,calories,walk_score,JSON.stringify(surface_log||{})]
    );
    await pool.query(
      `INSERT INTO users (id,xp,route_count) VALUES ($1,250,1)
       ON CONFLICT (id) DO UPDATE SET xp=users.xp+250,route_count=users.route_count+1,updated_at=NOW()`,
      [user_id]
    );
    res.json({ id: r.rows[0].id, ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/routes/:userId', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id,from_name,to_name,mode,dist_km,duration_min,steps,calories,walk_score,created_at
       FROM routes WHERE user_id=$1 ORDER BY created_at DESC LIMIT 50`,
      [req.params.userId]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════
// AI VISION (Anthropic)
// ════════════════════════════════════════════
app.post('/api/vision', async (req, res) => {
  const { image_b64 } = req.body;
  if (!image_b64) return res.status(400).json({ error: 'image_b64 required' });
  const key = process.env.GEMINI_API_KEY;
  if (!key) return res.status(500).json({ error: 'GEMINI_API_KEY not set' });
  try {
    const { GoogleGenAI } = require('@google/genai');
    const ai     = new GoogleGenAI({ apiKey: key });
    const model  = ai.getGenerativeModel({ model: 'gemini-2.5-flash' });
    const result = await model.generateContent({
      contents: [{
        parts: [
          { inlineData: { data: image_b64, mimeType: 'image/jpeg' } },
          { text: 'Walkability analyst: What hazard, surface type, or footpath condition is in this image? ONE label max 6 words. Examples: "Broken pavement", "No footpath dirt road", "Good wide footpath", "Waterlogging on road". No explanation.' },
        ],
      }],
    });
    const label = result.response.text()?.trim() || 'Unknown hazard';
    res.json({ label });
  } catch (e) {
    console.error('Gemini vision error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ════════════════════════════════════════════
// GOOGLE MAPS PROXY (keeps key server-side)
// ════════════════════════════════════════════
app.get('/api/places/search', async (req, res) => {
  const { q, lat, lng } = req.query;
  const key = process.env.GOOGLE_MAPS_KEY;
  if (!key) return res.status(500).json({ error: 'GOOGLE_MAPS_KEY not set' });
  try {
    const loc  = lat && lng ? `&location=${lat},${lng}&radius=20000` : '';
    const url  = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodeURIComponent(q)}&key=${key}${loc}`;
    const r    = await fetch(url);
    const d    = await r.json();
    // Return only what the frontend needs — never expose the key
    const results = (d.results || []).slice(0, 5).map(p => ({
      name:     p.name,
      address:  p.formatted_address,
      lat:      p.geometry.location.lat,
      lng:      p.geometry.location.lng,
      place_id: p.place_id,
    }));
    res.json(results);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════
// STATS
// ════════════════════════════════════════════
app.get('/api/stats', async (req, res) => {
  try {
    const [h,r,u,t] = await Promise.all([
      pool.query('SELECT COUNT(*) FROM hazards'),
      pool.query('SELECT COUNT(*) FROM routes'),
      pool.query('SELECT COUNT(*) FROM users'),
      pool.query('SELECT type,COUNT(*) as count FROM hazards GROUP BY type ORDER BY count DESC LIMIT 5'),
    ]);
    res.json({ hazards:+h.rows[0].count, routes:+r.rows[0].count, users:+u.rows[0].count, top_types:t.rows, db:'connected' });
  } catch (e) { res.status(500).json({ error:e.message, db:'error' }); }
});

// ── CATCH-ALL ──
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.listen(PORT, () => {
  console.log(`✅ GaitWay v2 on port ${PORT}`);
  console.log(`   DB:       ${process.env.DB_PASSWORD   ? '✓' : '⚠ DB_PASSWORD not set'}`);
  console.log(`   AI:       ${process.env.GEMINI_API_KEY      ? '✓ Gemini' : '⚠ GEMINI_API_KEY not set'}`);
  console.log(`   Maps:     ${process.env.GOOGLE_MAPS_KEY   ? '✓' : '— GOOGLE_MAPS_KEY not set (optional)'}`);
  console.log(`   Email:    ${process.env.SENDGRID_API_KEY  ? '✓ SendGrid' : '— dev mode (OTP in logs)'}`);
});

// ════════════════════════════════════════════
// TRANSIT — Stop info, timings, next buses
// Data served as static JS files (stop_timings_p1-4.js etc.)
// Transit timing lookups happen client-side via window.BUS_STOP_TIMES
// Server just provides the /api/transit/stop/:id endpoint as a pass-through
// ════════════════════════════════════════════
const fs = require('fs');

// Load transit data from static JS files at startup for server-side use
let BUS_STOP_TIMES   = {};
let BUS_ROUTE_SCHED  = {};
let METRO_STOP_TIMES = {};
let METRO_SCHED      = {};

function loadTransitData() {
  try {
    // Load JSON versions if they exist (optional — static JS files are the primary delivery)
    const tryLoad = (file) => {
      const p = path.join(__dirname, file);
      if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
      return null;
    };
    BUS_STOP_TIMES   = tryLoad('stop_timings.json')    || {};
    BUS_ROUTE_SCHED  = tryLoad('route_schedules.json') || {};
    METRO_STOP_TIMES = tryLoad('metro_stop_times.json')|| {};
    METRO_SCHED      = tryLoad('metro_schedules.json') || {};
    const bCount = Object.keys(BUS_STOP_TIMES).length;
    const mCount = Object.keys(METRO_STOP_TIMES).length;
    if (bCount) console.log(`✅ Transit data loaded server-side: ${bCount} bus stops, ${mCount} metro stops`);
    else        console.log('ℹ Transit data served client-side via static JS chunks');
  } catch(e) {
    console.warn('Transit data load error:', e.message);
  }
}
loadTransitData();

// Helper: get next N departures from now
function nextDepartures(times, n=5) {
  const now = new Date();
  const cur = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
  const upcoming = times.filter(t => t >= cur);
  const result   = upcoming.slice(0, n);
  // If fewer than n, wrap around to early morning
  if (result.length < n) result.push(...times.slice(0, n - result.length));
  return result;
}

// GET /api/transit/stop/:stopId — all buses/metro at a stop with next timings
app.get('/api/transit/stop/:stopId', (req, res) => {
  const sid  = req.params.stopId;
  const type = req.query.type || 'bus'; // bus | metro

  const data   = type === 'metro' ? METRO_STOP_TIMES : BUS_STOP_TIMES;
  const sched  = type === 'metro' ? METRO_SCHED      : BUS_ROUTE_SCHED;
  const routes = data[sid];

  if (!routes) return res.json({ stopId: sid, services: [] });

  const services = Object.entries(routes).map(([rid, times]) => {
    const info = sched[rid] || {};
    return {
      routeId:   rid,
      routeName: info.n || rid,
      agency:    info.a || (type === 'metro' ? 'DMRC' : 'DTC'),
      color:     info.color || (type === 'metro' ? '#1565c0' : '#d97706'),
      nextTimes: nextDepartures(times, 5),
      allTimes:  times,
      frequency: times.length > 1
        ? Math.round((parseInt(times[times.length-1])-parseInt(times[0])) / (times.length-1)) + ' min avg'
        : 'Limited service',
    };
  }).sort((a,b) => {
    // Sort by next departure
    return (a.nextTimes[0]||'99:99').localeCompare(b.nextTimes[0]||'99:99');
  });

  res.json({ stopId: sid, type, serviceCount: services.length, services });
});

// GET /api/transit/route/:routeId — full schedule for a route
app.get('/api/transit/route/:routeId', (req, res) => {
  const rid  = req.params.routeId;
  const type = req.query.type || 'bus';
  const sched = type === 'metro' ? METRO_SCHED : BUS_ROUTE_SCHED;
  const info  = sched[rid];
  if (!info) return res.status(404).json({ error: 'Route not found' });
  res.json({
    routeId:      rid,
    routeName:    info.n,
    agency:       info.a || (type === 'metro' ? 'DMRC' : 'DTC'),
    color:        info.color || '#d97706',
    departures:   info.t,
    nextDepartures: nextDepartures(info.t, 8),
    totalTrips:   info.t.length,
    firstBus:     info.t[0]   || '--',
    lastBus:      info.t[info.t.length-1] || '--',
  });
});

// GET /api/transit/nearby?lat=&lng=&radius=0.5 — all stops near a location
app.get('/api/transit/nearby', (req, res) => {
  const { lat, lng, radius=0.5, type='bus' } = req.query;
  if (!lat||!lng) return res.status(400).json({ error: 'lat,lng required' });
  // This uses the existing BUS_STOPS_V2 / METRO_DATA from static files
  // Frontend handles nearest stop lookup — this just returns stop timing on demand
  res.json({ message: 'Use /api/transit/stop/:id for timing data' });
});
