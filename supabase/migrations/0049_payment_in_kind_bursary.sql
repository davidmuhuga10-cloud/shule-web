-- ============================================================================
-- 0049_payment_in_kind_bursary.sql
-- ----------------------------------------------------------------------------
-- Finance Expansion brief item 1.3 ("Payment in Kind & Bursary"): two more
-- values for finance_collections.mode, alongside the existing cash/paybill/
-- bank/other — NOT a parallel payment system. A payment-in-kind collection
-- additionally records what was actually received (in_kind_description),
-- since there's no M-Pesa code or bank slip to put in `reference` for it. A
-- bursary collection reuses the existing `reference` column for the
-- sponsor/bursary source name — the exact same way `reference` already
-- holds an M-Pesa code for `paybill` and a bank name for `bank` — so this
-- needs no new column of its own.
--
-- Both the table's check constraint AND finance_record_collection()'s own
-- explicit mode check needed widening — the RPC validates independently of
-- the table constraint, not just relying on it.
-- ============================================================================

begin;

alter table public.finance_collections drop constraint finance_collections_mode_check;
alter table public.finance_collections add constraint finance_collections_mode_check
  check (mode in ('cash', 'paybill', 'bank', 'other', 'kind', 'bursary'));

alter table public.finance_collections add column in_kind_description text;

-- CREATE OR REPLACE cannot widen a function's own parameter list — adding
-- p_in_kind_description makes this a DIFFERENT signature (5 args -> 6), so
-- without an explicit drop first, Postgres would keep the OLD 5-arg
-- function around as a separate overload alongside the new one, silently
-- reachable by anything that ever calls it with exactly 5 named args (and
-- still carrying the OLD mode check, which would reject 'kind'/'bursary').
-- Drop it by its exact old signature before creating the new one.
drop function if exists public.finance_record_collection(uuid, numeric, text, text, text);

create function public.finance_record_collection(
  p_student_id uuid, p_amount numeric, p_mode text, p_reference text, p_notes text,
  p_in_kind_description text default null
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_school uuid := public.current_school_id();
  v_year_id uuid; v_term_id uuid;
  v_collection_id uuid;
  v_receipt_no text;
begin
  if not public.finance_can_collect() then raise exception 'Not authorized to record collections' using errcode = '42501'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'Amount must be greater than zero'; end if;
  if p_mode not in ('cash', 'paybill', 'bank', 'other', 'kind', 'bursary') then raise exception 'Invalid payment mode'; end if;
  if p_mode = 'kind' and coalesce(trim(p_in_kind_description), '') = '' then raise exception 'Describe what was received for a payment in kind'; end if;
  if not exists (select 1 from public.students where id = p_student_id and school_id = v_school) then raise exception 'Student not found'; end if;

  select id into v_year_id from public.academic_years where school_id = v_school and status = 'active' limit 1;
  select id into v_term_id from public.terms where school_id = v_school and status = 'active' limit 1;
  if v_year_id is null or v_term_id is null then raise exception 'No active academic year/term configured — set one in Settings first.'; end if;

  v_receipt_no := 'RCT-' || lpad(public.finance_next_no('receipt')::text, 6, '0');

  insert into public.finance_collections (school_id, student_id, academic_year_id, term_id, amount, mode, reference, receipt_no, notes, in_kind_description, created_by, updated_by)
    values (v_school, p_student_id, v_year_id, v_term_id, p_amount, p_mode, nullif(p_reference, ''), v_receipt_no, nullif(p_notes, ''),
            case when p_mode = 'kind' then nullif(p_in_kind_description, '') else null end, auth.uid(), auth.uid())
    returning id into v_collection_id;

  perform public.finance_allocate_collection(v_collection_id, p_student_id, p_amount);

  return jsonb_build_object('collection_id', v_collection_id, 'receipt_no', v_receipt_no);
end;
$$;

grant execute on function public.finance_record_collection(uuid, numeric, text, text, text, text) to authenticated;

commit;
