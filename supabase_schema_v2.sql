-- GAITWAY V2 schema update — run this in Supabase SQL Editor

-- Add email column to users (nullable — guest users have no email)
ALTER TABLE users ADD COLUMN IF NOT EXISTS email TEXT;

-- Ensure all existing columns exist
ALTER TABLE users ADD COLUMN IF NOT EXISTS name         TEXT    DEFAULT 'Walker';
ALTER TABLE users ADD COLUMN IF NOT EXISTS xp           INTEGER DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS route_count  INTEGER DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS hazard_count INTEGER DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS updated_at   TIMESTAMPTZ DEFAULT NOW();

-- Hazard env columns
ALTER TABLE hazards ADD COLUMN IF NOT EXISTS surface        TEXT;
ALTER TABLE hazards ADD COLUMN IF NOT EXISTS canopy         TEXT;
ALTER TABLE hazards ADD COLUMN IF NOT EXISTS lighting       TEXT;
ALTER TABLE hazards ADD COLUMN IF NOT EXISTS footpath_type  TEXT;
ALTER TABLE hazards ADD COLUMN IF NOT EXISTS footpath_width TEXT;

-- Profile fields for user preferences
ALTER TABLE users ADD COLUMN IF NOT EXISTS walk_purpose  TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS walk_priority TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS area          TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_hint    TEXT;
