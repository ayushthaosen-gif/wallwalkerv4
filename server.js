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

// Infrastructure: Rate limiting on /api/auth routes
let rateLimit;
try { rateLimit = require('express-rate-limit'); } catch(e) { rateLimit = null; }
if (rateLimit) {
  app.use('/api/auth', rateLimit({ windowMs: 15*60*1000, max: 10, message: { error: 'Too many requests — try again later' } }));
}

// ── DATABASE ──
// Accepts either DATABASE_URL (full connection string from Supabase dashboard)
// or individual DB_HOST / DB_USER / DB_PASSWORD / DB_NAME / DB_PORT vars.
let pool;
try {
  const _dbUrl = process.env.DATABASE_URL;
  const _useUrl = _dbUrl && (_dbUrl.startsWith('postgresql://') || _dbUrl.startsWith('postgres://'));
  pool = new Pool(
    _useUrl
      ? { connectionString: _dbUrl, ssl: { rejectUnauthorized: false }, max: 5, idleTimeoutMillis: 30000, connectionTimeoutMillis: 15000 }
      : {
          host:     process.env.DB_HOST     || 'aws-0-ap-southeast-1.pooler.supabase.com',
          port:     parseInt(process.env.DB_PORT || '5432'),
          database: process.env.DB_NAME     || 'postgres',
          user:     process.env.DB_USER     || 'postgres',
          password: process.env.DB_PASSWORD,
          ssl:      { rejectUnauthorized: false },
          max: 5, idleTimeoutMillis: 30000, connectionTimeoutMillis: 15000,
        }
  );
  pool.query('SELECT NOW()')
    .then(r => console.log('✅ DB connected:', r.rows[0].now))
    .catch(e => console.error('❌ DB error:', e.message));
} catch(e) {
  console.error('❌ DB init error:', e.message);
  // Create a dummy pool so the server still starts — DB endpoints will return 503
  pool = { query: () => Promise.reject(new Error('DB not configured')) };
}

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

// Step 1: Request OTP — does NOT need DB, just in-memory store
app.post('/api/auth/request-otp', async (req, res) => {
  const { email } = req.body;
  if (!email || !email.includes('@'))
    return res.status(400).json({ error: 'Valid email required' });

  const otp       = generateOTP();
  const emailHash = hashEmail(email);
  otpStore.set(emailHash, { otp, expires: Date.now() + 600000 });

  try {
    await sendOTP(email.trim().toLowerCase(), otp);
  } catch(e) {
    console.error('Email send error:', e.message);
    // Still return ok — OTP is stored, user can check logs in dev mode
  }

  res.json({
    ok: true,
    message: 'Check your email for a 6-digit code.',
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
    // Check if user existed BEFORE upsert (determines isNewUser)
    const existing = await pool.query(`SELECT id FROM users WHERE id=$1`, [userId]);
    const isNewUser = existing.rows.length === 0;

    // Single upsert — no duplicate
    await pool.query(
      `INSERT INTO users (id, name) VALUES ($1, $2)
       ON CONFLICT (id) DO UPDATE SET
         name = CASE WHEN $2 IS NOT NULL AND $2 != '' AND $2 != 'Walker'
                     THEN $2 ELSE users.name END,
         updated_at = NOW()`,
      [userId, name?.trim() || 'Walker']
    );

    const { rows } = await pool.query(
      `SELECT id,name,xp,route_count,hazard_count,created_at FROM users WHERE id=$1`,
      [userId]
    );
    const parts     = email.split('@');
    const emailHint = parts[0].slice(0,2) + '***@' + parts[1];
    res.json({ ok: true, user: { ...rows[0], email_hint: emailHint }, token: makeToken(userId), userId, isNewUser });
  } catch (e) {
    console.error('verify-otp DB error:', e.message);
    res.status(500).json({ error: 'Database error — please try again' });
  }
});

// ════════════════════════════════════════════
// USERS
// ════════════════════════════════════════════
app.post('/api/users/upsert', async (req, res) => {
  const { id, name } = req.body;
  if (!id) return res.status(400).json({ error: 'id required' });
  try {
    const { walk_purpose, walk_priority, area } = req.body;
    await pool.query(
      `INSERT INTO users (id,name,walk_purpose,walk_priority,area) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (id) DO UPDATE SET
         name=COALESCE(NULLIF($2,'Walker'),users.name),
         walk_purpose=COALESCE($3,users.walk_purpose),
         walk_priority=COALESCE($4,users.walk_priority),
         area=COALESCE($5,users.area),
         updated_at=NOW()`,
      [id, name||'Walker', walk_purpose||null, walk_priority||null, area||null]
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
  const { lat, lng, radius, limit = 500 } = req.query;
  try {
    const { rows } = await pool.query(
      `SELECT id,type,lat,lng,user_id,ai_label,surface,canopy,lighting,
              footpath_type,footpath_width,created_at
       FROM hazards ORDER BY created_at DESC LIMIT 1000`
    );
    // Only apply radius filter if explicitly requested with lat+lng+radius
    let out = rows;
    if (lat && lng && radius) {
      out = rows.filter(h => hav(+lat, +lng, h.lat, h.lng) <= +radius).slice(0, +limit);
    } else {
      out = rows.slice(0, +limit);
    }
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
// ════════════════════════════════════════════
// HEALTH — DB connectivity + table check
// ════════════════════════════════════════════
app.get('/api/health', async (req, res) => {
  const result = { ok: false, db: 'unknown', tables: {}, env: {} };

  // Check env vars (values hidden, just presence)
  result.env = {
    DATABASE_URL: !!process.env.DATABASE_URL,
    DB_PASSWORD:  !!process.env.DB_PASSWORD,
    GEMINI_API_KEY:  !!process.env.GEMINI_API_KEY,
    MTA_API_KEY:     !!process.env.MTA_API_KEY,
    WMATA_API_KEY:   !!process.env.WMATA_API_KEY,
    DELHI_OTD_KEY:   !!process.env.DELHI_OTD_KEY,
    GOOGLE_MAPS_KEY: !!process.env.GOOGLE_MAPS_KEY,
  };

  try {
    await pool.query('SELECT 1');
    result.db = 'connected';

    // Check each critical table exists and has rows
    const tables = ['users', 'hazards', 'routes'];
    for (const t of tables) {
      try {
        const r = await pool.query(`SELECT COUNT(*) FROM ${t}`);
        result.tables[t] = +r.rows[0].count;
      } catch(e) {
        result.tables[t] = `missing: ${e.message}`;
      }
    }
    result.ok = true;
  } catch(e) {
    result.db = `error: ${e.message}`;
  }

  res.json(result);
});

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

// ══════════════════════════════════════════════
// ADMIN — Key-based login for debug/location override
// Set ADMIN_KEY env var to enable. Never stored in DB.
// ══════════════════════════════════════════════
const ADMIN_KEY = process.env.ADMIN_KEY || null;

app.post('/api/admin/login', (req, res) => {
  if (!ADMIN_KEY) return res.status(503).json({ error: 'Admin not configured — set ADMIN_KEY env var' });
  const { key } = req.body;
  if (!key || key !== ADMIN_KEY) return res.status(401).json({ error: 'Invalid admin key' });
  const day   = Math.floor(Date.now() / 86400000);
  const token = crypto.createHmac('sha256', SECRET).update('admin:' + day).digest('hex');
  res.json({ ok: true, token });
});

app.post('/api/admin/verify', (req, res) => {
  if (!ADMIN_KEY) return res.status(503).json({ ok: false });
  const { token } = req.body;
  const day   = Math.floor(Date.now() / 86400000);
  const valid = crypto.createHmac('sha256', SECRET).update('admin:' + day).digest('hex');
  res.json({ ok: token === valid });
});

// ════════════════════════════════════════════
// NYC MTA LIVE ARRIVALS — GTFS-RT (no npm needed)
// Register free at developer.mta.info → set MTA_API_KEY env var
// ════════════════════════════════════════════

// ── Minimal protobuf decoder ──
function _pv(buf, pos) {           // read unsigned varint
  let n = 0, s = 0, b;
  do { b = buf[pos++]; n += (b & 0x7F) * Math.pow(2, s); s += 7; } while (b & 0x80);
  return { n, pos };
}
function _pskip(buf, pos, wire) {  // skip unknown field
  if (wire === 0) { while (buf[pos++] & 0x80); return pos; }
  if (wire === 1) return pos + 8;
  if (wire === 2) { const {n, pos:p} = _pv(buf, pos); return p + n; }
  if (wire === 5) return pos + 4;
  return pos + 1;
}
function _pmsg(buf, s, e, cb) {    // iterate all fields of a protobuf message slice
  let pos = s;
  while (pos < e && pos < buf.length) {
    const {n: tag, pos: p} = _pv(buf, pos); pos = p;
    const field = tag >> 3, wire = tag & 7;
    if (wire === 2) {
      const {n: len, pos: q} = _pv(buf, pos);
      cb(field, 'B', buf.slice(q, q + len));
      pos = q + len;
    } else if (wire === 0) {
      const {n: val, pos: q} = _pv(buf, pos);
      cb(field, 'V', val);
      pos = q;
    } else if (wire === 5) {      // 32-bit — float or fixed32
      cb(field, 'F', buf.readFloatLE(pos));
      pos += 4;
    } else if (wire === 1) {      // 64-bit — skip
      pos += 8;
    } else {
      pos = _pskip(buf, pos, wire);
    }
  }
}

// ── Decode GTFS-RT FeedMessage — one pass returns arrivals + vehicles ──
function _parseTripDescriptor(buf) {
  let routeId = '', tripId = '', directionId = -1;
  _pmsg(buf, 0, buf.length, (f, t, v) => {
    if (f === 1 && t === 'B') tripId    = v.toString('utf8');  // trip_id
    if (f === 5 && t === 'B') routeId   = v.toString('utf8');  // route_id
    if (f === 6 && t === 'V') directionId = v;                 // direction_id
  });
  return { routeId, tripId, directionId };
}

function decodeGtfsRtFeed(buf) {
  // Returns { arrivals: [{routeId,stopId,arrTime}], vehicles: [{routeId,lat,lng,bearing,stopId,status,directionId,timestamp}] }
  const arrivals = [], vehicles = [];

  _pmsg(buf, 0, buf.length, (f1, t1, v1) => {
    if (f1 !== 2 || t1 !== 'B') return;   // FeedMessage.entity = field 2

    _pmsg(v1, 0, v1.length, (f2, t2, v2) => {

      // ── TripUpdate (field 3) ──
      if (f2 === 3 && t2 === 'B') {
        let routeId = '';
        _pmsg(v2, 0, v2.length, (f3, t3, v3) => {
          if (f3 === 1 && t3 === 'B') {
            routeId = _parseTripDescriptor(v3).routeId;
          } else if (f3 === 2 && t3 === 'B') {   // stop_time_update
            let stopId = '', arrTime = 0;
            _pmsg(v3, 0, v3.length, (f4, t4, v4) => {
              if (f4 === 4 && t4 === 'B') stopId = v4.toString('utf8');
              if ((f4 === 2 || f4 === 3) && t4 === 'B' && !arrTime) {  // arrival or departure
                _pmsg(v4, 0, v4.length, (f5, t5, v5) => {
                  if (f5 === 2 && t5 === 'V') arrTime = v5;            // time
                });
              }
            });
            if (stopId && arrTime > 0) arrivals.push({ routeId, stopId, arrTime });
          }
        });
      }

      // ── VehiclePosition (field 4) ──
      else if (f2 === 4 && t2 === 'B') {
        let routeId = '', directionId = -1;
        let lat = 0, lng = 0, bearing = 0;
        let stopId = '', status = 2, timestamp = 0;

        _pmsg(v2, 0, v2.length, (f3, t3, v3) => {
          if (f3 === 1 && t3 === 'B') {            // trip descriptor
            const td = _parseTripDescriptor(v3);
            routeId = td.routeId; directionId = td.directionId;
          } else if (f3 === 2 && t3 === 'B') {    // position
            _pmsg(v3, 0, v3.length, (f4, t4, v4) => {
              if (f4 === 1 && t4 === 'F') lat     = v4;  // latitude
              if (f4 === 2 && t4 === 'F') lng     = v4;  // longitude
              if (f4 === 3 && t4 === 'F') bearing = v4;  // bearing
            });
          } else if (f3 === 4 && t3 === 'V') { status    = v3; }  // current_status
          else if (f3 === 5 && t3 === 'V') { timestamp = v3; }    // timestamp
          else if (f3 === 7 && t3 === 'B') { stopId    = v3.toString('utf8'); } // stop_id
        });

        if (routeId && lat !== 0 && lng !== 0) {
          vehicles.push({ routeId, lat, lng, bearing, stopId, status, directionId, timestamp });
        }
      }
    });
  });

  return { arrivals, vehicles };
}

// ── Decode subway alerts feed ──
const ALERT_EFFECT = ['NO_SERVICE','REDUCED_SERVICE','SIGNIFICANT_DELAYS','DETOUR',
  'ADDITIONAL_SERVICE','MODIFIED_SERVICE','OTHER_EFFECT','UNKNOWN_EFFECT',
  'STOP_MOVED','NO_EFFECT','ACCESSIBILITY_ISSUE'];

function decodeAlerts(buf) {
  const out = [];
  _pmsg(buf, 0, buf.length, (f1, t1, v1) => {
    if (f1 !== 2 || t1 !== 'B') return;

    _pmsg(v1, 0, v1.length, (f2, t2, v2) => {
      if (f2 !== 5 || t2 !== 'B') return;   // FeedEntity.alert = field 5

      const routeIds = [], stopIds = [];
      let header = '', description = '', effect = 9;  // default NO_EFFECT

      _pmsg(v2, 0, v2.length, (f3, t3, v3) => {
        if (f3 === 5 && t3 === 'B') {         // informed_entity (EntitySelector)
          _pmsg(v3, 0, v3.length, (f4, t4, v4) => {
            if (f4 === 5 && t4 === 'B') routeIds.push(v4.toString('utf8'));  // route_id
            if (f4 === 4 && t4 === 'B') stopIds.push(v4.toString('utf8'));   // stop_id
          });
        } else if ((f3 === 10 || f3 === 11) && t3 === 'B') { // header_text / description_text
          let txt = '';
          _pmsg(v3, 0, v3.length, (f4, t4, v4) => {
            if (f4 === 1 && t4 === 'B' && !txt) {  // first Translation
              _pmsg(v4, 0, v4.length, (f5, t5, v5) => {
                if (f5 === 1 && t5 === 'B') txt = v5.toString('utf8');  // text
              });
            }
          });
          if (f3 === 10) header      = txt;
          else           description = txt;
        } else if (f3 === 7 && t3 === 'V') {
          effect = v3;   // Effect enum
        }
      });

      if (routeIds.length || header) {
        out.push({
          routeIds: [...new Set(routeIds)],
          stopIds:  [...new Set(stopIds)],
          header,
          description,
          effect,
          effectLabel: ALERT_EFFECT[effect] || 'UNKNOWN',
        });
      }
    });
  });
  return out;
}

// Keep backward-compat alias used by existing endpoints
function decodeGtfsRt(buf) { return decodeGtfsRtFeed(buf).arrivals; }

// Which GTFS-RT feed carries each line
const LINE_FEED = {
  '1':'nyct%2Fgtfs','2':'nyct%2Fgtfs','3':'nyct%2Fgtfs',
  '4':'nyct%2Fgtfs','5':'nyct%2Fgtfs','6':'nyct%2Fgtfs','6X':'nyct%2Fgtfs',
  '7':'nyct%2Fgtfs','7X':'nyct%2Fgtfs','GS':'nyct%2Fgtfs','FS':'nyct%2Fgtfs','H':'nyct%2Fgtfs-si',
  'A':'nyct%2Fgtfs-ace','C':'nyct%2Fgtfs-ace','E':'nyct%2Fgtfs-ace',
  'B':'nyct%2Fgtfs-bdfm','D':'nyct%2Fgtfs-bdfm','F':'nyct%2Fgtfs-bdfm','FX':'nyct%2Fgtfs-bdfm','M':'nyct%2Fgtfs-bdfm',
  'G':'nyct%2Fgtfs-g',
  'J':'nyct%2Fgtfs-jz','Z':'nyct%2Fgtfs-jz',
  'L':'nyct%2Fgtfs-l',
  'N':'nyct%2Fgtfs-nqrw','Q':'nyct%2Fgtfs-nqrw','R':'nyct%2Fgtfs-nqrw','W':'nyct%2Fgtfs-nqrw',
};
// Bus borough feeds (determined from route prefix)
function busFeed(routeId) {
  const r = (routeId || '').toUpperCase();
  if (r.startsWith('BX')) return 'nyct%2Fgtfs-bx';
  if (r.startsWith('B'))  return 'nyct%2Fgtfs-bk';
  if (r.startsWith('M'))  return 'nyct%2Fgtfs-mn';
  if (r.startsWith('Q') || r.startsWith('X')) return 'nyct%2Fgtfs-qn';
  if (r.startsWith('S'))  return 'nyct%2Fgtfs-si';
  return 'nyct%2Fgtfs-mn'; // default
}

// 30-second cache per feed name — stores arrivals + vehicles decoded from same buffer
const _feedCache = new Map();
async function _fetchAndCache(feedName) {
  const MTA_KEY = process.env.MTA_API_KEY;
  if (!MTA_KEY) return null;
  const now = Date.now();
  const cached = _feedCache.get(feedName);
  if (cached && now - cached.at < 30000) return cached;

  try {
    const url = `https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/${feedName}`;
    const resp = await fetch(url, { headers: { 'x-api-key': MTA_KEY }, signal: AbortSignal.timeout(8000) });
    if (!resp.ok) { console.warn('MTA feed error', resp.status, feedName); return null; }
    const buf = Buffer.from(await resp.arrayBuffer());
    const { arrivals, vehicles } = decodeGtfsRtFeed(buf);
    const entry = { arrivals, vehicles, at: now };
    _feedCache.set(feedName, entry);
    return entry;
  } catch(e) {
    console.warn('MTA feed fetch failed:', feedName, e.message);
    return null;
  }
}
async function getFeedArrivals(feedName) {
  const entry = await _fetchAndCache(feedName);
  return entry ? entry.arrivals : null;
}
async function getFeedVehicles(feedName) {
  const entry = await _fetchAndCache(feedName);
  return entry ? entry.vehicles : null;
}

// Separate 2-minute cache for alerts (changes less often)
const _alertCache = new Map();
async function getAlerts(feedName) {
  const MTA_KEY = process.env.MTA_API_KEY;
  if (!MTA_KEY) return null;
  const now = Date.now();
  const cached = _alertCache.get(feedName);
  if (cached && now - cached.at < 120000) return cached.alerts;
  try {
    const url = `https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/${feedName}`;
    const resp = await fetch(url, { headers: { 'x-api-key': MTA_KEY }, signal: AbortSignal.timeout(8000) });
    if (!resp.ok) return null;
    const alerts = decodeAlerts(Buffer.from(await resp.arrayBuffer()));
    _alertCache.set(feedName, { alerts, at: now });
    return alerts;
  } catch(e) {
    console.warn('MTA alerts fetch failed:', e.message);
    return null;
  }
}

// GET /api/nyc/subway-arrivals?gtfs_stop_ids=R16,A27,127&lines=N,Q,R,W,1,2,3
app.get('/api/nyc/subway-arrivals', async (req, res) => {
  if (!process.env.MTA_API_KEY)
    return res.json({ ok: false, error: 'MTA_API_KEY not set', arrivals: [] });

  const gtfsIds = (req.query.gtfs_stop_ids || '').split(',').map(s=>s.trim()).filter(Boolean);
  const lines   = (req.query.lines   || '').split(',').map(s=>s.trim()).filter(Boolean);
  if (!gtfsIds.length) return res.status(400).json({ error: 'gtfs_stop_ids required' });

  // Determine which feeds to fetch (unique set)
  const feedSet = new Set(lines.map(l => LINE_FEED[l]).filter(Boolean));
  if (!feedSet.size) feedSet.add('nyct%2Fgtfs'); // fallback

  try {
    const allArrivals = (await Promise.all([...feedSet].map(getFeedArrivals))).flat().filter(Boolean);
    const now = Math.floor(Date.now() / 1000);

    // Match: stop_id in GTFS-RT is like "R16N" or "R16S" — prefix matches our gtfs_stop_ids
    const matched = allArrivals
      .filter(a => {
        return gtfsIds.some(gid => a.stopId === gid || a.stopId.startsWith(gid));
      })
      .filter(a => a.arrTime > now)
      .map(a => ({
        routeId:  a.routeId,
        stopId:   a.stopId,
        direction: a.stopId.endsWith('N') ? 'Northbound' : a.stopId.endsWith('S') ? 'Southbound' : '',
        arrTime:  a.arrTime,
        minsAway: Math.round((a.arrTime - now) / 60),
      }))
      .filter(a => a.minsAway >= 0 && a.minsAway <= 60)
      .sort((a, b) => a.arrTime - b.arrTime)
      .slice(0, 12);

    res.json({ ok: true, arrivals: matched, fetchedAt: now });
  } catch(e) {
    res.status(500).json({ ok: false, error: e.message, arrivals: [] });
  }
});

// GET /api/nyc/bus-arrivals?stop_id=303411&routes=B44,B44+
app.get('/api/nyc/bus-arrivals', async (req, res) => {
  if (!process.env.MTA_API_KEY)
    return res.json({ ok: false, error: 'MTA_API_KEY not set', arrivals: [] });

  const stopId = (req.query.stop_id || '').trim();
  const routes = (req.query.routes  || '').split(',').map(s=>s.trim().replace('+',' ')).filter(Boolean);
  if (!stopId) return res.status(400).json({ error: 'stop_id required' });

  // Determine which feeds to try based on routes
  const feedSet = new Set(routes.length ? routes.map(busFeed) : ['nyct%2Fgtfs-mn','nyct%2Fgtfs-bk','nyct%2Fgtfs-qn','nyct%2Fgtfs-bx']);

  try {
    const allArrivals = (await Promise.all([...feedSet].map(getFeedArrivals))).flat().filter(Boolean);
    const now = Math.floor(Date.now() / 1000);

    const matched = allArrivals
      .filter(a => a.stopId === stopId)
      .filter(a => a.arrTime > now)
      .map(a => ({
        routeId:  a.routeId,
        arrTime:  a.arrTime,
        minsAway: Math.round((a.arrTime - now) / 60),
      }))
      .filter(a => a.minsAway >= 0 && a.minsAway <= 90)
      .sort((a, b) => a.arrTime - b.arrTime)
      .slice(0, 10);

    res.json({ ok: true, arrivals: matched, fetchedAt: now });
  } catch(e) {
    res.status(500).json({ ok: false, error: e.message, arrivals: [] });
  }
});

// GET /api/nyc/vehicle-positions?lines=1,2,3,A,C,E  (omit = all subway feeds)
app.get('/api/nyc/vehicle-positions', async (req, res) => {
  if (!process.env.MTA_API_KEY)
    return res.json({ ok: false, error: 'MTA_API_KEY not set', vehicles: [] });

  const lines = (req.query.lines || '').split(',').map(s => s.trim()).filter(Boolean);

  // Pick feeds to fetch; if no lines specified, fetch all subway feeds
  const ALL_SUBWAY_FEEDS = [
    'nyct%2Fgtfs', 'nyct%2Fgtfs-ace', 'nyct%2Fgtfs-bdfm',
    'nyct%2Fgtfs-g', 'nyct%2Fgtfs-jz', 'nyct%2Fgtfs-l',
    'nyct%2Fgtfs-nqrw', 'nyct%2Fgtfs-si',
  ];
  const feedSet = lines.length
    ? new Set(lines.map(l => LINE_FEED[l]).filter(Boolean))
    : new Set(ALL_SUBWAY_FEEDS);

  try {
    const allVehicles = (await Promise.all([...feedSet].map(getFeedVehicles))).flat().filter(Boolean);
    const now = Math.floor(Date.now() / 1000);

    // Filter stale positions (older than 5 minutes)
    const fresh = allVehicles
      .filter(v => !v.timestamp || (now - v.timestamp) < 300)
      .map(v => ({
        routeId:     v.routeId,
        lat:         Math.round(v.lat * 100000) / 100000,
        lng:         Math.round(v.lng * 100000) / 100000,
        bearing:     Math.round(v.bearing),
        stopId:      v.stopId || '',
        status:      v.status,   // 0=INCOMING_AT 1=STOPPED_AT 2=IN_TRANSIT_TO
        directionId: v.directionId,
      }));

    res.json({ ok: true, vehicles: fresh, count: fresh.length, fetchedAt: now });
  } catch(e) {
    res.status(500).json({ ok: false, error: e.message, vehicles: [] });
  }
});

// GET /api/nyc/alerts?type=subway|bus  (default: subway)
app.get('/api/nyc/alerts', async (req, res) => {
  if (!process.env.MTA_API_KEY)
    return res.json({ ok: false, error: 'MTA_API_KEY not set', alerts: [] });

  const type = (req.query.type || 'subway').toLowerCase();
  const feedName = type === 'bus' ? 'camsys%2Fall-bus-alerts' : 'camsys%2Fsubway-alerts';

  try {
    const alerts = await getAlerts(feedName);
    if (!alerts) return res.json({ ok: false, error: 'Feed unavailable', alerts: [] });

    const now = Math.floor(Date.now() / 1000);
    res.json({ ok: true, alerts, count: alerts.length, fetchedAt: now });
  } catch(e) {
    res.status(500).json({ ok: false, error: e.message, alerts: [] });
  }
});

// ════════════════════════════════════════════
// DC WMATA LIVE — JSON REST API (no protobuf)
// Register free at developer.wmata.com → set WMATA_API_KEY env var
// ════════════════════════════════════════════

const _wmataCache = new Map();

async function _wmataGet(path, cacheSec = 15) {
  const key = process.env.WMATA_API_KEY;
  if (!key) return null;
  const now = Date.now();
  const cached = _wmataCache.get(path);
  if (cached && now - cached.at < cacheSec * 1000) return cached.data;
  try {
    const url  = `https://api.wmata.com${path}`;
    const resp = await fetch(url, {
      headers: { 'api_key': key, 'Accept': 'application/json' },
      signal: AbortSignal.timeout(6000),
    });
    if (!resp.ok) { console.warn('WMATA API error', resp.status, path); return null; }
    const data = await resp.json();
    _wmataCache.set(path, { data, at: now });
    return data;
  } catch(e) {
    console.warn('WMATA fetch failed:', path, e.message);
    return null;
  }
}

// GET /api/dc/train-arrivals?codes=A01,C01
// codes = comma-separated WMATA station codes (e.g. A01 for Farragut North)
app.get('/api/dc/train-arrivals', async (req, res) => {
  if (!process.env.WMATA_API_KEY)
    return res.json({ ok: false, error: 'WMATA_API_KEY not set', trains: [] });

  const codes = (req.query.codes || '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
  if (!codes.length) return res.status(400).json({ error: 'codes required' });

  try {
    // Fetch predictions for all codes in one call — WMATA accepts comma-separated codes
    const codesParam = codes.join(',');
    const data = await _wmataGet(`/StationPrediction.svc/json/GetPrediction/${codesParam}`, 15);
    if (!data || !data.Trains) return res.json({ ok: true, trains: [], fetchedAt: Math.floor(Date.now()/1000) });

    const now = Math.floor(Date.now() / 1000);
    const trains = data.Trains
      .filter(t => t.Line && t.Line !== '--' && t.Line !== 'No' && t.Min !== '')
      .map(t => ({
        line:        t.Line,   // RD, BL, OR, GR, YL, SV
        destination: t.DestinationName || t.Destination,
        destCode:    t.DestinationCode,
        locationCode:t.LocationCode,
        cars:        t.Car,
        min:         t.Min,   // "ARR", "BRD", or numeric string e.g. "3"
        minsAway:    t.Min === 'ARR' ? 0 : t.Min === 'BRD' ? 0 : parseInt(t.Min) || 0,
      }))
      .sort((a, b) => a.minsAway - b.minsAway);

    res.json({ ok: true, trains, fetchedAt: now });
  } catch(e) {
    res.status(500).json({ ok: false, error: e.message, trains: [] });
  }
});

// GET /api/dc/incidents   (rail service alerts — 2-min cache)
app.get('/api/dc/incidents', async (req, res) => {
  if (!process.env.WMATA_API_KEY)
    return res.json({ ok: false, error: 'WMATA_API_KEY not set', incidents: [] });
  try {
    const data = await _wmataGet('/Incidents.svc/json/Incidents', 120);
    const now  = Math.floor(Date.now() / 1000);
    if (!data) return res.json({ ok: false, error: 'Feed unavailable', incidents: [] });
    const incidents = (data.Incidents || []).map(i => ({
      lines:       (i.LinesAffected || '').split(';').map(s => s.trim()).filter(Boolean),
      description: i.Description || '',
      dateUpdated: i.DateUpdated || '',
    }));
    res.json({ ok: true, incidents, fetchedAt: now });
  } catch(e) {
    res.status(500).json({ ok: false, error: e.message, incidents: [] });
  }
});

// GET /api/dc/bus-arrivals?stop=1001195
app.get('/api/dc/bus-arrivals', async (req, res) => {
  if (!process.env.WMATA_API_KEY)
    return res.json({ ok: false, error: 'WMATA_API_KEY not set', predictions: [] });
  const stopId = (req.query.stop || '').trim();
  if (!stopId) return res.status(400).json({ error: 'stop required' });
  try {
    const data = await _wmataGet(`/NextBusService.svc/json/jPredictions?StopID=${stopId}`, 30);
    const now  = Math.floor(Date.now() / 1000);
    if (!data) return res.json({ ok: true, predictions: [], fetchedAt: now });
    const predictions = (data.Predictions || []).map(p => ({
      routeId:     p.RouteID,
      directionText: p.DirectionText,
      minutes:     p.Minutes,
      vehicleId:   p.VehicleID,
    })).sort((a, b) => a.minutes - b.minutes);
    res.json({ ok: true, predictions, stopName: data.StopName, fetchedAt: now });
  } catch(e) {
    res.status(500).json({ ok: false, error: e.message, predictions: [] });
  }
});

// ════════════════════════════════════════════
// DELHI OTD LIVE — GTFS-RT protobuf
// Register at otd.delhi.gov.in → set DELHI_OTD_KEY env var
// Key is sent as ?key=<token> query parameter per OTD documentation
// ════════════════════════════════════════════

const _delhiCache = new Map();

async function _fetchDelhiRt(endpoint, cacheSec = 30) {
  const key = process.env.DELHI_OTD_KEY;
  if (!key) return null;
  const now = Date.now();
  const cached = _delhiCache.get(endpoint);
  if (cached && now - cached.at < cacheSec * 1000) return cached.data;
  try {
    const url  = `https://otd.delhi.gov.in/api/realtime/${endpoint}?key=${encodeURIComponent(key)}`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!resp.ok) { console.warn(`Delhi OTD ${resp.status} for ${endpoint}`); return null; }
    const data = Buffer.from(await resp.arrayBuffer());
    _delhiCache.set(endpoint, { data, at: now });
    return data;
  } catch(e) {
    console.warn('Delhi OTD fetch failed:', endpoint, e.message);
    return null;
  }
}

// GET /api/delhi/vehicle-positions
// Returns live metro vehicle positions decoded from GTFS-RT VehiclePositions.pb
app.get('/api/delhi/vehicle-positions', async (req, res) => {
  if (!process.env.DELHI_OTD_KEY)
    return res.json({ ok: false, error: 'DELHI_OTD_KEY not set', vehicles: [] });
  try {
    const buf = await _fetchDelhiRt('VehiclePositions.pb', 30);
    if (!buf) return res.json({ ok: false, error: 'Feed unavailable', vehicles: [] });

    const { vehicles } = decodeGtfsRtFeed(buf);
    const now = Math.floor(Date.now() / 1000);

    // Filter stale positions (older than 5 minutes) and bad coordinates
    const fresh = vehicles
      .filter(v => (!v.timestamp || (now - v.timestamp) < 300) && v.lat !== 0 && v.lng !== 0)
      .filter(v => v.lat > 28.0 && v.lat < 29.5 && v.lng > 76.5 && v.lng < 78.0) // Delhi bounding box
      .map(v => ({
        routeId:   v.routeId,
        lat:       Math.round(v.lat * 100000) / 100000,
        lng:       Math.round(v.lng * 100000) / 100000,
        bearing:   Math.round(v.bearing),
        stopId:    v.stopId || '',
        status:    v.status,   // 0=INCOMING_AT 1=STOPPED_AT 2=IN_TRANSIT_TO
        timestamp: v.timestamp,
      }));

    res.json({ ok: true, vehicles: fresh, count: fresh.length, fetchedAt: now });
  } catch(e) {
    res.status(500).json({ ok: false, error: e.message, vehicles: [] });
  }
});

// GET /api/delhi/trip-updates   (TripUpdates.pb — may 404 if OTD doesn't publish it)
// Used for per-station arrival predictions
app.get('/api/delhi/trip-updates', async (req, res) => {
  if (!process.env.DELHI_OTD_KEY)
    return res.json({ ok: false, error: 'DELHI_OTD_KEY not set', arrivals: [] });
  try {
    const buf = await _fetchDelhiRt('TripUpdates.pb', 30);
    if (!buf) return res.json({ ok: false, error: 'Feed unavailable', arrivals: [] });

    const { arrivals } = decodeGtfsRtFeed(buf);
    const now = Math.floor(Date.now() / 1000);
    const stopIds = (req.query.stop_ids || '').split(',').map(s => s.trim()).filter(Boolean);

    const matched = arrivals
      .filter(a => !stopIds.length || stopIds.some(id => a.stopId === id || a.stopId.startsWith(id)))
      .filter(a => a.arrTime > now)
      .map(a => ({
        routeId:  a.routeId,
        stopId:   a.stopId,
        arrTime:  a.arrTime,
        minsAway: Math.round((a.arrTime - now) / 60),
      }))
      .filter(a => a.minsAway >= 0 && a.minsAway <= 60)
      .sort((a, b) => a.arrTime - b.arrTime)
      .slice(0, 10);

    res.json({ ok: true, arrivals: matched, fetchedAt: now });
  } catch(e) {
    res.status(500).json({ ok: false, error: e.message, arrivals: [] });
  }
});

// ── CATCH-ALL ──
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.listen(PORT, () => {
  console.log(`✅ GaitWay v2 on port ${PORT}`);
  const _du = process.env.DATABASE_URL;
  const _dbLog = _du && (_du.startsWith('postgresql://') || _du.startsWith('postgres://'))
    ? `✓ DATABASE_URL set (host: ${_du.split('@')[1]?.split('/')[0] || '?'})`
    : process.env.DB_PASSWORD ? `✓ DB_PASSWORD set` : '⚠ No DB credentials set';
  console.log(`   DB:       ${_dbLog}`);
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
