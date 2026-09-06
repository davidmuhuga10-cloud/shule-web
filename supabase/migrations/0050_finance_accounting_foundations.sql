-- ============================================================================
-- 0050_finance_accounting_foundations.sql
-- ----------------------------------------------------------------------------
-- Finance Expansion brief item 2 ("Accounting Module"). Vote Heads already
-- exist (see 0031) and only needed a dedicated screen, not a new table —
-- that's a frontend-only change (financeAccounting.mjs). What's genuinely
-- new here:
--   - finance_account_types: simple named categories ("School Fund" seeded
--     by default per school, a school can add more — e.g. "Activity Fund",
--     "Building Fund").
--   - finance_accounts: the actual bank/cash accounts, each tagged with an
--     account type. Deliberately simple (name, bank, account number,
--     branch, or a plain "Cash" account with is_cash=true) — no bank
--     reconciliation, no multi-currency, nothing enterprise.
--
-- Same RLS shape every other Finance table already uses (finance_vote_heads
-- is the template): read gated on finance_can_collect() (any finance user),
-- write/update/delete gated on finance_can_manage() (a bursar/admin with
-- the fuller grant) — copied exactly, not reinvented.
--
-- This is deliberately NOT a full double-entry ledger yet. Payroll (a
-- later phase) and Expenses (a later phase) will both need to post
-- transactions against these accounts — that shared ledger table is
-- intentionally left for whichever of those two phases is built first, so
-- its shape is driven by a real consumer instead of guessed at here.
-- ============================================================================

begin;

create table public.finance_account_types (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  name text not null,
  is_default boolean not null default false,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (school_id, name)
);
create trigger trg_finance_account_types_updated_at before update on public.finance_account_types
  for each row execute function public.set_updated_at();
create trigger trg_finance_account_types_school_id before insert on public.finance_account_types
  for each row execute function public.set_school_id();
create index idx_finance_account_types_school on public.finance_account_types(school_id);

alter table public.finance_account_types enable row level security;
create policy finance_account_types_read on public.finance_account_types for select
  using (school_id = public.current_school_id() and public.finance_can_collect());
create policy finance_account_types_write on public.finance_account_types for insert
  with check (public.finance_can_manage() and school_id = public.current_school_id());
create policy finance_account_types_update on public.finance_account_types for update
  using (public.finance_can_manage() and school_id = public.current_school_id());
create policy finance_account_types_delete on public.finance_account_types for delete
  using (public.finance_can_manage() and school_id = public.current_school_id());

create table public.finance_accounts (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  account_type_id uuid not null references public.finance_account_types(id) on delete restrict,
  name text not null,
  bank_name text,
  account_number text,
  branch text,
  is_cash boolean not null default false,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (school_id, name)
);
create trigger trg_finance_accounts_updated_at before update on public.finance_accounts
  for each row execute function public.set_updated_at();
create trigger trg_finance_accounts_school_id before insert on public.finance_accounts
  for each row execute function public.set_school_id();
create index idx_finance_accounts_school on public.finance_accounts(school_id);
create index idx_finance_accounts_type on public.finance_accounts(account_type_id);

alter table public.finance_accounts enable row level security;
create policy finance_accounts_read on public.finance_accounts for select
  using (school_id = public.current_school_id() and public.finance_can_collect());
create policy finance_accounts_write on public.finance_accounts for insert
  with check (public.finance_can_manage() and school_id = public.current_school_id());
create policy finance_accounts_update on public.finance_accounts for update
  using (public.finance_can_manage() and school_id = public.current_school_id());
create policy finance_accounts_delete on public.finance_accounts for delete
  using (public.finance_can_manage() and school_id = public.current_school_id());

-- Same idempotent seed pattern finance_bootstrap() already uses for
-- "Balance B/F"/"Transport" vote heads — additive to the existing
-- function body, same signature, so every existing caller (viewFinanceHub
-- calls this on every Finance visit) picks this up with no code change.
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
end;
$$;

commit;
