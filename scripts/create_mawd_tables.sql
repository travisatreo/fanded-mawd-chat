-- MAWD Multi-Instance Tables
-- Run this in Supabase SQL Editor (Dashboard > SQL Editor > New Query)

-- 1. MAWD Instances — one row per MAWD user
CREATE TABLE IF NOT EXISTS mawd_instances (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  role TEXT DEFAULT '',
  personal_brain TEXT DEFAULT '',
  shared_brain TEXT DEFAULT '',
  full_brain TEXT DEFAULT '',
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_mawd_instances_slug ON mawd_instances(slug);
CREATE INDEX IF NOT EXISTS idx_mawd_instances_email ON mawd_instances(email);

-- 2. MAWD Messages — inter-MAWD communication
CREATE TABLE IF NOT EXISTS mawd_messages (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  from_mawd TEXT NOT NULL REFERENCES mawd_instances(slug),
  to_mawd TEXT NOT NULL REFERENCES mawd_instances(slug),
  from_name TEXT DEFAULT '',
  to_name TEXT DEFAULT '',
  type TEXT DEFAULT 'message',  -- message, request, response, scheduling, task
  subject TEXT DEFAULT '',
  body TEXT NOT NULL,
  metadata JSONB DEFAULT '{}',
  status TEXT DEFAULT 'pending',  -- pending, read, actioned, dismissed
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_mawd_messages_to ON mawd_messages(to_mawd);
CREATE INDEX IF NOT EXISTS idx_mawd_messages_from ON mawd_messages(from_mawd);
CREATE INDEX IF NOT EXISTS idx_mawd_messages_status ON mawd_messages(status);

-- 3. Per-MAWD memory (extends existing mawd_memory with slug column)
-- If mawd_memory already exists, add the column:
ALTER TABLE mawd_memory ADD COLUMN IF NOT EXISTS mawd_slug TEXT DEFAULT NULL;
CREATE INDEX IF NOT EXISTS idx_mawd_memory_slug ON mawd_memory(mawd_slug);

-- 4. Enable RLS but allow service role full access
ALTER TABLE mawd_instances ENABLE ROW LEVEL SECURITY;
ALTER TABLE mawd_messages ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access" ON mawd_instances FOR ALL USING (true);
CREATE POLICY "Service role full access" ON mawd_messages FOR ALL USING (true);
