-- ---------------------------------------------------------------------------
-- 0047_security_hardening.sql — full security audit (penetration-test pass).
-- Two real, confirmed cross-tenant vulnerabilities fixed; both additive/
-- restrictive only (narrows existing over-broad access, doesn't touch any
-- application code path that was working correctly).
--
-- 1. debit_sms_wallet(p_school_id, p_credits) — 0041_sms_wallet_debit_rpc.sql
--    granted EXECUTE to `authenticated` (any logged-in user of ANY school),
--    and the function body never checks the caller's own school against
--    p_school_id before debiting. Its only real caller is
--    netlify/functions/send-message.js, which already runs it through the
--    service-role client (confirmed by grep — nothing in src/ calls it).
--    As shipped, any logged-in staff/teacher/parent at School A could call
--    `supabase.rpc('debit_sms_wallet', { p_school_id: '<school-B-id>',
--    p_credits: 999999 })` directly from the browser console and drain
--    another school's SMS wallet to zero — school UUIDs aren't secret
--    (visible in shared links, exports, etc.). Restricting the grant to
--    service_role only closes this with zero effect on the one legitimate
--    caller, which already uses the service-role client.
--
--    Applying this against the live project also surfaced that Postgres'
--    own DEFAULT grant-to-PUBLIC on newly created functions (plus the
--    Supabase-default `anon` grant) meant this function was ALSO callable
--    by anyone not even logged in, on top of the `authenticated` gap
--    above — revoked here explicitly rather than assumed away.
--
-- 2. finance_counters (0031_finance_module.sql) — the ONLY table in that
--    entire migration file with no `enable row level security` and no
--    policy at all, unlike every sibling finance_* table. It's written
--    only via the finance_next_no() security-definer function (which
--    bypasses RLS regardless, so this doesn't affect its normal writer)
--    and is never queried directly from src/lib/api anywhere (confirmed by
--    grep). Without RLS, Supabase's default grants to `authenticated`
--    would let any logged-in user of any school read or corrupt every
--    school's invoice/receipt numbering sequence directly. Enabling RLS
--    with no policies (matching the documented "writes only via the
--    security-definer function" pattern already used for
--    finance_student_routes' insert/update) denies all direct access
--    without touching the one legitimate writer.
-- ---------------------------------------------------------------------------
begin;

revoke execute on function public.debit_sms_wallet(uuid, integer) from authenticated;
revoke execute on function public.debit_sms_wallet(uuid, integer) from anon;
revoke execute on function public.debit_sms_wallet(uuid, integer) from public;
grant execute on function public.debit_sms_wallet(uuid, integer) to service_role;

alter table public.finance_counters enable row level security;

commit;
