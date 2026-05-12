-- GAITWAY V5 — Supabase Schema
CREATE TABLE IF NOT EXISTS hazards (
  id BIGSERIAL PRIMARY KEY, type TEXT NOT NULL, lat FLOAT NOT NULL, lng FLOAT NOT NULL,
  user_id TEXT, photo_b64 TEXT, ai_label TEXT, surface TEXT, canopy TEXT,
  lighting TEXT, footpath_type TEXT, footpath_width TEXT, created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS routes (
  id BIGSERIAL PRIMARY KEY, user_id TEXT NOT NULL, from_name TEXT, to_name TEXT,
  from_lat FLOAT, from_lng FLOAT, to_lat FLOAT, to_lng FLOAT, mode TEXT,
  dist_km FLOAT, duration_min INTEGER, steps INTEGER, calories INTEGER,
  walk_score INTEGER, surface_log JSONB, created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, name TEXT DEFAULT 'Walker', xp INTEGER DEFAULT 0,
  route_count INTEGER DEFAULT 0, hazard_count INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_hazards_created ON hazards (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_hazards_user ON hazards (user_id);
CREATE INDEX IF NOT EXISTS idx_hazards_lat_lng ON hazards (lat, lng);
CREATE INDEX IF NOT EXISTS idx_routes_user ON routes (user_id);
CREATE INDEX IF NOT EXISTS idx_users_xp ON users (xp DESC);
ALTER TABLE hazards DISABLE ROW LEVEL SECURITY;
ALTER TABLE routes DISABLE ROW LEVEL SECURITY;
ALTER TABLE users DISABLE ROW LEVEL SECURITY;
