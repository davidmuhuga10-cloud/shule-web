-- ============================================================================
-- 0052_finance_expenses.sql
-- ----------------------------------------------------------------------------
-- Finance Expansion brief item 7 ("Expenses Module") — Suppliers, LPOs,
-- Supplier Invoices/Expenses, and Payment Vouchers, plus the shared ledger
-- migration 0050 deliberately left open for whichever of Expenses/Payroll
-- got built first (this one). Flow per the brief's own diagram:
--   Supplier -> LPO (optional) -> Expense/Invoice -> Payment Voucher -> Ledger
-- Deliberately simple throughout, per the brief's own repeated framing:
--   - LPOs carry one plain amount, not priced line items ("Keep the LPO
--     simple. There is no need for a complicated [system]" — brief §7.2).
--   - An expense's "account/votehead" IS an existing finance_vote_head —
--     no new category table (brief §7.5/§7.8: "reuse... do not create
--     duplicate account... structures").
--   - Suppliers are reused as-is by Inventory (Phase 9) later — one table,
--     not one per module (brief §4.9/§7.1).
--
-- finance_ledger_entries is the shared, append-only general ledger this
-- and Payroll both post into: one row per actual movement of money in/out
-- of a finance_accounts row. It is intentionally NOT full double-entry
-- (no matching debit/credit pair per row) — just enough to answer "what
-- moved through this account and why," which is all either module's
-- reporting needs. No update/delete policy is created for it at all, so
-- once a row lands it cannot be edited or removed by anyone — corrections
-- happen by posting an offsetting entry, same "no silent edits to money"
-- rule Finance already applies to collections (reversals) and notes.
--
-- All five new tables are manage-only (finance_can_manage()), not just
-- collect-only — an expenses/payables/payroll ledger is bursar/admin
-- territory in a small school, not something a collections-only clerk
-- needs to see, unlike vote heads/accounts which every finance user reads.
-- ============================================================================

begin;

create table public.finance_suppliers (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  name text not null,
  contact_person text,
  phone text,
  email text,
  address text,
  category text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (school_id, name)
);
create trigger trg_finance_suppliers_updated_at before update on public.finance_suppliers
  for each row execute function public.set_updated_at();
create trigger trg_finance_suppliers_school_id before insert on public.finance_suppliers
  for each row execute function public.set_school_id();
create index idx_finance_suppliers_school on public.finance_suppliers(school_id);

alter table public.finance_suppliers enable row level security;
create policy finance_suppliers_read on public.finance_suppliers for select
  using (school_id = public.current_school_id() and public.finance_can_manage());
create policy finance_suppliers_write on public.finance_suppliers for insert
  with check (public.finance_can_manage() and school_id = public.current_school_id());
create policy finance_suppliers_update on public.finance_suppliers for update
  using (public.finance_can_manage() and school_id = public.current_school_id());
create policy finance_suppliers_delete on public.finance_suppliers for delete
  using (public.finance_can_manage() and school_id = public.current_school_id());

create table public.finance_lpos (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  lpo_no text not null,
  supplier_id uuid not null references public.finance_suppliers(id) on delete restrict,
  issued_date date not null default current_date,
  description text,
  amount numeric not null default 0 check (amount >= 0),
  status text not null default 'pending' check (status in ('pending', 'fulfilled', 'cancelled')),
  created_by uuid references auth.users(id),
  updated_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (school_id, lpo_no)
);
create trigger trg_finance_lpos_updated_at before update on public.finance_lpos
  for each row execute function public.set_updated_at();
create trigger trg_finance_lpos_school_id before insert on public.finance_lpos
  for each row execute function public.set_school_id();
create index idx_finance_lpos_school on public.finance_lpos(school_id);
create index idx_finance_lpos_supplier on public.finance_lpos(supplier_id);

alter table public.finance_lpos enable row level security;
create policy finance_lpos_read on public.finance_lpos for select
  using (school_id = public.current_school_id() and public.finance_can_manage());
create policy finance_lpos_write on public.finance_lpos for insert
  with check (public.finance_can_manage() and school_id = public.current_school_id());
create policy finance_lpos_update on public.finance_lpos for update
  using (public.finance_can_manage() and school_id = public.current_school_id());

create table public.finance_expenses (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  expense_no text not null,
  supplier_id uuid references public.finance_suppliers(id) on delete restrict,
  lpo_id uuid references public.finance_lpos(id) on delete set null,
  vote_head_id uuid not null references public.finance_vote_heads(id) on delete restrict,
  expense_date date not null default current_date,
  description text,
  amount numeric not null check (amount > 0),
  paid_amount numeric not null default 0 check (paid_amount >= 0),
  status text not null default 'unpaid' check (status in ('unpaid', 'partial', 'paid')),
  created_by uuid references auth.users(id),
  updated_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (school_id, expense_no)
);
create trigger trg_finance_expenses_updated_at before update on public.finance_expenses
  for each row execute function public.set_updated_at();
create trigger trg_finance_expenses_school_id before insert on public.finance_expenses
  for each row execute function public.set_school_id();
create index idx_finance_expenses_school on public.finance_expenses(school_id);
create index idx_finance_expenses_supplier on public.finance_expenses(supplier_id);
create index idx_finance_expenses_votehead on public.finance_expenses(vote_head_id);

alter table public.finance_expenses enable row level security;
create policy finance_expenses_read on public.finance_expenses for select
  using (school_id = public.current_school_id() and public.finance_can_manage());
create policy finance_expenses_write on public.finance_expenses for insert
  with check (public.finance_can_manage() and school_id = public.current_school_id());
create policy finance_expenses_update on public.finance_expenses for update
  using (public.finance_can_manage() and school_id = public.current_school_id());

create table public.finance_payment_vouchers (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  voucher_no text not null,
  expense_id uuid not null references public.finance_expenses(id) on delete restrict,
  account_id uuid not null references public.finance_accounts(id) on delete restrict,
  payment_date date not null default current_date,
  amount numeric not null check (amount > 0),
  payment_method text not null default 'bank' check (payment_method in ('cash', 'bank', 'paybill', 'other')),
  notes text,
  created_by uuid references auth.users(id),
  updated_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (school_id, voucher_no)
);
create trigger trg_finance_payment_vouchers_school_id before insert on public.finance_payment_vouchers
  for each row execute function public.set_school_id();
create index idx_finance_payment_vouchers_school on public.finance_payment_vouchers(school_id);
create index idx_finance_payment_vouchers_expense on public.finance_payment_vouchers(expense_id);

alter table public.finance_payment_vouchers enable row level security;
create policy finance_payment_vouchers_read on public.finance_payment_vouchers for select
  using (school_id = public.current_school_id() and public.finance_can_manage());
create policy finance_payment_vouchers_write on public.finance_payment_vouchers for insert
  with check (public.finance_can_manage() and school_id = public.current_school_id());
-- Deliberately no update/delete policy — a payment voucher, once created,
-- is a financial record like a receipt; "no silent edits to money."

create table public.finance_ledger_entries (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  account_id uuid not null references public.finance_accounts(id) on delete restrict,
  entry_date date not null default current_date,
  direction text not null check (direction in ('in', 'out')),
  amount numeric not null check (amount > 0),
  reference_type text,
  reference_id uuid,
  description text,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);
create trigger trg_finance_ledger_entries_school_id before insert on public.finance_ledger_entries
  for each row execute function public.set_school_id();
create index idx_finance_ledger_entries_school on public.finance_ledger_entries(school_id);
create index idx_finance_ledger_entries_account on public.finance_ledger_entries(account_id);

alter table public.finance_ledger_entries enable row level security;
create policy finance_ledger_entries_read on public.finance_ledger_entries for select
  using (school_id = public.current_school_id() and public.finance_can_manage());
create policy finance_ledger_entries_write on public.finance_ledger_entries for insert
  with check (public.finance_can_manage() and school_id = public.current_school_id());
-- No update/delete policy at all — append-only.

-- ---------------------------------------------------------------------------
-- finance_record_lpo — brief §7.2. Amount is entered directly (see header
-- comment on why there's no priced line-item table).
-- ---------------------------------------------------------------------------
create function public.finance_record_lpo(
  p_supplier_id uuid, p_description text, p_amount numeric, p_issued_date date default current_date
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_school uuid := public.current_school_id();
  v_lpo_id uuid;
  v_lpo_no text;
begin
  if not public.finance_can_manage() then raise exception 'Not authorized to manage expenses' using errcode = '42501'; end if;
  if p_amount is null or p_amount < 0 then raise exception 'Amount cannot be negative'; end if;
  if not exists (select 1 from public.finance_suppliers where id = p_supplier_id and school_id = v_school) then
    raise exception 'Supplier not found';
  end if;

  v_lpo_no := 'LPO-' || lpad(public.finance_next_no('lpo')::text, 6, '0');
  insert into public.finance_lpos (school_id, lpo_no, supplier_id, issued_date, description, amount, created_by, updated_by)
    values (v_school, v_lpo_no, p_supplier_id, coalesce(p_issued_date, current_date), nullif(p_description, ''), p_amount, auth.uid(), auth.uid())
    returning id into v_lpo_id;

  return jsonb_build_object('lpo_id', v_lpo_id, 'lpo_no', v_lpo_no);
end;
$$;
grant execute on function public.finance_record_lpo(uuid, text, numeric, date) to authenticated;

-- ---------------------------------------------------------------------------
-- finance_record_expense — brief §7.3. Marks its LPO 'fulfilled' when one
-- is referenced (brief §7.6's flow diagram treats the LPO as closed once
-- the invoice/expense against it is recorded).
-- ---------------------------------------------------------------------------
create function public.finance_record_expense(
  p_vote_head_id uuid, p_amount numeric, p_description text default null,
  p_supplier_id uuid default null, p_lpo_id uuid default null, p_expense_date date default current_date
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_school uuid := public.current_school_id();
  v_expense_id uuid;
  v_expense_no text;
begin
  if not public.finance_can_manage() then raise exception 'Not authorized to manage expenses' using errcode = '42501'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'Amount must be greater than zero'; end if;
  if not exists (select 1 from public.finance_vote_heads where id = p_vote_head_id and school_id = v_school) then
    raise exception 'Expense account/votehead not found';
  end if;
  if p_supplier_id is not null and not exists (select 1 from public.finance_suppliers where id = p_supplier_id and school_id = v_school) then
    raise exception 'Supplier not found';
  end if;
  if p_lpo_id is not null and not exists (select 1 from public.finance_lpos where id = p_lpo_id and school_id = v_school) then
    raise exception 'LPO not found';
  end if;

  v_expense_no := 'EXP-' || lpad(public.finance_next_no('expense')::text, 6, '0');
  insert into public.finance_expenses (school_id, expense_no, supplier_id, lpo_id, vote_head_id, expense_date, description, amount, created_by, updated_by)
    values (v_school, v_expense_no, p_supplier_id, p_lpo_id, p_vote_head_id, coalesce(p_expense_date, current_date), nullif(p_description, ''), p_amount, auth.uid(), auth.uid())
    returning id into v_expense_id;

  if p_lpo_id is not null then
    update public.finance_lpos set status = 'fulfilled', updated_at = now(), updated_by = auth.uid()
      where id = p_lpo_id and school_id = v_school and status = 'pending';
  end if;

  return jsonb_build_object('expense_id', v_expense_id, 'expense_no', v_expense_no);
end;
$$;
grant execute on function public.finance_record_expense(uuid, numeric, text, uuid, uuid, date) to authenticated;

-- ---------------------------------------------------------------------------
-- finance_record_expense_payment — brief §7.4. Creates the voucher AND
-- posts the ledger entry AND updates the expense's paid/status in one
-- transaction, refusing to overpay past what's actually owed.
-- ---------------------------------------------------------------------------
create function public.finance_record_expense_payment(
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
grant execute on function public.finance_record_expense_payment(uuid, uuid, numeric, date, text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- finance_supplier_balances — brief §7.6.
-- ---------------------------------------------------------------------------
create function public.finance_supplier_balances()
returns table(supplier_id uuid, name text, invoiced numeric, paid numeric, balance numeric)
language plpgsql security definer set search_path = public
as $$
declare v_school uuid := public.current_school_id();
begin
  if not public.finance_can_manage() then raise exception 'Not authorized' using errcode = '42501'; end if;
  return query
    select s.id, s.name,
      coalesce(sum(e.amount), 0) as invoiced,
      coalesce(sum(e.paid_amount), 0) as paid,
      coalesce(sum(e.amount - e.paid_amount), 0) as balance
    from public.finance_suppliers s
    left join public.finance_expenses e on e.supplier_id = s.id
    where s.school_id = v_school
    group by s.id, s.name
    order by s.name;
end;
$$;
grant execute on function public.finance_supplier_balances() to authenticated;

commit;
