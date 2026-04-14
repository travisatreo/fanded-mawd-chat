-- Scheduled fan letters — queued by client, dispatched by /api/scheduled cron
create table if not exists public.mawd_scheduled_letters (
  id uuid primary key default gen_random_uuid(),
  title text,
  subject text not null,
  body text not null,
  listen_url text,
  duration text,
  scheduled_for timestamptz not null,
  status text not null default 'scheduled', -- scheduled | sent | failed | cancelled
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  sent_count int,
  failed_count int,
  last_error text
);

create index if not exists idx_mawd_scheduled_letters_status_time
  on public.mawd_scheduled_letters (status, scheduled_for);
