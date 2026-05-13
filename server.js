/**
 * GAITWAY BACKEND — server.js
 * Express + PostgreSQL (Supabase Session Pooler — IPv4 compatible)
 */

const express = require('express');
const { Pool } = require('pg');
const cors    = require('cors');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '5mb' }));
app.use(express.static(__dirname));

// ── DATABASE ──
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 5, idleTimeoutMillis: 30000, connectionTimeoutMillis: 15000,
});

console.log('Serving index.html from:', path.join(__dirname, 'index.html'));

pool.query('SELECT NOW()')
  .then(r => console.log('✅ DB connected at', r.rows[0].now))
  .catch(e => console.error('❌ DB connection failed:', e.message));

// ── HAVERSINE ──
function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371, r = Math.PI/180;
  const dL=(lat2-lat1)*r, dO=(lon2-lon1)*r;
  const a=Math.sin(dL/2)**2+Math.cos(lat1*r)*Math.cos(lat2*r)*Math.sin(dO/2)**2;
  return R*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a));
}

// ── HAZARDS ──
app.post('/api/hazards', async (req, res) => {
  const { type, lat, lng, user_id, photo_b64, ai_label,
          surface, canopy, lighting, footpath_type, footpath_width } = req.body;
  if (!type || lat == null || lng == null)
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
       ON CONFLICT (id) DO UPDATE SET xp=users.xp+50, hazard_count=users.hazard_count+1, updated_at=NOW()`,
      [user_id]
    );
    res.json({ id: r.rows[0].id, ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/hazards', async (req, res) => {
  const { lat, lng, radius=5, limit=200 } = req.query;
  try {
    const { rows } = await pool.query(
      `SELECT id,type,lat,lng,user_id,ai_label,surface,canopy,lighting,
              footpath_type,footpath_width,created_at
       FROM hazards ORDER BY created_at DESC LIMIT 1000`
    );
    let hazards = rows;
    if (lat && lng) {
      hazards = rows
        .filter(h => haversineKm(parseFloat(lat),parseFloat(lng),h.lat,h.lng) <= parseFloat(radius))
        .slice(0, parseInt(limit));
    }
    res.json(hazards);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── ROUTES ──
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
       mode,dist_km,duration_min,steps,calories,walk_score,
       JSON.stringify(surface_log||{})]
    );
    await pool.query(
      `INSERT INTO users (id,xp,route_count) VALUES ($1,250,1)
       ON CONFLICT (id) DO UPDATE SET xp=users.xp+250, route_count=users.route_count+1, updated_at=NOW()`,
      [user_id]
    );
    res.json({ id: r.rows[0].id, ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/routes/:userId', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM routes WHERE user_id=$1 ORDER BY created_at DESC LIMIT 50`,
      [req.params.userId]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── USERS ──
app.post('/api/users/upsert', async (req, res) => {
  const { id, name } = req.body;
  if (!id) return res.status(400).json({ error: 'id required' });
  try {
    await pool.query(
      `INSERT INTO users (id,name) VALUES ($1,$2)
       ON CONFLICT (id) DO UPDATE SET name=COALESCE($2,users.name), updated_at=NOW()`,
      [id, name||'Walker']
    );
    const { rows } = await pool.query(`SELECT * FROM users WHERE id=$1`,[id]);
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/users/:userId', async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT * FROM users WHERE id=$1`,[req.params.userId]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
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

// ── AI VISION PROXY ──
app.post('/api/vision', async (req, res) => {
  const { image_b64 } = req.body;
  if (!image_b64) return res.status(400).json({ error: 'image_b64 required' });
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set' });
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 80,
        messages: [{ role:'user', content:[
          { type:'image', source:{ type:'base64', media_type:'image/jpeg', data:image_b64 } },
          { type:'text', text:'What walkability hazard, footpath type, or surface condition is in this image? Reply with ONE label max 6 words. No explanation.' }
        ]}]
      })
    });
    const data = await response.json();
    res.json({ label: data.content?.[0]?.text?.trim() || 'Unknown hazard' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── STATS ──
app.get('/api/stats', async (req, res) => {
  try {
    const [h,r,u,t] = await Promise.all([
      pool.query(`SELECT COUNT(*) FROM hazards`),
      pool.query(`SELECT COUNT(*) FROM routes`),
      pool.query(`SELECT COUNT(*) FROM users`),
      pool.query(`SELECT type,COUNT(*) as count FROM hazards GROUP BY type ORDER BY count DESC LIMIT 5`)
    ]);
    res.json({ hazards:+h.rows[0].count, routes:+r.rows[0].count, users:+u.rows[0].count, top_types:t.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── CATCH-ALL ──
const INDEX = path.join(__dirname, 'index.html');
app.get('*', (req, res) => res.sendFile(INDEX));

app.listen(PORT, () => {
  console.log(`✅ GaitWay running on port ${PORT}`);
  console.log(`   DB:  ${process.env.DB_PASSWORD ? '✓ configured' : '⚠ DB_PASSWORD not set'}`);
  console.log(`   AI:  ${process.env.ANTHROPIC_API_KEY ? '✓ configured' : '⚠ ANTHROPIC_API_KEY not set'}`);
  console.log('Static serving from:', __dirname);
  console.log('index.html exists:', require('fs').existsSync(path.join(__dirname, 'index.html')));
});
