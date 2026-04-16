-- MAWD migration: add connection_mode, team, and identity columns to
-- mawd_instances. Run this against your Supabase project after deploying
-- the Settings modal + guest sessions + identity-aware onboarding.
--
-- The server-side /api/onboard has a schema-fallback retry that tolerates
-- these columns being missing, but features tied to them only work once
-- the migration is applied:
--   - connection_mode: Gmail session vs persistent enforcement
--   - team: orphaned guest row hygiene
--   - public_name / preferred_name / account_name: multi-identity support
--     (stage name vs handle vs legal name)
--
-- Run once. Safe to re-run (uses IF NOT EXISTS).

-- Connection mode + team (from Settings + guest session work)
ALTER TABLE mawd_instances
  ADD COLUMN IF NOT EXISTS connection_mode TEXT DEFAULT 'persistent';

ALTER TABLE mawd_instances
  ADD COLUMN IF NOT EXISTS team TEXT DEFAULT 'fanded';

-- Identity triad (from stage-name + handle onboarding work)
--   public_name    = what the user typed on Screen 1 (e.g. "@mayasbrand")
--                    used for public crawl and draft signatures
--   preferred_name = what the user confirmed on the optional Screen 3.5
--                    (e.g. "Maya") used for UI addressing
--   account_name   = Google OAuth userinfo display name
--                    used for inbox contact matching
ALTER TABLE mawd_instances
  ADD COLUMN IF NOT EXISTS public_name TEXT;

ALTER TABLE mawd_instances
  ADD COLUMN IF NOT EXISTS preferred_name TEXT;

ALTER TABLE mawd_instances
  ADD COLUMN IF NOT EXISTS account_name TEXT;

-- Tag existing rows with explicit defaults so subsequent UPDATEs
-- don't leave NULLs behind.
UPDATE mawd_instances SET connection_mode = 'persistent' WHERE connection_mode IS NULL;
UPDATE mawd_instances SET team = 'fanded' WHERE team IS NULL;
UPDATE mawd_instances SET public_name = name WHERE public_name IS NULL AND name IS NOT NULL;

-- Index on team for future cron cleanup of orphaned guest rows.
CREATE INDEX IF NOT EXISTS idx_mawd_instances_team ON mawd_instances (team);

-- Future cleanup sweep (not run here): delete guest rows whose
-- google_refresh_token is null and created_at > 24h ago. Wire to a Vercel
-- cron later.
--
-- DELETE FROM mawd_instances
-- WHERE team = 'guest'
--   AND google_refresh_token IS NULL
--   AND created_at < (now() - interval '24 hours');
