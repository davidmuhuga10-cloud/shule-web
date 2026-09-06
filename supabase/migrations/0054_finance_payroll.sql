-- ============================================================================
-- 0054_finance_payroll.sql
-- ----------------------------------------------------------------------------
-- Finance Expansion brief item 3 ("Payroll Module"). Reuses existing staff
-- records (brief §3.1: "Staff should not be created again") — a payroll
-- profile is a thin row alongside `staff`, not a duplicate employee list.
--
-- Finance integration (brief §3.4: "should not have to manually enter the
-- same salary expenses into the Finance System after processing payroll")
-- is done by REUSING Phase 7's Expenses module rather than inventing a
-- second posting mechanism: finalizing a payroll run creates exactly ONE
-- finance_expenses row (total net pay, under a "Salaries & Wages" vote
-- head) that then flows through the exact same Record Payment / Payment
-- Voucher / Ledger machinery every other expense already uses. This is
-- what the brief means by "use the existing chart of accounts and
-- financial transaction structure rather than creating a separate
-- accounting system" — there's nothing payroll-specific about how the
-- money actually gets recorded as paid.
--
-- Per-employee traceability lives in finance_payroll_items (gross/
-- deductions/net per person, per month) — the one finance_expenses row is
-- the accounting-side total, not a replacement for that detail.
--
-- Adjustments (bonuses, advances, loan repayments, unpaid-absence
-- deductions — brief §3.2) are stored as a small jsonb array per item
-- rather than a table each, since they only ever need to exist for the
-- lifetime of one month's payroll line, are never queried independently,
-- and the brief explicitly asks to keep this simple.
--
-- Brief §3.7: "once finalized, figures should not be changed silently...
-- a simple... reversal mechanism that maintains a clear record of the
-- change." Reversal is only allowed while nothing has actually been paid
-- yet (the linked expense's paid_amount is still 0) — once a shilling has
-- moved, that's Finance's own reversal territory (payment vouchers are
-- already immutable), not payroll's. Reversing voids the linked expense
-- (a new 'void' status, excluded from what's owed) and marks the run
-- 'reversed' — nothing is deleted, matching the reversal pattern already
-- used for collections/notes.
-- ============================================================================

begin;

-- 'void' brief-mandated addition for the reversal path above — every
-- other value is unchanged from 0052.
alter table public.finance_expenses drop constraint finance_expenses_status_check;
alter table public.finance_expenses add constraint finance_expenses_status_check
  check (status in ('unpaid', 'partial', 'paid', 'void'));

create table public.finance_payroll_profiles (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  staff_id uuid not null references public.staff(id) on delete restrict,
  position text,
  department text,
  basic_salary numeric not null default 0 check (basic_salary >= 0),
  regular_allowances numeric not null default 0 check (regular_allowances >= 0),
  regular_deductions numeric not null default 0 check (regular_deductions >= 0),
  payment_method text not null default 'bank' check (payment_method in ('bank', 'mpesa', 'cash')),
  bank_name text,
  account_number text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (school_id, staff_id)
);
create trigger trg_finance_payroll_profiles_updated_at before update on public.finance_payroll_profiles
  for each row execute function public.set_updated_at();
create trigger trg_finance_payroll_profiles_school_id before insert on public.finance_payroll_profiles
  for each row execute function public.set_school_id();
create index idx_finance_payroll_profiles_school on public.finance_payroll_profiles(school_id);

alter table public.finance_payroll_profiles enable row level security;
create policy finance_payroll_profiles_read on public.finance_payroll_profiles for select
  using (school_id = public.current_school_id() and public.finance_can_manage());
create policy finance_payroll_profiles_write on public.finance_payroll_profiles for insert
  with check (public.finance_can_manage() and school_id = public.current_school_id());
create policy finance_payroll_profiles_update on public.finance_payroll_profiles for update
  using (public.finance_can_manage() and school_id = public.current_school_id());

create table public.finance_payroll_runs (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  period_year int not null,
  period_month int not null check (period_month between 1 and 12),
  status text not null default 'draft' check (status in ('draft', 'finalized', 'reversed')),
  expense_id uuid references public.finance_expenses(id) on delete set null,
  finalized_at timestamptz,
  finalized_by uuid references auth.users(id),
  reversed_at timestamptz,
  reversed_by uuid references auth.users(id),
  reversal_reason text,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (school_id, period_year, period_month)
);
create trigger trg_finance_payroll_runs_updated_at before update on public.finance_payroll_runs
  for each row execute function public.set_updated_at();
create trigger trg_finance_payroll_runs_school_id before insert on public.finance_payroll_runs
  for each row execute function public.set_school_id();
create index idx_finance_payroll_runs_school on public.finance_payroll_runs(school_id);

alter table public.finance_payroll_runs enable row level security;
create policy finance_payroll_runs_read on public.finance_payroll_runs for select
  using (school_id = public.current_school_id() and public.finance_can_manage());
create policy finance_payroll_runs_write on public.finance_payroll_runs for insert
  with check (public.finance_can_manage() and school_id = public.current_school_id());
create policy finance_payroll_runs_update on public.finance_payroll_runs for update
  using (public.finance_can_manage() and school_id = public.current_school_id());

create table public.finance_payroll_items (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  payroll_run_id uuid not null references public.finance_payroll_runs(id) on delete cascade,
  staff_id uuid not null references public.staff(id) on delete restrict,
  position text,
  department text,
  basic_salary numeric not null default 0,
  regular_allowances numeric not null default 0,
  regular_deductions numeric not null default 0,
  adjustments jsonb not null default '[]'::jsonb,
  gross_pay numeric not null default 0,
  total_deductions numeric not null default 0,
  net_pay numeric not null default 0,
  payment_method text,
  bank_name text,
  account_number text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (payroll_run_id, staff_id)
);
create trigger trg_finance_payroll_items_updated_at before update on public.finance_payroll_items
  for each row execute function public.set_updated_at();
create trigger trg_finance_payroll_items_school_id before insert on public.finance_payroll_items
  for each row execute function public.set_school_id();
create index idx_finance_payroll_items_school on public.finance_payroll_items(school_id);
create index idx_finance_payroll_items_run on public.finance_payroll_items(payroll_run_id);
create index idx_finance_payroll_items_staff on public.finance_payroll_items(staff_id);

alter table public.finance_payroll_items enable row level security;
create policy finance_payroll_items_read on public.finance_payroll_items for select
  using (school_id = public.current_school_id() and public.finance_can_manage());
create policy finance_payroll_items_write on public.finance_payroll_items for insert
  with check (public.finance_can_manage() and school_id = public.current_school_id());
create policy finance_payroll_items_update on public.finance_payroll_items for update
  using (public.finance_can_manage() and school_id = public.current_school_id());

-- Same idempotent seed pattern as 0031/0050 — a "Salaries & Wages" vote
-- head so payroll's one posted expense per month always has somewhere to
-- go, without the clerk having to set it up manually first.
create or replace function public.finance_bootstrap()
returns void
language plpgsql security definer set search_path = public
as $$
declare v_school uuid := public.current_school_id();
begin
  if not public.finance_can_collect() then raise exception 'Not authorized' using errcode = '42501'; end if;
  insert into public.finance_vote_heads (school_id, name, code, priority, is_transport)
    select v_school, 'Balance B/F', 'BALANCE_BF', 1, false
    where not exists (select 1 from public.finance_vote_heads where school_id = v_school and code = 'BALANCE_BF');
  insert into public.finance_vote_heads (school_id, name, code, priority, is_transport)
    select v_school, 'Transport', 'TRANSPORT', 200, true
    where not exists (select 1 from public.finance_vote_heads where school_id = v_school and is_transport = true);
  insert into public.finance_account_types (school_id, name, is_default)
    select v_school, 'School Fund', true
    where not exists (select 1 from public.finance_account_types where school_id = v_school and is_default = true);
  insert into public.finance_vote_heads (school_id, name, code, priority, is_transport)
    select v_school, 'Salaries & Wages', 'SALARIES_WAGES', 300, false
    where not exists (select 1 from public.finance_vote_heads where school_id = v_school and code = 'SALARIES_WAGES');
end;
$$;

-- ---------------------------------------------------------------------------
-- finance_payroll_create_run — brief §3.2. Idempotent: re-clicking "Create
-- Payroll" for a month that's already a draft just returns it as-is rather
-- than duplicating; a finalized month can't be recreated (use reversal
-- first). Only staff with an ACTIVE payroll profile are pulled in — having
-- a staff record isn't enough on its own, since not every staff member is
-- necessarily paid through this module on day one.
-- ---------------------------------------------------------------------------
create function public.finance_payroll_create_run(p_period_year int, p_period_month int)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_school uuid := public.current_school_id();
  v_run_id uuid;
  v_status text;
  v_count int;
begin
  if not public.finance_can_manage() then raise exception 'Not authorized to manage payroll' using errcode = '42501'; end if;
  if p_period_month is null or p_period_month < 1 or p_period_month > 12 then raise exception 'Invalid month'; end if;

  select id, status into v_run_id, v_status from public.finance_payroll_runs
    where school_id = v_school and period_year = p_period_year and period_month = p_period_month;

  if v_run_id is not null then
    if v_status = 'finalized' then raise exception 'Payroll for this month is already finalized.'; end if;
    return jsonb_build_object('run_id', v_run_id, 'created', false);
  end if;

  insert into public.finance_payroll_runs (school_id, period_year, period_month, created_by)
    values (v_school, p_period_year, p_period_month, auth.uid())
    returning id into v_run_id;

  insert into public.finance_payroll_items (
    school_id, payroll_run_id, staff_id, position, department, basic_salary, regular_allowances, regular_deductions,
    gross_pay, total_deductions, net_pay, payment_method, bank_name, account_number
  )
  select v_school, v_run_id, p.staff_id, p.position, p.department, p.basic_salary, p.regular_allowances, p.regular_deductions,
    (p.basic_salary + p.regular_allowances), p.regular_deductions, (p.basic_salary + p.regular_allowances - p.regular_deductions),
    p.payment_method, p.bank_name, p.account_number
  from public.finance_payroll_profiles p
  where p.school_id = v_school and p.active = true;

  get diagnostics v_count = row_count;
  return jsonb_build_object('run_id', v_run_id, 'created', true, 'employee_count', v_count);
end;
$$;
grant execute on function public.finance_payroll_create_run(int, int) to authenticated;

-- ---------------------------------------------------------------------------
-- finance_payroll_update_item — brief §3.2's "one-off adjustments...
-- editable before the payroll is finalized." p_adjustments:
-- [{"label": text, "kind": "allowance"|"deduction", "amount": numeric}, ...]
-- ---------------------------------------------------------------------------
create function public.finance_payroll_update_item(p_item_id uuid, p_adjustments jsonb)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_school uuid := public.current_school_id();
  v_item public.finance_payroll_items%rowtype;
  v_run_status text;
  v_extra_allow numeric;
  v_extra_ded numeric;
  v_gross numeric;
  v_deductions numeric;
  v_net numeric;
begin
  if not public.finance_can_manage() then raise exception 'Not authorized to manage payroll' using errcode = '42501'; end if;

  select * into v_item from public.finance_payroll_items where id = p_item_id and school_id = v_school;
  if not found then raise exception 'Payroll item not found'; end if;

  select status into v_run_status from public.finance_payroll_runs where id = v_item.payroll_run_id;
  if v_run_status <> 'draft' then raise exception 'This payroll has already been finalized — reverse it first to make changes.'; end if;

  if jsonb_typeof(p_adjustments) <> 'array' then raise exception 'Adjustments must be a list'; end if;

  select coalesce(sum((e->>'amount')::numeric), 0) into v_extra_allow
    from jsonb_array_elements(p_adjustments) e where e->>'kind' = 'allowance';
  select coalesce(sum((e->>'amount')::numeric), 0) into v_extra_ded
    from jsonb_array_elements(p_adjustments) e where e->>'kind' = 'deduction';

  v_gross := v_item.basic_salary + v_item.regular_allowances + v_extra_allow;
  v_deductions := v_item.regular_deductions + v_extra_ded;
  v_net := v_gross - v_deductions;

  update public.finance_payroll_items
    set adjustments = p_adjustments, gross_pay = v_gross, total_deductions = v_deductions, net_pay = v_net, updated_at = now()
    where id = p_item_id;

  return jsonb_build_object('gross_pay', v_gross, 'total_deductions', v_deductions, 'net_pay', v_net);
end;
$$;
grant execute on function public.finance_payroll_update_item(uuid, jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- finance_payroll_finalize — brief §3.4. Posts ONE finance_expenses row
-- (total net pay) under the Salaries & Wages vote head — see header
-- comment for why one row, not one per employee.
-- ---------------------------------------------------------------------------
create function public.finance_payroll_finalize(p_run_id uuid)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_school uuid := public.current_school_id();
  v_run public.finance_payroll_runs%rowtype;
  v_total_net numeric;
  v_item_count int;
  v_vote_head_id uuid;
  v_expense_id uuid;
  v_expense_no text;
  v_month_label text;
begin
  if not public.finance_can_manage() then raise exception 'Not authorized to manage payroll' using errcode = '42501'; end if;

  select * into v_run from public.finance_payroll_runs where id = p_run_id and school_id = v_school;
  if not found then raise exception 'Payroll run not found'; end if;
  if v_run.status <> 'draft' then raise exception 'This payroll has already been finalized or reversed.'; end if;

  select coalesce(sum(net_pay), 0), count(*) into v_total_net, v_item_count
    from public.finance_payroll_items where payroll_run_id = p_run_id;
  if v_item_count = 0 then raise exception 'Nothing to finalize — this payroll has no employees. Add payroll profiles first.'; end if;
  if v_total_net <= 0 then raise exception 'Total net pay must be greater than zero.'; end if;

  select id into v_vote_head_id from public.finance_vote_heads where school_id = v_school and code = 'SALARIES_WAGES';
  if v_vote_head_id is null then
    insert into public.finance_vote_heads (school_id, name, code, priority, is_transport)
      values (v_school, 'Salaries & Wages', 'SALARIES_WAGES', 300, false) returning id into v_vote_head_id;
  end if;

  v_month_label := to_char(make_date(v_run.period_year, v_run.period_month, 1), 'Month YYYY');
  v_expense_no := 'EXP-' || lpad(public.finance_next_no('expense')::text, 6, '0');
  insert into public.finance_expenses (school_id, expense_no, vote_head_id, expense_date, description, amount, created_by, updated_by)
    values (v_school, v_expense_no, v_vote_head_id, make_date(v_run.period_year, v_run.period_month, 1),
            'Payroll — ' || trim(v_month_label) || ' (' || v_item_count || ' employee(s))', v_total_net, auth.uid(), auth.uid())
    returning id into v_expense_id;

  update public.finance_payroll_runs
    set status = 'finalized', expense_id = v_expense_id, finalized_at = now(), finalized_by = auth.uid(), updated_at = now()
    where id = p_run_id;

  return jsonb_build_object('expense_id', v_expense_id, 'expense_no', v_expense_no, 'total_net', v_total_net, 'employee_count', v_item_count);
end;
$$;
grant execute on function public.finance_payroll_finalize(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- finance_payroll_reverse — brief §3.7. Only while nothing's been paid yet.
-- ---------------------------------------------------------------------------
create function public.finance_payroll_reverse(p_run_id uuid, p_reason text)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_school uuid := public.current_school_id();
  v_run public.finance_payroll_runs%rowtype;
  v_paid numeric;
begin
  if not public.finance_can_manage() then raise exception 'Not authorized to manage payroll' using errcode = '42501'; end if;

  select * into v_run from public.finance_payroll_runs where id = p_run_id and school_id = v_school;
  if not found then raise exception 'Payroll run not found'; end if;
  if v_run.status <> 'finalized' then raise exception 'Only a finalized payroll can be reversed.'; end if;

  select paid_amount into v_paid from public.finance_expenses where id = v_run.expense_id;
  if coalesce(v_paid, 0) > 0 then
    raise exception 'This payroll''s expense already has a payment recorded against it — reversing would leave that payment unexplained. Correct it from Expenses instead.';
  end if;

  update public.finance_expenses set status = 'void', updated_at = now(), updated_by = auth.uid() where id = v_run.expense_id;
  update public.finance_payroll_runs
    set status = 'reversed', reversed_at = now(), reversed_by = auth.uid(), reversal_reason = nullif(p_reason, ''), updated_at = now()
    where id = p_run_id;

  return jsonb_build_object('run_id', p_run_id, 'reversed', true);
end;
$$;
grant execute on function public.finance_payroll_reverse(uuid, text) to authenticated;

commit;
