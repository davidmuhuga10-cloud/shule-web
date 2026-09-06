-- ============================================================================
-- 0057_finance_voucher_reversal.sql
-- ----------------------------------------------------------------------------
-- POST-BUILD FEEDBACK item 5: "Once paid, can the user actually download/
-- print a receipt? Can they reverse it, and does that reversal correctly
-- update the supplier's balance?" — today finance_record_expense_payment()
-- creates a Payment Voucher + ledger entry with NO way back: no status
-- column on finance_payment_vouchers at all, and no reversal RPC. This adds
-- both, following the exact same pattern already established for
-- collections (finance_reverse_collection) and payroll runs
-- (finance_payroll_reverse): never delete the original row, post an
-- OFFSETTING ledger entry (the ledger stays append-only — see
-- 0052's header comment), and mark the voucher itself reversed rather than
-- removing it, so "what changed" is always visible in the audit trail.
--
-- Reversing decrements the linked expense's paid_amount back down, which is
-- ALL finance_supplier_balances() needs (it's a live sum over
-- amount/paid_amount) — so the supplier's balance corrects itself
-- automatically, no separate bookkeeping required.
-- ============================================================================

begin;

alter table public.finance_payment_vouchers
  add column status text not null default 'active' check (status in ('active', 'reversed')),
  add column reversed_at timestamptz,
  add column reversed_by uuid references auth.users(id),
  add column reversal_reason text;

create function public.finance_reverse_payment_voucher(p_voucher_id uuid, p_reason text default null)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_school uuid := public.current_school_id();
  v_voucher public.finance_payment_vouchers%rowtype;
  v_expense public.finance_expenses%rowtype;
  v_new_paid numeric;
  v_new_status text;
begin
  if not public.finance_can_manage() then raise exception 'Not authorized to manage expenses' using errcode = '42501'; end if;

  select * into v_voucher from public.finance_payment_vouchers where id = p_voucher_id and school_id = v_school;
  if not found then raise exception 'Payment voucher not found'; end if;
  if v_voucher.status = 'reversed' then raise exception 'This payment voucher has already been reversed'; end if;

  select * into v_expense from public.finance_expenses where id = v_voucher.expense_id and school_id = v_school;
  if not found then raise exception 'Linked expense not found'; end if;

  -- Offsetting ledger entry — the money is going back OUT of the account it
  -- was recorded as paid FROM, i.e. reversing an 'out' with another 'out'
  -- reversal would be wrong; the correct entry is the reverse DIRECTION,
  -- same convention finance_reverse_collection already uses.
  insert into public.finance_ledger_entries (school_id, account_id, entry_date, direction, amount, reference_type, reference_id, description, created_by)
    values (v_school, v_voucher.account_id, current_date, 'in', v_voucher.amount, 'expense_payment_reversal', v_voucher.id,
            'Reversal of Payment Voucher ' || v_voucher.voucher_no || coalesce(' — ' || nullif(p_reason, ''), ''), auth.uid());

  -- A voucher against an already-voided expense (payroll-reversal edge case)
  -- shouldn't happen in practice — finance_record_expense_payment() has
  -- rejected paying a voided expense since 0055 — but if it's ever hit,
  -- leave the expense's own status alone rather than resurrecting it as
  -- payable again.
  if v_expense.status <> 'void' then
    v_new_paid := greatest(0, v_expense.paid_amount - v_voucher.amount);
    v_new_status := case when v_new_paid <= 0 then 'unpaid' when v_new_paid < v_expense.amount then 'partial' else 'paid' end;
    update public.finance_expenses set paid_amount = v_new_paid, status = v_new_status, updated_at = now(), updated_by = auth.uid()
      where id = v_expense.id;
  end if;

  update public.finance_payment_vouchers
    set status = 'reversed', reversed_at = now(), reversed_by = auth.uid(), reversal_reason = nullif(p_reason, '')
    where id = p_voucher_id;

  return jsonb_build_object('ok', true);
end;
$$;
grant execute on function public.finance_reverse_payment_voucher(uuid, text) to authenticated;

commit;
