-- MAWD migration: add connection_mode and team columns to mawd_instances.
-- Run this against your Supabase project before (or shortly after) deploying
-- the Settings modal + guest session work. The server-side onboard endpoint
-- has a schema-fallback retry that tolerates the columns being missing, but
-- features tied to these columns (session-mode Gmail expiration, guest row
-- hygiene) only work once the migration is applied.
--
-- Run once. Safe to re-run (uses IF NOT EXISTS).

ALTER TABLE mawd_instances
  ADD COLUMN IF NOT EXISTS connection_mode TEXT DEFAULT 'persistent';

ALTER TABLE mawd_instances
  ADD COLUMN IF NOT EXISTS team TEXT DEFAULT 'fanded';

-- Optional: tag existing rows with explicit defaults so subsequent UPDATEs
-- don't leave NULLs behind.
UPDATE mawd_instances SET connection_mode = 'persistent' WHERE connection_mode IS NULL;
UPDATE mawd_instances SET team = 'fanded' WHERE team IS NULL;

-- Optional: index on team for future cron cleanup of orphaned guest rows.
CREATE INDEX IF NOT EXISTS idx_mawd_instances_team ON mawd_instances (team);

-- Optional future cleanup sweep (not run here): delete guest rows whose
-- google_refresh_token is null and created_at > 24h ago. Wire to a Vercel
-- cron later.
--
-- DELETE FROM mawd_instances
-- WHERE team = 'guest'
--   AND google_refresh_token IS NULL
--   AND created_at < (now() - interval '24 hours');
