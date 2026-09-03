-- ============================================================================
-- 0042_phone_otps.sql — the storage side of real phone verification, closing
-- the gap both school-signup.js and forgot-password.js have flagged in their
-- own comments since Phase 0/B2 ("no OTP/email verification for now... a
-- verified reset is planned for a later update"). Now that a real SMS
-- provider is wired in (see netlify/functions/_lib/smsProvider.js,
-- 0041_sms_wallet_debit_rpc.sql), a 6-digit code can actually reach a phone.
--
-- One table, touched ONLY by Netlify Functions (send-otp.js / verify-otp.js)
-- via the service_role key — never by a browser session directly, so RLS is
-- enabled with zero policies (deny-all to anon/authenticated), same
-- "server-only table" convention already used for e.g.
-- admin_impersonation_sessions.
--
-- Deliberately NOT scoped to a school_id: at signup time there is no school
-- yet (same reason school-signup.js itself runs before any school exists),
-- and a password-reset OTP is keyed on the phone number the person is
-- about to prove they own, not on an account that's already been resolved.
-- ============================================================================

begin;

create table if not exists public.phone_otps (
  id uuid primary key default gen_random_uuid(),
  phone text not null,
  purpose text not null check (purpose in ('signup', 'password_reset')),
  code_hash text not null,
  expires_at timestamptz not null,
  attempts integer not null default 0,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);

-- send-otp.js's rate-limit check and verify-otp.js's "latest live code for
-- this phone+purpose" lookup are both `where phone = ? and purpose = ?
-- order by created_at desc` — this index serves both directly.
create index if not exists idx_phone_otps_lookup on public.phone_otps(phone, purpose, created_at desc);

alter table public.phone_otps enable row level security;
-- No policies: this table is never read or written except via the
-- service_role key inside a Netlify Function, so RLS with nothing defined
-- correctly denies every anon/authenticated request that might otherwise
-- reach it through PostgREST.

commit;
