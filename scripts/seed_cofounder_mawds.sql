-- Seed MAWD instances for Kevin and Lewis so cross-MAWD standup has identities
-- Run this in Supabase SQL editor

insert into public.mawd_instances (slug, name, email)
values
  ('kevin', 'Kevin Garcia', 'kevin@fanded.com'),
  ('lewis', 'Lewis', 'lewis@fanded.com')
on conflict (slug) do nothing;

-- Ensure mawd_memory has mawd_slug column (may already exist)
alter table public.mawd_memory
  add column if not exists mawd_slug text default 'travis';

-- Backfill existing rows
update public.mawd_memory set mawd_slug = 'travis' where mawd_slug is null;

-- Index for fast cross-MAWD standup queries
create index if not exists idx_mawd_memory_slug_category_created
  on public.mawd_memory (mawd_slug, category, created_at desc);
