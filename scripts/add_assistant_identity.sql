-- Add per-user assistant identity: custom name + optional ElevenLabs voice ID
-- Run in Supabase SQL editor

ALTER TABLE mawd_instances
  ADD COLUMN IF NOT EXISTS assistant_name TEXT,
  ADD COLUMN IF NOT EXISTS elevenlabs_voice_id TEXT;

-- Seed Travis's existing instance with his chosen name if you want (edit before running)
-- UPDATE mawd_instances SET assistant_name = 'Lewis' WHERE slug = 'travis';
