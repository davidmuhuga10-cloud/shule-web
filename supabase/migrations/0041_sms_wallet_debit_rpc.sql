-- ============================================================================
-- 0041_sms_wallet_debit_rpc.sql — the missing piece to actually charge a
-- school's sms_wallets balance the moment send-message.js hands a batch of
-- guardian/staff SMS to the real provider (Africa's Talking — see
-- netlify/functions/_lib/smsProvider.js). Everything else this feature
-- needs (sms_wallets, sms_credit_requests, sms_credit_ledger, message_logs)
-- already exists from Phase 1 — this migration adds exactly one function.
--
-- Why an RPC instead of a plain UPDATE from the Netlify function: two sends
-- for the same school landing in the same instant must not both read
-- "balance = 5, need 3" and both proceed — the classic double-spend race.
-- A single `UPDATE ... WHERE balance >= p_credits RETURNING balance` is
-- atomic in Postgres (the WHERE is evaluated as part of the same row lock
-- the UPDATE takes), so wrapping it as one RPC call is what actually makes
-- it safe, not just tidy.
--
-- Deliberately does NOT touch sms_credit_ledger — that table's own header
-- comment documents it as "a permanent record of every approved credit"
-- (top-ups), not a debit log; a per-send debit trail already exists via
-- message_logs (one row per recipient, with its own status/timestamps).
-- ============================================================================

begin;

create or replace function public.debit_sms_wallet(p_school_id uuid, p_credits integer)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_balance integer;
begin
  if p_school_id is null then
    raise exception 'Missing school.';
  end if;
  if p_credits is null or p_credits <= 0 then
    raise exception 'Invalid credit amount.';
  end if;

  update public.sms_wallets
    set balance = balance - p_credits, updated_at = now()
    where school_id = p_school_id and balance >= p_credits
    returning balance into v_balance;

  if v_balance is null then
    raise exception 'Not enough SMS credit — top up before sending.';
  end if;

  return v_balance;
end;
$$;

-- Callable by staff (the same role send-message.js already gates on) as
-- well as the service-role key Netlify Functions actually use — RLS on
-- sms_wallets itself is unaffected (still select-only for a school's own
-- staff, per 0003b's sms_wallets_select policy); this function is the one
-- sanctioned way balance ever moves down.
grant execute on function public.debit_sms_wallet(uuid, integer) to authenticated, service_role;

commit;
