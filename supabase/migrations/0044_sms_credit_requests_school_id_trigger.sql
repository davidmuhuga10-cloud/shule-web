-- ---------------------------------------------------------------------------
-- 0044_sms_credit_requests_school_id_trigger.sql
--
-- Bug fix: sms_credit_requests (migrations/0035_admin_dashboard.sql) was
-- created WITHOUT the trg_..._school_id trigger every other multi-tenant
-- table gets (see public.set_school_id(), used by ~30 tables). The school
-- side's own submitRequest() (src/lib/api/smsCredits.mjs) — like every other
-- insert() in this app — never sets school_id itself; it relies entirely on
-- that trigger stamping it from the caller's own profile.
--
-- Without the trigger, school_id landed NULL, and the insert policy
-- (`with check (is_staff() and school_id = current_school_id())`) evaluates
-- NULL = current_school_id() as unknown/false — Postgres reports this as a
-- generic "new row violates row-level security policy" rather than a
-- clearer "missing school_id" error, which is what a school owner hit when
-- trying to request SMS credit top-up with an empty wallet.
-- ---------------------------------------------------------------------------
create trigger trg_sms_credit_requests_school_id before insert on public.sms_credit_requests
  for each row execute function public.set_school_id();
