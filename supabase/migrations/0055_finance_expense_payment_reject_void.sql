-- ============================================================================
-- 0055_finance_expense_payment_reject_void.sql
-- ----------------------------------------------------------------------------
-- Defense in depth for the 'void' expense status 0054 introduced (a
-- reversed payroll voids its posted expense): the UI already hides the
-- "Record Payment" button for a voided expense, but the RPC itself had no
-- server-side guard against it — a direct call would have gone through
-- and silently resurrected a payable that was deliberately voided. Same
-- signature, so a plain CREATE OR REPLACE is safe here (no overload risk,
-- unlike adding/removing a parameter).
-- ============================================================================

begin;

create or replace function public.finance_record_expense_payment(
  p_expense_id uuid, p_account_id uuid, p_amount numeric,
  p_payment_date date default current_date, p_payment_method text default 'bank', p_notes text default null
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_school uuid := public.current_school_id();
  v_expense public.finance_expenses%rowtype;
  v_remaining numeric;
  v_voucher_id uuid;
  v_voucher_no text;
  v_new_paid numeric;
begin
  if not public.finance_can_manage() then raise exception 'Not authorized to manage expenses' using errcode = '42501'; end if;
  if p_payment_method not in ('cash', 'paybill', 'bank', 'other') then raise exception 'Invalid payment method'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'Amount must be greater than zero'; end if;

  select * into v_expense from public.finance_expenses where id = p_expense_id and school_id = v_school;
  if not found then raise exception 'Expense not found'; end if;
  if v_expense.status = 'void' then raise exception 'This expense has been voided and cannot be paid.'; end if;
  if not exists (select 1 from public.finance_accounts where id = p_account_id and school_id = v_school) then
    raise exception 'Account not found';
  end if;

  v_remaining := v_expense.amount - v_expense.paid_amount;
  if p_amount > v_remaining then
    raise exception 'Amount (KES %) exceeds the remaining balance owed (KES %)', p_amount, v_remaining;
  end if;

  v_voucher_no := 'PV-' || lpad(public.finance_next_no('voucher')::text, 6, '0');
  insert into public.finance_payment_vouchers (school_id, voucher_no, expense_id, account_id, payment_date, amount, payment_method, notes, created_by, updated_by)
    values (v_school, v_voucher_no, p_expense_id, p_account_id, coalesce(p_payment_date, current_date), p_amount, p_payment_method, nullif(p_notes, ''), auth.uid(), auth.uid())
    returning id into v_voucher_id;

  insert into public.finance_ledger_entries (school_id, account_id, entry_date, direction, amount, reference_type, reference_id, description, created_by)
    values (v_school, p_account_id, coalesce(p_payment_date, current_date), 'out', p_amount, 'expense_payment', v_voucher_id,
            'Payment Voucher ' || v_voucher_no || coalesce(' — ' || v_expense.description, ''), auth.uid());

  v_new_paid := v_expense.paid_amount + p_amount;
  update public.finance_expenses
    set paid_amount = v_new_paid,
        status = case when v_new_paid >= amount then 'paid' else 'partial' end,
        updated_at = now(), updated_by = auth.uid()
    where id = p_expense_id;

  return jsonb_build_object('voucher_id', v_voucher_id, 'voucher_no', v_voucher_no);
end;
$$;

commit;
