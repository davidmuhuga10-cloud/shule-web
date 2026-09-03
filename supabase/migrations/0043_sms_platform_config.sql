-- ============================================================================
-- 0043_sms_platform_config.sql — moves the Africa's Talking credential off
-- Netlify environment variables and into the database, mirroring exactly
-- how the Rentals project's own `sms_platform_config` table already works.
--
-- Why: this app's server code happens to run on Netlify Functions today,
-- but the credential shouldn't be coupled to that choice — a database row
-- comes along for free if the hosting ever changes; an env var doesn't.
-- Single row (id fixed at 1, same convention as exam_components' sibling
-- tables use for a one-row config), read once per Netlify Function
-- invocation by netlify/functions/_lib/smsProvider.js's loadSmsConfig().
--
-- Server-only: RLS enabled with zero policies, so no browser session (anon
-- or authenticated) can ever read this table via PostgREST — only the
-- service_role key a Netlify Function already holds can. Same "deny-all by
-- default" convention as phone_otps (0042).
-- ============================================================================

begin;

create table if not exists public.sms_platform_config (
  id integer primary key default 1,
  provider text not null default 'africas_talking',
  api_key text,
  username text,
  sender_id text,
  cost_per_sms numeric not null default 0,
  price_per_sms numeric not null default 0,
  updated_at timestamptz not null default now(),
  constraint sms_platform_config_single_row check (id = 1)
);

-- Seed the one row that will ever exist so an UPDATE (not INSERT) is always
-- the right way to set credentials — matches the header comment above and
-- avoids every caller needing an upsert just to read a config that might
-- not exist yet.
insert into public.sms_platform_config (id) values (1) on conflict (id) do nothing;

create or replace function public.set_sms_platform_config_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;
drop trigger if exists trg_sms_platform_config_updated_at on public.sms_platform_config;
create trigger trg_sms_platform_config_updated_at before update on public.sms_platform_config
  for each row execute function public.set_sms_platform_config_updated_at();

alter table public.sms_platform_config enable row level security;
-- No policies: identical reasoning to phone_otps (0042) — this table is
-- never touched except via the service_role key inside a Netlify Function.

commit;
