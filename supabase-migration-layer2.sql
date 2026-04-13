-- MAWD Layer 2: Multi-MAWD with per-user Google OAuth
-- Run this in Supabase SQL Editor (Dashboard > SQL Editor > New Query)

-- 1. Add Google OAuth columns to mawd_instances
ALTER TABLE mawd_instances
ADD COLUMN IF NOT EXISTS google_refresh_token TEXT,
ADD COLUMN IF NOT EXISTS google_scopes TEXT,
ADD COLUMN IF NOT EXISTS google_email TEXT;

-- 2. Create MAWD network messages table (for MAWD-to-MAWD communication)
CREATE TABLE IF NOT EXISTS mawd_network_messages (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  from_mawd TEXT NOT NULL,
  to_mawd TEXT NOT NULL,
  from_name TEXT,
  to_name TEXT,
  type TEXT DEFAULT 'message',  -- message, request, response, scheduling, task
  subject TEXT DEFAULT '',
  body TEXT NOT NULL,
  metadata JSONB DEFAULT '{}',
  status TEXT DEFAULT 'pending',  -- pending, read, actioned, dismissed
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 3. Create MAWD memory table (if not exists)
CREATE TABLE IF NOT EXISTS mawd_memory (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  mawd_slug TEXT,
  category TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 4. Indexes for performance
CREATE INDEX IF NOT EXISTS idx_mawd_network_to ON mawd_network_messages(to_mawd, status);
CREATE INDEX IF NOT EXISTS idx_mawd_network_from ON mawd_network_messages(from_mawd);
CREATE INDEX IF NOT EXISTS idx_mawd_memory_slug ON mawd_memory(mawd_slug);
CREATE INDEX IF NOT EXISTS idx_mawd_instances_slug ON mawd_instances(slug);

-- 5. Enable RLS (Row Level Security) but allow service role full access
ALTER TABLE mawd_network_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE mawd_memory ENABLE ROW LEVEL SECURITY;

-- Service role can do everything
CREATE POLICY IF NOT EXISTS "Service role full access to network messages"
  ON mawd_network_messages FOR ALL
  USING (true) WITH CHECK (true);

CREATE POLICY IF NOT EXISTS "Service role full access to mawd memory"
  ON mawd_memory FOR ALL
  USING (true) WITH CHECK (true);
