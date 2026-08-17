-- ============================================================================
-- FINANCE MODULE (Finance_Module_Brief.docx) — fees, invoicing, collections,
-- transport billing, and basic bookkeeping reports. Deliberately scoped down
-- from the brief's own reference point (Zeraki Finance) per its explicit
-- instruction: "keep the build simple and useful over comprehensive and
-- complex" and "optimize for low infrastructure/server cost and reliability".
--
-- Design notes (read before touching this block):
--   - One invoice per (student, academic_year, term) — every charge for that
--     term (fee-structure items, transport, ad-hoc debit notes) is a line on
--     that ONE invoice, not a separate document per charge. This is what lets
--     brief scenario #4 ("correct a wrong transport line on her EXISTING
--     invoice") be a plain update to one invoice_items row (done via
--     finance_assign_route() below, which keeps the route assignment and the
--     invoice line in lockstep so they can never drift apart).
--   - Vote heads carry a `priority` (lower clears first) — brief scenario #6
--     ("change the configured priority so fees are cleared before transport
--     instead") is just re-numbering these; finance_allocate_collection()
--     below reads them in that order every time a payment is recorded.
--   - A payment that exceeds everything owed doesn't error or vanish — the
--     leftover becomes a `vote_head_id is null` allocation row, which every
--     balance query below treats as a credit (reduces the total balance) —
--     the brief's explicit overpayment requirement.
--   - Reverse/Transfer never delete a collection row — Reverse flips its
--     status (every balance query only sums status='active' rows, so a
--     reversed payment stops counting immediately) and Transfer creates a
--     NEW collection for the correct student while flipping the original to
--     status='transferred', linked both ways — full history stays intact for
--     the audit-trail scenario (#14) and for reprinting an old receipt
--     exactly as issued (#15).
--   - created_by/updated_by everywhere money moves — profiles.id (not
--     staff_id), so it reads as a name via a simple join, same convention as
--     every other "who did this" field in this codebase.
--   - Two capabilities gate everything (see has_capability() further up in
--     this file): 'finance_manage_fees' (vote heads, fee structures,
--     invoicing, routes, debit/credit notes) and
--     'finance_record_collections' (record/reverse/transfer collections,
--     view balances/statements/reports) — an admin always has both. Brief
--     scenario #20 ("grant a bursar collections + statements only, not fee
--     structures/notes") is exactly one capability grant, nothing more.
--   - "Balance B/F" and "Transport" are ordinary finance_vote_heads rows,
--     lazily created (finance_bootstrap(), idempotent) the first time a
--     school opens the Finance module — not hardcoded specials — so a school
--     can rename or re-prioritize either one exactly like any other vote
--     head.
-- ============================================================================

alter table public.staff_capabilities drop constraint staff_capabilities_capability_check;
alter table public.staff_capabilities add constraint staff_capabilities_capability_check
  check (capability in ('publish_results', 'finance_manage_fees', 'finance_record_collections'));

create or replace function public.finance_can_manage()
returns boolean language sql stable security definer set search_path = public
as $$ select public.has_capability('finance_manage_fees') $$;

create or replace function public.finance_can_collect()
returns boolean language sql stable security definer set search_path = public
as $$ select public.has_capability('finance_manage_fees') or public.has_capability('finance_record_collections') $$;

grant execute on function public.finance_can_manage() to authenticated;
grant execute on function public.finance_can_collect() to authenticated;

-- ----------------------------------------------------------------------------
-- finance_vote_heads — the chart of "what fees are for" (Tuition, Transport,
-- Activity, Lunch, Balance B/F, ...). `priority` controls clearing order
-- when a payment is recorded (brief scenario #6); `is_transport` flags the
-- ONE vote head finance_assign_route() below charges transport against.
-- ----------------------------------------------------------------------------
create table public.finance_vote_heads (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  name text not null,
  code text,
  priority int not null default 100,
  is_transport boolean not null default false,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (school_id, name)
);
create trigger trg_finance_vote_heads_updated_at before update on public.finance_vote_heads
  for each row execute function public.set_updated_at();
create trigger trg_finance_vote_heads_school_id before insert on public.finance_vote_heads
  for each row execute function public.set_school_id();
create index idx_finance_vote_heads_school on public.finance_vote_heads(school_id);

-- ----------------------------------------------------------------------------
-- finance_routes / finance_student_routes — transport as its own vote head
-- (brief §Transport). Defined before finance_invoices below since invoice
-- line items reference a route directly.
-- ----------------------------------------------------------------------------
create table public.finance_routes (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  name text not null,
  pickup_point text,
  one_way_amount numeric not null default 0 check (one_way_amount >= 0),
  two_way_amount numeric not null default 0 check (two_way_amount >= 0),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (school_id, name)
);
create trigger trg_finance_routes_updated_at before update on public.finance_routes
  for each row execute function public.set_updated_at();
create trigger trg_finance_routes_school_id before insert on public.finance_routes
  for each row execute function public.set_school_id();
create index idx_finance_routes_school on public.finance_routes(school_id);

create table public.finance_student_routes (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  student_id uuid not null references public.students(id) on delete cascade,
  route_id uuid not null references public.finance_routes(id) on delete restrict,
  direction text not null check (direction in ('one_way', 'two_way')),
  academic_year_id uuid not null references public.academic_years(id) on delete cascade,
  term_id uuid not null references public.terms(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (student_id, academic_year_id, term_id)
);
create trigger trg_finance_student_routes_updated_at before update on public.finance_student_routes
  for each row execute function public.set_updated_at();
create trigger trg_finance_student_routes_school_id before insert on public.finance_student_routes
  for each row execute function public.set_school_id();
create index idx_finance_student_routes_school on public.finance_student_routes(school_id);
create index idx_finance_student_routes_student on public.finance_student_routes(student_id);

-- ----------------------------------------------------------------------------
-- finance_fee_structures — set up per (academic_year, term), tagged to one
-- or more classes (finance_fee_structure_classes) so a school can invoice
-- Grade 1/2 now and set up other grades' different amounts later (brief
-- scenario #5), each carrying a flat amount per vote head
-- (finance_fee_structure_items) applied uniformly to every targeted class.
-- ----------------------------------------------------------------------------
create table public.finance_fee_structures (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  academic_year_id uuid not null references public.academic_years(id) on delete cascade,
  term_id uuid not null references public.terms(id) on delete cascade,
  name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references public.profiles(id) on delete set null
);
create trigger trg_finance_fee_structures_updated_at before update on public.finance_fee_structures
  for each row execute function public.set_updated_at();
create trigger trg_finance_fee_structures_school_id before insert on public.finance_fee_structures
  for each row execute function public.set_school_id();
create index idx_finance_fee_structures_school on public.finance_fee_structures(school_id);
create index idx_finance_fee_structures_term on public.finance_fee_structures(academic_year_id, term_id);

create table public.finance_fee_structure_classes (
  id uuid primary key default gen_random_uuid(),
  fee_structure_id uuid not null references public.finance_fee_structures(id) on delete cascade,
  class_id uuid not null references public.classes(id) on delete cascade,
  unique (fee_structure_id, class_id)
);
create index idx_finance_fsc_structure on public.finance_fee_structure_classes(fee_structure_id);
create index idx_finance_fsc_class on public.finance_fee_structure_classes(class_id);

create table public.finance_fee_structure_items (
  id uuid primary key default gen_random_uuid(),
  fee_structure_id uuid not null references public.finance_fee_structures(id) on delete cascade,
  vote_head_id uuid not null references public.finance_vote_heads(id) on delete cascade,
  amount numeric not null check (amount >= 0),
  unique (fee_structure_id, vote_head_id)
);
create index idx_finance_fsi_structure on public.finance_fee_structure_items(fee_structure_id);

-- ----------------------------------------------------------------------------
-- finance_invoices / finance_invoice_items — ONE invoice per student per
-- term (see header note), line items broken down by vote head. Transport
-- lines additionally carry route_id/direction so finance_assign_route()
-- (below) can correct them in place (brief scenario #4).
-- ----------------------------------------------------------------------------
create table public.finance_invoices (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  student_id uuid not null references public.students(id) on delete cascade,
  academic_year_id uuid not null references public.academic_years(id) on delete cascade,
  term_id uuid not null references public.terms(id) on delete cascade,
  invoice_no text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references public.profiles(id) on delete set null,
  updated_by uuid references public.profiles(id) on delete set null,
  unique (school_id, student_id, academic_year_id, term_id),
  unique (school_id, invoice_no)
);
create trigger trg_finance_invoices_updated_at before update on public.finance_invoices
  for each row execute function public.set_updated_at();
create trigger trg_finance_invoices_school_id before insert on public.finance_invoices
  for each row execute function public.set_school_id();
create index idx_finance_invoices_school on public.finance_invoices(school_id);
create index idx_finance_invoices_student on public.finance_invoices(student_id);
create index idx_finance_invoices_term on public.finance_invoices(academic_year_id, term_id);

create table public.finance_invoice_items (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references public.finance_invoices(id) on delete cascade,
  vote_head_id uuid not null references public.finance_vote_heads(id) on delete restrict,
  fee_structure_id uuid references public.finance_fee_structures(id) on delete set null,
  amount numeric not null check (amount >= 0),
  description text,
  route_id uuid references public.finance_routes(id) on delete set null,
  direction text check (direction is null or direction in ('one_way', 'two_way')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger trg_finance_invoice_items_updated_at before update on public.finance_invoice_items
  for each row execute function public.set_updated_at();
create index idx_finance_invoice_items_invoice on public.finance_invoice_items(invoice_id);
create index idx_finance_invoice_items_vote_head on public.finance_invoice_items(vote_head_id);

-- ----------------------------------------------------------------------------
-- finance_debit_notes / finance_credit_notes — brief §Invoicing: increase or
-- reduce a STUDENT'S OWN fees without touching the shared fee structure
-- (scenario #17's sibling discount must not affect the rest of the class).
-- Tracked as their own ledger, not folded into invoice_items, because the
-- Balances report explicitly wants a separate "credit note" column (brief
-- §Reports).
-- ----------------------------------------------------------------------------
create table public.finance_debit_notes (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  student_id uuid not null references public.students(id) on delete cascade,
  academic_year_id uuid not null references public.academic_years(id) on delete cascade,
  term_id uuid not null references public.terms(id) on delete cascade,
  vote_head_id uuid not null references public.finance_vote_heads(id) on delete restrict,
  amount numeric not null check (amount > 0),
  reason text,
  created_at timestamptz not null default now(),
  created_by uuid references public.profiles(id) on delete set null
);
create trigger trg_finance_debit_notes_school_id before insert on public.finance_debit_notes
  for each row execute function public.set_school_id();
create index idx_finance_debit_notes_student on public.finance_debit_notes(student_id);
create index idx_finance_debit_notes_term on public.finance_debit_notes(academic_year_id, term_id);

create table public.finance_credit_notes (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  student_id uuid not null references public.students(id) on delete cascade,
  academic_year_id uuid not null references public.academic_years(id) on delete cascade,
  term_id uuid not null references public.terms(id) on delete cascade,
  vote_head_id uuid not null references public.finance_vote_heads(id) on delete restrict,
  amount numeric not null check (amount > 0),
  reason text,
  created_at timestamptz not null default now(),
  created_by uuid references public.profiles(id) on delete set null
);
create trigger trg_finance_credit_notes_school_id before insert on public.finance_credit_notes
  for each row execute function public.set_school_id();
create index idx_finance_credit_notes_student on public.finance_credit_notes(student_id);
create index idx_finance_credit_notes_term on public.finance_credit_notes(academic_year_id, term_id);

-- ----------------------------------------------------------------------------
-- finance_opening_balances — arrears a student already carried BEFORE this
-- system tracked them (brief scenario #9: bulk-uploaded for a newly set-up
-- class) or carried forward automatically from the previous academic year's
-- closing balance (scenario #12, via finance_carry_forward_balances()
-- below). One row per (student, academic_year) — a re-upload/re-run
-- overwrites it, so there's one source of truth per year, not an
-- accumulating history.
-- ----------------------------------------------------------------------------
create table public.finance_opening_balances (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  student_id uuid not null references public.students(id) on delete cascade,
  academic_year_id uuid not null references public.academic_years(id) on delete cascade,
  amount numeric not null default 0,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references public.profiles(id) on delete set null,
  unique (student_id, academic_year_id)
);
create trigger trg_finance_opening_balances_updated_at before update on public.finance_opening_balances
  for each row execute function public.set_updated_at();
create trigger trg_finance_opening_balances_school_id before insert on public.finance_opening_balances
  for each row execute function public.set_school_id();
create index idx_finance_opening_balances_school on public.finance_opening_balances(school_id);
create index idx_finance_opening_balances_year on public.finance_opening_balances(academic_year_id);

-- ----------------------------------------------------------------------------
-- finance_counters — atomic per-school receipt/invoice numbering. A plain
-- "select max(...)+1" races under concurrent bursars; the upsert below plus
-- ON CONFLICT DO UPDATE serializes just the number assignment.
-- ----------------------------------------------------------------------------
create table public.finance_counters (
  school_id uuid not null references public.schools(id) on delete cascade,
  kind text not null check (kind in ('receipt', 'invoice')),
  next_no int not null default 1,
  primary key (school_id, kind)
);

-- ----------------------------------------------------------------------------
-- finance_collections / finance_collection_allocations — where money is
-- actually recorded (brief §Collections). See header note for how
-- Reverse/Transfer work.
-- ----------------------------------------------------------------------------
create table public.finance_collections (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  student_id uuid not null references public.students(id) on delete cascade,
  academic_year_id uuid not null references public.academic_years(id) on delete cascade,
  term_id uuid not null references public.terms(id) on delete cascade,
  amount numeric not null check (amount > 0),
  mode text not null check (mode in ('cash', 'paybill', 'bank', 'other')),
  reference text,
  receipt_no text not null,
  status text not null default 'active' check (status in ('active', 'reversed', 'transferred')),
  notes text,
  reversed_reason text,
  reversed_at timestamptz,
  reversed_by uuid references public.profiles(id) on delete set null,
  transferred_from_collection_id uuid references public.finance_collections(id) on delete set null,
  transferred_to_collection_id uuid references public.finance_collections(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references public.profiles(id) on delete set null,
  updated_by uuid references public.profiles(id) on delete set null,
  unique (school_id, receipt_no)
);
create trigger trg_finance_collections_updated_at before update on public.finance_collections
  for each row execute function public.set_updated_at();
create trigger trg_finance_collections_school_id before insert on public.finance_collections
  for each row execute function public.set_school_id();
create index idx_finance_collections_school on public.finance_collections(school_id);
create index idx_finance_collections_student on public.finance_collections(student_id, status);
create index idx_finance_collections_term on public.finance_collections(academic_year_id, term_id, status);

create table public.finance_collection_allocations (
  id uuid primary key default gen_random_uuid(),
  collection_id uuid not null references public.finance_collections(id) on delete cascade,
  -- null vote_head_id = the overpayment/credit portion of this collection
  -- (brief: "the excess should carry forward as a credit balance ... not
  -- just sit as an error or get lost").
  vote_head_id uuid references public.finance_vote_heads(id) on delete set null,
  amount numeric not null check (amount > 0)
);
create index idx_finance_collection_allocations_collection on public.finance_collection_allocations(collection_id);
create index idx_finance_collection_allocations_vote_head on public.finance_collection_allocations(vote_head_id);

-- ============================================================================
-- RLS
-- ============================================================================
alter table public.finance_vote_heads enable row level security;
alter table public.finance_routes enable row level security;
alter table public.finance_student_routes enable row level security;
alter table public.finance_fee_structures enable row level security;
alter table public.finance_fee_structure_classes enable row level security;
alter table public.finance_fee_structure_items enable row level security;
alter table public.finance_invoices enable row level security;
alter table public.finance_invoice_items enable row level security;
alter table public.finance_debit_notes enable row level security;
alter table public.finance_credit_notes enable row level security;
alter table public.finance_opening_balances enable row level security;
alter table public.finance_collections enable row level security;
alter table public.finance_collection_allocations enable row level security;

create policy finance_vote_heads_read on public.finance_vote_heads for select
  using (school_id = public.current_school_id() and public.finance_can_collect());
create policy finance_vote_heads_write on public.finance_vote_heads for insert
  with check (public.finance_can_manage() and school_id = public.current_school_id());
create policy finance_vote_heads_update on public.finance_vote_heads for update
  using (public.finance_can_manage() and school_id = public.current_school_id());
create policy finance_vote_heads_delete on public.finance_vote_heads for delete
  using (public.finance_can_manage() and school_id = public.current_school_id());

create policy finance_routes_read on public.finance_routes for select
  using (school_id = public.current_school_id() and public.finance_can_collect());
create policy finance_routes_write on public.finance_routes for insert
  with check (public.finance_can_manage() and school_id = public.current_school_id());
create policy finance_routes_update on public.finance_routes for update
  using (public.finance_can_manage() and school_id = public.current_school_id());
create policy finance_routes_delete on public.finance_routes for delete
  using (public.finance_can_manage() and school_id = public.current_school_id());

-- finance_student_routes has no insert/update policy — every write goes
-- through finance_assign_route() below (security definer), which keeps the
-- assignment and its matching invoice line in lockstep.
create policy finance_student_routes_read on public.finance_student_routes for select
  using (school_id = public.current_school_id() and public.finance_can_collect());

create policy finance_fee_structures_read on public.finance_fee_structures for select
  using (school_id = public.current_school_id() and public.finance_can_collect());
create policy finance_fee_structures_write on public.finance_fee_structures for insert
  with check (public.finance_can_manage() and school_id = public.current_school_id());
create policy finance_fee_structures_update on public.finance_fee_structures for update
  using (public.finance_can_manage() and school_id = public.current_school_id());
create policy finance_fee_structures_delete on public.finance_fee_structures for delete
  using (public.finance_can_manage() and school_id = public.current_school_id());

create policy finance_fsc_read on public.finance_fee_structure_classes for select
  using (exists (select 1 from public.finance_fee_structures fs where fs.id = fee_structure_id and fs.school_id = public.current_school_id()) and public.finance_can_collect());
create policy finance_fsc_write on public.finance_fee_structure_classes for insert
  with check (public.finance_can_manage() and exists (select 1 from public.finance_fee_structures fs where fs.id = fee_structure_id and fs.school_id = public.current_school_id()));
create policy finance_fsc_delete on public.finance_fee_structure_classes for delete
  using (public.finance_can_manage() and exists (select 1 from public.finance_fee_structures fs where fs.id = fee_structure_id and fs.school_id = public.current_school_id()));

create policy finance_fsi_read on public.finance_fee_structure_items for select
  using (exists (select 1 from public.finance_fee_structures fs where fs.id = fee_structure_id and fs.school_id = public.current_school_id()) and public.finance_can_collect());
create policy finance_fsi_write on public.finance_fee_structure_items for insert
  with check (public.finance_can_manage() and exists (select 1 from public.finance_fee_structures fs where fs.id = fee_structure_id and fs.school_id = public.current_school_id()));
create policy finance_fsi_update on public.finance_fee_structure_items for update
  using (public.finance_can_manage() and exists (select 1 from public.finance_fee_structures fs where fs.id = fee_structure_id and fs.school_id = public.current_school_id()));
create policy finance_fsi_delete on public.finance_fee_structure_items for delete
  using (public.finance_can_manage() and exists (select 1 from public.finance_fee_structures fs where fs.id = fee_structure_id and fs.school_id = public.current_school_id()));

create policy finance_invoices_read on public.finance_invoices for select
  using (school_id = public.current_school_id() and public.finance_can_collect());
create policy finance_invoices_write on public.finance_invoices for insert
  with check (public.finance_can_manage() and school_id = public.current_school_id());
create policy finance_invoices_update on public.finance_invoices for update
  using (public.finance_can_manage() and school_id = public.current_school_id());

create policy finance_invoice_items_read on public.finance_invoice_items for select
  using (exists (select 1 from public.finance_invoices i where i.id = invoice_id and i.school_id = public.current_school_id()) and public.finance_can_collect());
create policy finance_invoice_items_write on public.finance_invoice_items for insert
  with check (public.finance_can_manage() and exists (select 1 from public.finance_invoices i where i.id = invoice_id and i.school_id = public.current_school_id()));
create policy finance_invoice_items_update on public.finance_invoice_items for update
  using (public.finance_can_manage() and exists (select 1 from public.finance_invoices i where i.id = invoice_id and i.school_id = public.current_school_id()));
create policy finance_invoice_items_delete on public.finance_invoice_items for delete
  using (public.finance_can_manage() and exists (select 1 from public.finance_invoices i where i.id = invoice_id and i.school_id = public.current_school_id()));

create policy finance_debit_notes_read on public.finance_debit_notes for select
  using (school_id = public.current_school_id() and public.finance_can_collect());
create policy finance_debit_notes_write on public.finance_debit_notes for insert
  with check (public.finance_can_manage() and school_id = public.current_school_id());

create policy finance_credit_notes_read on public.finance_credit_notes for select
  using (school_id = public.current_school_id() and public.finance_can_collect());
create policy finance_credit_notes_write on public.finance_credit_notes for insert
  with check (public.finance_can_manage() and school_id = public.current_school_id());

create policy finance_opening_balances_read on public.finance_opening_balances for select
  using (school_id = public.current_school_id() and public.finance_can_collect());
create policy finance_opening_balances_write on public.finance_opening_balances for insert
  with check (public.finance_can_manage() and school_id = public.current_school_id());
create policy finance_opening_balances_update on public.finance_opening_balances for update
  using (public.finance_can_manage() and school_id = public.current_school_id());

-- finance_collections/finance_collection_allocations have NO insert/update
-- policy — every write goes through finance_record_collection/
-- finance_reverse_collection/finance_transfer_collection below (security
-- definer, own explicit finance_can_collect() checks), which is what keeps
-- "pay" and "allocate across vote heads by priority, overpayment as credit"
-- atomic and impossible to do halfway from the client (same pattern as
-- save_results_batch/get_report_card above).
create policy finance_collections_read on public.finance_collections for select
  using (school_id = public.current_school_id() and public.finance_can_collect());
create policy finance_collection_allocations_read on public.finance_collection_allocations for select
  using (exists (select 1 from public.finance_collections c where c.id = collection_id and c.school_id = public.current_school_id()) and public.finance_can_collect());

-- ============================================================================
-- RPCs
-- ============================================================================

-- Idempotent bootstrap: called once from the Finance Hub's first load per
-- school session — creates the two vote heads every other RPC here assumes
-- exist ('Balance B/F' for opening-balance carry, and the one flagged
-- is_transport for finance_assign_route()) without ever duplicating them.
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
end;
$$;

create or replace function public.finance_next_no(p_kind text)
returns int
language plpgsql security definer set search_path = public
as $$
declare v_school uuid := public.current_school_id(); v_no int;
begin
  insert into public.finance_counters (school_id, kind, next_no) values (v_school, p_kind, 2)
  on conflict (school_id, kind) do update set next_no = public.finance_counters.next_no + 1
  returning next_no - 1 into v_no;
  return v_no;
end;
$$;

-- Assigns (or re-assigns/corrects — brief scenario #4) a student's transport
-- route for one term, and keeps the matching invoice line item in lockstep:
-- creates the invoice if the student doesn't have one yet for that term,
-- updates the existing Transport line if there is one, else adds it.
create or replace function public.finance_assign_route(
  p_student_id uuid, p_route_id uuid, p_direction text,
  p_academic_year_id uuid, p_term_id uuid
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_school uuid := public.current_school_id();
  v_route public.finance_routes%rowtype;
  v_vote_head_id uuid;
  v_amount numeric;
  v_invoice_id uuid;
  v_item_id uuid;
  v_invoice_no text;
  v_desc text;
begin
  if not public.finance_can_manage() then raise exception 'Not authorized to manage transport/fees' using errcode = '42501'; end if;
  if p_direction not in ('one_way', 'two_way') then raise exception 'Invalid direction'; end if;

  select * into v_route from public.finance_routes where id = p_route_id and school_id = v_school;
  if not found then raise exception 'Route not found'; end if;

  select id into v_vote_head_id from public.finance_vote_heads where school_id = v_school and is_transport = true limit 1;
  if v_vote_head_id is null then
    insert into public.finance_vote_heads (school_id, name, code, is_transport, priority)
      values (v_school, 'Transport', 'TRANSPORT', true, 200) returning id into v_vote_head_id;
  end if;

  v_amount := case when p_direction = 'two_way' then v_route.two_way_amount else v_route.one_way_amount end;
  v_desc := v_route.name || ' — ' || initcap(replace(p_direction, '_', ' '));

  insert into public.finance_student_routes (student_id, route_id, direction, academic_year_id, term_id)
  values (p_student_id, p_route_id, p_direction, p_academic_year_id, p_term_id)
  on conflict (student_id, academic_year_id, term_id)
  do update set route_id = excluded.route_id, direction = excluded.direction, updated_at = now();

  select id into v_invoice_id from public.finance_invoices
    where student_id = p_student_id and academic_year_id = p_academic_year_id and term_id = p_term_id;
  if v_invoice_id is null then
    v_invoice_no := 'INV-' || lpad(public.finance_next_no('invoice')::text, 6, '0');
    insert into public.finance_invoices (school_id, student_id, academic_year_id, term_id, invoice_no, created_by)
      values (v_school, p_student_id, p_academic_year_id, p_term_id, v_invoice_no, auth.uid())
      returning id into v_invoice_id;
  end if;

  select id into v_item_id from public.finance_invoice_items
    where invoice_id = v_invoice_id and vote_head_id = v_vote_head_id and route_id is not null;
  if v_item_id is not null then
    update public.finance_invoice_items set route_id = p_route_id, direction = p_direction, amount = v_amount, description = v_desc, updated_at = now()
      where id = v_item_id;
  else
    insert into public.finance_invoice_items (invoice_id, vote_head_id, amount, description, route_id, direction)
      values (v_invoice_id, v_vote_head_id, v_amount, v_desc, p_route_id, p_direction);
  end if;

  update public.finance_invoices set updated_at = now(), updated_by = auth.uid() where id = v_invoice_id;
  return jsonb_build_object('invoice_id', v_invoice_id, 'amount', v_amount);
end;
$$;

-- Bulk-invoices a fee structure into its tagged classes (brief scenario #5),
-- or just the given students (scenario #8: a new mid-term joiner) when
-- p_student_ids is passed — same code path either way, so the two never
-- drift apart. Creates each student's term invoice if missing, then
-- upserts one line item per vote head in the structure (re-running it after
-- editing the structure's amounts updates every already-invoiced student).
create or replace function public.finance_generate_invoices(p_fee_structure_id uuid, p_student_ids uuid[] default null)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_school uuid := public.current_school_id();
  v_fs public.finance_fee_structures%rowtype;
  v_student record;
  v_invoice_id uuid;
  v_invoice_no text;
  v_item record;
  v_count int := 0;
begin
  if not public.finance_can_manage() then raise exception 'Not authorized to manage fees' using errcode = '42501'; end if;
  select * into v_fs from public.finance_fee_structures where id = p_fee_structure_id and school_id = v_school;
  if not found then raise exception 'Fee structure not found'; end if;

  for v_student in
    select distinct s.id from public.students s
    join public.finance_fee_structure_classes fsc on fsc.class_id = s.class_id and fsc.fee_structure_id = p_fee_structure_id
    where s.school_id = v_school and s.status = 'active'
      and (p_student_ids is null or s.id = any(p_student_ids))
  loop
    select id into v_invoice_id from public.finance_invoices
      where student_id = v_student.id and academic_year_id = v_fs.academic_year_id and term_id = v_fs.term_id;
    if v_invoice_id is null then
      v_invoice_no := 'INV-' || lpad(public.finance_next_no('invoice')::text, 6, '0');
      insert into public.finance_invoices (school_id, student_id, academic_year_id, term_id, invoice_no, created_by)
        values (v_school, v_student.id, v_fs.academic_year_id, v_fs.term_id, v_invoice_no, auth.uid())
        returning id into v_invoice_id;
    end if;

    for v_item in select vote_head_id, amount from public.finance_fee_structure_items where fee_structure_id = p_fee_structure_id
    loop
      if exists (select 1 from public.finance_invoice_items where invoice_id = v_invoice_id and vote_head_id = v_item.vote_head_id and fee_structure_id = p_fee_structure_id) then
        update public.finance_invoice_items set amount = v_item.amount, updated_at = now()
          where invoice_id = v_invoice_id and vote_head_id = v_item.vote_head_id and fee_structure_id = p_fee_structure_id;
      else
        insert into public.finance_invoice_items (invoice_id, vote_head_id, fee_structure_id, amount)
          values (v_invoice_id, v_item.vote_head_id, p_fee_structure_id, v_item.amount);
      end if;
    end loop;

    update public.finance_invoices set updated_at = now(), updated_by = auth.uid() where id = v_invoice_id;
    v_count := v_count + 1;
  end loop;

  return jsonb_build_object('invoiced_count', v_count);
end;
$$;

create or replace function public.finance_issue_debit_note(
  p_student_id uuid, p_vote_head_id uuid, p_amount numeric, p_reason text, p_academic_year_id uuid, p_term_id uuid
)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare v_id uuid; v_school uuid := public.current_school_id();
begin
  if not public.finance_can_manage() then raise exception 'Not authorized' using errcode = '42501'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'Amount must be greater than zero'; end if;
  insert into public.finance_debit_notes (school_id, student_id, academic_year_id, term_id, vote_head_id, amount, reason, created_by)
    values (v_school, p_student_id, p_academic_year_id, p_term_id, p_vote_head_id, p_amount, p_reason, auth.uid())
    returning id into v_id;
  return v_id;
end;
$$;

create or replace function public.finance_issue_credit_note(
  p_student_id uuid, p_vote_head_id uuid, p_amount numeric, p_reason text, p_academic_year_id uuid, p_term_id uuid
)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare v_id uuid; v_school uuid := public.current_school_id();
begin
  if not public.finance_can_manage() then raise exception 'Not authorized' using errcode = '42501'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'Amount must be greater than zero'; end if;
  insert into public.finance_credit_notes (school_id, student_id, academic_year_id, term_id, vote_head_id, amount, reason, created_by)
    values (v_school, p_student_id, p_academic_year_id, p_term_id, p_vote_head_id, p_amount, p_reason, auth.uid())
    returning id into v_id;
  return v_id;
end;
$$;

-- Shared allocation walk used by both finance_record_collection (a brand
-- new payment) and finance_transfer_collection (re-allocating a moved
-- payment against its NEW student's own balances) — one implementation, so
-- the two can never compute a payment split differently. Walks every active
-- vote head in priority order, clearing each one's outstanding balance
-- (expected - credit notes - already paid) until the amount runs out;
-- whatever's left becomes an unallocated credit (brief's overpayment rule).
create or replace function public.finance_allocate_collection(p_collection_id uuid, p_student_id uuid, p_amount numeric)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_school uuid := public.current_school_id();
  v_remaining numeric := p_amount;
  v_vh record;
  v_alloc numeric;
  v_bf_id uuid;
begin
  select id into v_bf_id from public.finance_vote_heads where school_id = v_school and code = 'BALANCE_BF';

  for v_vh in
    select vh.id as vote_head_id,
      coalesce((select sum(ii.amount) from public.finance_invoice_items ii join public.finance_invoices inv on inv.id = ii.invoice_id where inv.student_id = p_student_id and ii.vote_head_id = vh.id), 0)
        + coalesce((select sum(amount) from public.finance_debit_notes where student_id = p_student_id and vote_head_id = vh.id), 0)
        + case when vh.id = v_bf_id then coalesce((select sum(amount) from public.finance_opening_balances where student_id = p_student_id), 0) else 0 end
        - coalesce((select sum(amount) from public.finance_credit_notes where student_id = p_student_id and vote_head_id = vh.id), 0)
        - coalesce((select sum(a.amount) from public.finance_collection_allocations a join public.finance_collections c on c.id = a.collection_id
            where c.student_id = p_student_id and c.status = 'active' and a.vote_head_id = vh.id), 0) as outstanding
    from public.finance_vote_heads vh
    where vh.school_id = v_school and vh.active = true
    order by vh.priority asc, vh.name asc
  loop
    exit when v_remaining <= 0;
    if v_vh.outstanding > 0 then
      v_alloc := least(v_remaining, v_vh.outstanding);
      insert into public.finance_collection_allocations (collection_id, vote_head_id, amount) values (p_collection_id, v_vh.vote_head_id, v_alloc);
      v_remaining := v_remaining - v_alloc;
    end if;
  end loop;

  if v_remaining > 0 then
    insert into public.finance_collection_allocations (collection_id, vote_head_id, amount) values (p_collection_id, null, v_remaining);
  end if;
end;
$$;

create or replace function public.finance_record_collection(
  p_student_id uuid, p_amount numeric, p_mode text, p_reference text, p_notes text
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
  if p_mode not in ('cash', 'paybill', 'bank', 'other') then raise exception 'Invalid payment mode'; end if;
  if not exists (select 1 from public.students where id = p_student_id and school_id = v_school) then raise exception 'Student not found'; end if;

  select id into v_year_id from public.academic_years where school_id = v_school and status = 'active' limit 1;
  select id into v_term_id from public.terms where school_id = v_school and status = 'active' limit 1;
  if v_year_id is null or v_term_id is null then raise exception 'No active academic year/term configured — set one in Settings first.'; end if;

  v_receipt_no := 'RCT-' || lpad(public.finance_next_no('receipt')::text, 6, '0');

  insert into public.finance_collections (school_id, student_id, academic_year_id, term_id, amount, mode, reference, receipt_no, notes, created_by, updated_by)
    values (v_school, p_student_id, v_year_id, v_term_id, p_amount, p_mode, nullif(p_reference, ''), v_receipt_no, nullif(p_notes, ''), auth.uid(), auth.uid())
    returning id into v_collection_id;

  perform public.finance_allocate_collection(v_collection_id, p_student_id, p_amount);

  return jsonb_build_object('collection_id', v_collection_id, 'receipt_no', v_receipt_no);
end;
$$;

create or replace function public.finance_reverse_collection(p_collection_id uuid, p_reason text)
returns boolean
language plpgsql security definer set search_path = public
as $$
declare v_school uuid := public.current_school_id(); v_status text;
begin
  if not public.finance_can_collect() then raise exception 'Not authorized' using errcode = '42501'; end if;
  select status into v_status from public.finance_collections where id = p_collection_id and school_id = v_school;
  if v_status is null then raise exception 'Collection not found'; end if;
  if v_status <> 'active' then raise exception 'Only an active collection can be reversed'; end if;
  update public.finance_collections set status = 'reversed', reversed_reason = p_reason, reversed_at = now(), reversed_by = auth.uid(), updated_by = auth.uid(), updated_at = now()
    where id = p_collection_id;
  return true;
end;
$$;

create or replace function public.finance_transfer_collection(p_collection_id uuid, p_to_student_id uuid)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_school uuid := public.current_school_id();
  v_orig public.finance_collections%rowtype;
  v_new_id uuid;
  v_receipt_no text;
begin
  if not public.finance_can_collect() then raise exception 'Not authorized' using errcode = '42501'; end if;
  select * into v_orig from public.finance_collections where id = p_collection_id and school_id = v_school;
  if not found then raise exception 'Collection not found'; end if;
  if v_orig.status <> 'active' then raise exception 'Only an active collection can be transferred'; end if;
  if not exists (select 1 from public.students where id = p_to_student_id and school_id = v_school) then raise exception 'Destination student not found'; end if;
  if p_to_student_id = v_orig.student_id then raise exception 'Already recorded against this student'; end if;

  v_receipt_no := 'RCT-' || lpad(public.finance_next_no('receipt')::text, 6, '0');

  insert into public.finance_collections
    (school_id, student_id, academic_year_id, term_id, amount, mode, reference, receipt_no, notes, transferred_from_collection_id, created_by, updated_by)
    values (v_school, p_to_student_id, v_orig.academic_year_id, v_orig.term_id, v_orig.amount, v_orig.mode, v_orig.reference, v_receipt_no,
      trim(coalesce(v_orig.notes, '') || ' (transferred from receipt ' || v_orig.receipt_no || ')'), p_collection_id, auth.uid(), auth.uid())
    returning id into v_new_id;

  update public.finance_collections set status = 'transferred', transferred_to_collection_id = v_new_id, updated_at = now(), updated_by = auth.uid()
    where id = p_collection_id;

  perform public.finance_allocate_collection(v_new_id, p_to_student_id, v_orig.amount);

  return jsonb_build_object('new_collection_id', v_new_id, 'receipt_no', v_receipt_no);
end;
$$;

-- One student's full balance: per-vote-head breakdown (expected/paid/
-- credit_note/balance) plus totals — feeds the Student Profile, Statement,
-- and the pre-collection "what do they owe" check (brief scenario #1).
create or replace function public.finance_student_balance(p_student_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_school uuid := public.current_school_id();
  v_bf_id uuid;
  v_result jsonb;
begin
  if not public.finance_can_collect() then raise exception 'Not authorized' using errcode = '42501'; end if;
  if not exists (select 1 from public.students where id = p_student_id and school_id = v_school) then raise exception 'Student not found'; end if;
  select id into v_bf_id from public.finance_vote_heads where school_id = v_school and code = 'BALANCE_BF';

  with expected_by_vh as (
    select vh.id as vote_head_id, vh.name, vh.priority,
      coalesce((select sum(ii.amount) from public.finance_invoice_items ii join public.finance_invoices inv on inv.id = ii.invoice_id where inv.student_id = p_student_id and ii.vote_head_id = vh.id), 0)
        + coalesce((select sum(amount) from public.finance_debit_notes where student_id = p_student_id and vote_head_id = vh.id), 0)
        + case when vh.id = v_bf_id then coalesce((select sum(amount) from public.finance_opening_balances where student_id = p_student_id), 0) else 0 end
        as expected,
      coalesce((select sum(amount) from public.finance_credit_notes where student_id = p_student_id and vote_head_id = vh.id), 0) as credit_note
    from public.finance_vote_heads vh
    where vh.school_id = v_school
  ),
  paid_by_vh as (
    select e.vote_head_id,
      coalesce((select sum(a.amount) from public.finance_collection_allocations a join public.finance_collections c on c.id = a.collection_id
        where c.student_id = p_student_id and c.status = 'active' and a.vote_head_id = e.vote_head_id), 0) as paid
    from expected_by_vh e
  ),
  unallocated as (
    select coalesce(sum(a.amount), 0) as amount
    from public.finance_collection_allocations a join public.finance_collections c on c.id = a.collection_id
    where c.student_id = p_student_id and c.status = 'active' and a.vote_head_id is null
  ),
  rows as (
    select e.vote_head_id, e.name, e.priority, e.expected, e.credit_note, p.paid, (e.expected - e.credit_note - p.paid) as balance
    from expected_by_vh e join paid_by_vh p on p.vote_head_id = e.vote_head_id
    where e.expected <> 0 or e.credit_note <> 0 or p.paid <> 0
  )
  select jsonb_build_object(
    'vote_heads', coalesce((select jsonb_agg(jsonb_build_object(
        'vote_head_id', vote_head_id, 'name', name, 'expected', expected, 'paid', paid, 'credit_note', credit_note, 'balance', balance
      ) order by priority asc, name asc) from rows), '[]'::jsonb),
    'expected', coalesce((select sum(expected) from rows), 0),
    'paid', coalesce((select sum(paid) from rows), 0) + (select amount from unallocated),
    'credit_note', coalesce((select sum(credit_note) from rows), 0),
    'credit_balance', (select amount from unallocated),
    'balance', coalesce((select sum(balance) from rows), 0) - (select amount from unallocated)
  ) into v_result;

  return v_result;
end;
$$;

-- Balances report (brief §Reports): a flat per-student list, optionally
-- scoped to one class and/or filtered to a minimum balance — brief scenario
-- #2 ("every student above a KES 400 balance ... across every class and
-- stream") is p_class_id null, p_min_balance 400.
create or replace function public.finance_class_balances(p_class_id uuid default null, p_min_balance numeric default null)
returns table (
  student_id uuid, admission_no text, full_name text, class_name text, stream_name text,
  expected numeric, paid numeric, credit_note numeric, balance numeric
)
language plpgsql stable security definer set search_path = public
as $$
declare v_school uuid := public.current_school_id();
begin
  if not public.finance_can_collect() then raise exception 'Not authorized' using errcode = '42501'; end if;
  -- Note: every subquery below qualifies its student_id/amount columns with
  -- a table alias (dn.student_id, not bare student_id) — this function's
  -- own OUT parameters are named student_id/expected/paid/credit_note/
  -- balance (so the JS API layer gets natural column names back), and an
  -- unqualified reference inside plpgsql resolves to the OUT parameter
  -- first, silently matching every row instead of correlating to `s.id`.
  return query
  with per_student as (
    select
      s.id as sid,
      coalesce((select sum(ii.amount) from public.finance_invoice_items ii join public.finance_invoices inv on inv.id = ii.invoice_id where inv.student_id = s.id), 0)
        + coalesce((select sum(dn.amount) from public.finance_debit_notes dn where dn.student_id = s.id), 0)
        + coalesce((select sum(ob.amount) from public.finance_opening_balances ob where ob.student_id = s.id), 0) as expected,
      coalesce((select sum(a.amount) from public.finance_collection_allocations a join public.finance_collections c on c.id = a.collection_id where c.student_id = s.id and c.status = 'active'), 0) as paid,
      coalesce((select sum(cn.amount) from public.finance_credit_notes cn where cn.student_id = s.id), 0) as credit_note
    from public.students s
    where s.school_id = v_school and s.status = 'active'
      and (p_class_id is null or s.class_id = p_class_id)
  )
  select ps.sid, s.admission_no, s.full_name, c.name, st.name,
    ps.expected, ps.paid, ps.credit_note, (ps.expected - ps.paid - ps.credit_note) as balance
  from per_student ps
  join public.students s on s.id = ps.sid
  left join public.classes c on c.id = s.class_id
  left join public.streams st on st.id = s.stream_id
  where (p_min_balance is null or (ps.expected - ps.paid - ps.credit_note) > p_min_balance)
  order by c.level_order asc nulls last, c.name asc, st.name asc, s.full_name asc;
end;
$$;

-- Brief scenario #3: how much has been collected per vote head so far
-- (optionally scoped to a term/year) — includes an "Unallocated" row for
-- any overpayment credit not yet tied to a specific vote head.
create or replace function public.finance_vote_head_collections(p_academic_year_id uuid default null, p_term_id uuid default null)
returns table (vote_head_id uuid, vote_head_name text, collected numeric)
language plpgsql stable security definer set search_path = public
as $$
declare v_school uuid := public.current_school_id();
begin
  if not public.finance_can_collect() then raise exception 'Not authorized' using errcode = '42501'; end if;
  return query
  select vh.id, vh.name,
    coalesce(sum(a.amount) filter (where c.status = 'active'
      and (p_academic_year_id is null or c.academic_year_id = p_academic_year_id)
      and (p_term_id is null or c.term_id = p_term_id)), 0) as collected
  from public.finance_vote_heads vh
  left join public.finance_collection_allocations a on a.vote_head_id = vh.id
  left join public.finance_collections c on c.id = a.collection_id
  where vh.school_id = v_school
  group by vh.id, vh.name, vh.priority
  order by vh.priority asc, vh.name asc;

  return query
  select null::uuid, 'Unallocated (Overpayment Credit)',
    coalesce((select sum(a.amount) from public.finance_collection_allocations a join public.finance_collections c on c.id = a.collection_id
      where a.vote_head_id is null and c.status = 'active' and c.school_id = v_school
      and (p_academic_year_id is null or c.academic_year_id = p_academic_year_id)
      and (p_term_id is null or c.term_id = p_term_id)), 0);
end;
$$;

-- Dashboard tiles (brief §Dashboard): headline totals plus a per-class %
-- collected breakdown, both filterable by term/year (null = all time).
create or replace function public.finance_dashboard(p_academic_year_id uuid default null, p_term_id uuid default null)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_school uuid := public.current_school_id();
  v_total_students int;
  v_total_collected numeric;
  v_total_payments int;
  v_total_expected numeric;
  v_per_class jsonb;
  v_result jsonb;
begin
  if not public.finance_can_collect() then raise exception 'Not authorized' using errcode = '42501'; end if;

  select count(*) into v_total_students from public.students where school_id = v_school and status = 'active';

  select coalesce(sum(amount), 0), count(*) into v_total_collected, v_total_payments
  from public.finance_collections
  where school_id = v_school and status = 'active'
    and (p_academic_year_id is null or academic_year_id = p_academic_year_id)
    and (p_term_id is null or term_id = p_term_id);

  select coalesce(sum(ii.amount), 0) into v_total_expected
  from public.finance_invoice_items ii
  join public.finance_invoices inv on inv.id = ii.invoice_id
  where inv.school_id = v_school
    and (p_academic_year_id is null or inv.academic_year_id = p_academic_year_id)
    and (p_term_id is null or inv.term_id = p_term_id);

  select coalesce(jsonb_agg(jsonb_build_object(
      'class_id', c.id, 'class_name', c.name, 'expected', pc.expected, 'collected', pc.collected,
      'pct', case when pc.expected > 0 then round((pc.collected / pc.expected) * 100) else 0 end
    ) order by c.level_order, c.name), '[]'::jsonb)
  into v_per_class
  from public.classes c
  join lateral (
    select
      coalesce((select sum(ii.amount) from public.finance_invoice_items ii join public.finance_invoices inv on inv.id = ii.invoice_id
        join public.students s on s.id = inv.student_id
        where s.class_id = c.id and (p_academic_year_id is null or inv.academic_year_id = p_academic_year_id) and (p_term_id is null or inv.term_id = p_term_id)), 0) as expected,
      coalesce((select sum(a.amount) from public.finance_collection_allocations a join public.finance_collections col on col.id = a.collection_id
        join public.students s2 on s2.id = col.student_id
        where s2.class_id = c.id and col.status = 'active' and (p_academic_year_id is null or col.academic_year_id = p_academic_year_id) and (p_term_id is null or col.term_id = p_term_id)), 0) as collected
  ) pc on true
  where c.school_id = v_school;

  v_result := jsonb_build_object(
    'total_students', v_total_students, 'total_collected', v_total_collected, 'total_payments', v_total_payments,
    'total_expected', v_total_expected,
    'pct_collected', case when v_total_expected > 0 then round((v_total_collected / v_total_expected) * 100) else 0 end,
    'per_class', v_per_class
  );
  return v_result;
end;
$$;

-- Cashbook (brief §Reports, scenario #7): every active collection in a date
-- range, in date order — the print/export layer totals it by mode.
create or replace function public.finance_cashbook(p_from date, p_to date)
returns table (collection_date date, receipt_no text, student_name text, admission_no text, mode text, amount numeric)
language plpgsql stable security definer set search_path = public
as $$
declare v_school uuid := public.current_school_id();
begin
  if not public.finance_can_collect() then raise exception 'Not authorized' using errcode = '42501'; end if;
  return query
  select c.created_at::date, c.receipt_no, s.full_name, s.admission_no, c.mode, c.amount
  from public.finance_collections c
  join public.students s on s.id = c.student_id
  where c.school_id = v_school and c.status = 'active' and c.created_at::date >= p_from and c.created_at::date <= p_to
  order by c.created_at asc;
end;
$$;

-- Trial balance (brief §Reports, scenario #18) — deliberately simple (per
-- the brief: "the core reports a school actually needs for bookkeeping, not
-- a full accounting suite"), NOT a GAAP double-entry ledger: one row per
-- vote head with what was invoiced (Dr) vs. collected (Cr), for handing
-- straight to the school's accountant.
create or replace function public.finance_trial_balance(p_academic_year_id uuid default null, p_term_id uuid default null)
returns table (vote_head_name text, invoiced numeric, collected numeric)
language plpgsql stable security definer set search_path = public
as $$
declare v_school uuid := public.current_school_id();
begin
  if not public.finance_can_collect() then raise exception 'Not authorized' using errcode = '42501'; end if;
  return query
  select vh.name,
    coalesce((select sum(ii.amount) from public.finance_invoice_items ii join public.finance_invoices inv on inv.id = ii.invoice_id
      where ii.vote_head_id = vh.id and (p_academic_year_id is null or inv.academic_year_id = p_academic_year_id) and (p_term_id is null or inv.term_id = p_term_id)), 0)
      + coalesce((select sum(dn.amount) from public.finance_debit_notes dn where dn.vote_head_id = vh.id
          and (p_academic_year_id is null or dn.academic_year_id = p_academic_year_id) and (p_term_id is null or dn.term_id = p_term_id)), 0) as invoiced,
    coalesce((select sum(a.amount) from public.finance_collection_allocations a join public.finance_collections c on c.id = a.collection_id
      where a.vote_head_id = vh.id and c.status = 'active'
      and (p_academic_year_id is null or c.academic_year_id = p_academic_year_id) and (p_term_id is null or c.term_id = p_term_id)), 0) as collected
  from public.finance_vote_heads vh
  where vh.school_id = v_school
  order by vh.priority asc, vh.name asc;
end;
$$;

-- Brief scenario #12: at the start of a new academic year, every student's
-- CLOSING balance from the source year becomes their opening balance
-- (finance_opening_balances) for the destination year — admin-initiated
-- (not an automatic trigger on year creation, so it's a deliberate,
-- reviewable action, not a surprise silent recalculation).
create or replace function public.finance_carry_forward_balances(p_from_year_id uuid, p_to_year_id uuid)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_school uuid := public.current_school_id();
  v_count int := 0;
  v_student record;
  v_closing numeric;
begin
  if not public.finance_can_manage() then raise exception 'Not authorized' using errcode = '42501'; end if;
  if not exists (select 1 from public.academic_years where id = p_from_year_id and school_id = v_school) then raise exception 'Source year not found'; end if;
  if not exists (select 1 from public.academic_years where id = p_to_year_id and school_id = v_school) then raise exception 'Destination year not found'; end if;

  for v_student in select id from public.students where school_id = v_school and status = 'active'
  loop
    select
      coalesce((select sum(ii.amount) from public.finance_invoice_items ii join public.finance_invoices inv on inv.id = ii.invoice_id where inv.student_id = v_student.id and inv.academic_year_id = p_from_year_id), 0)
        + coalesce((select sum(amount) from public.finance_debit_notes where student_id = v_student.id and academic_year_id = p_from_year_id), 0)
        + coalesce((select amount from public.finance_opening_balances where student_id = v_student.id and academic_year_id = p_from_year_id), 0)
        - coalesce((select sum(amount) from public.finance_credit_notes where student_id = v_student.id and academic_year_id = p_from_year_id), 0)
        - coalesce((select sum(a.amount) from public.finance_collection_allocations a join public.finance_collections c on c.id = a.collection_id where c.student_id = v_student.id and c.status = 'active' and c.academic_year_id = p_from_year_id), 0)
      into v_closing;

    if v_closing is distinct from 0 then
      insert into public.finance_opening_balances (school_id, student_id, academic_year_id, amount, notes, created_by)
        values (v_school, v_student.id, p_to_year_id, v_closing, 'Carried forward automatically', auth.uid())
      on conflict (student_id, academic_year_id) do update set amount = excluded.amount, notes = excluded.notes, updated_at = now();
      v_count := v_count + 1;
    end if;
  end loop;

  return jsonb_build_object('carried_count', v_count);
end;
$$;

grant execute on function public.finance_bootstrap() to authenticated;
grant execute on function public.finance_next_no(text) to authenticated;
grant execute on function public.finance_assign_route(uuid, uuid, text, uuid, uuid) to authenticated;
grant execute on function public.finance_generate_invoices(uuid, uuid[]) to authenticated;
grant execute on function public.finance_issue_debit_note(uuid, uuid, numeric, text, uuid, uuid) to authenticated;
grant execute on function public.finance_issue_credit_note(uuid, uuid, numeric, text, uuid, uuid) to authenticated;
grant execute on function public.finance_allocate_collection(uuid, uuid, numeric) to authenticated;
grant execute on function public.finance_record_collection(uuid, numeric, text, text, text) to authenticated;
grant execute on function public.finance_reverse_collection(uuid, text) to authenticated;
grant execute on function public.finance_transfer_collection(uuid, uuid) to authenticated;
grant execute on function public.finance_student_balance(uuid) to authenticated;
grant execute on function public.finance_class_balances(uuid, numeric) to authenticated;
grant execute on function public.finance_vote_head_collections(uuid, uuid) to authenticated;
grant execute on function public.finance_dashboard(uuid, uuid) to authenticated;
grant execute on function public.finance_cashbook(date, date) to authenticated;
grant execute on function public.finance_trial_balance(uuid, uuid) to authenticated;
grant execute on function public.finance_carry_forward_balances(uuid, uuid) to authenticated;
