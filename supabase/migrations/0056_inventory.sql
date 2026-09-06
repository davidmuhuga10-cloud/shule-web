-- ============================================================================
-- 0056_inventory.sql
-- ----------------------------------------------------------------------------
-- Finance Expansion brief item 4 ("Inventory Management Module"). Mostly
-- independent of Finance proper, per the brief's own framing (§4.8: "the
-- exact accounting treatment should follow the existing Finance System
-- structure" — meaning inventory doesn't get its own accounting system,
-- not that every stock movement posts a transaction). The one thing it
-- does reuse directly is Suppliers (§4.9: "reuse the existing supplier
-- records rather than creating duplicate suppliers") — finance_suppliers
-- from migration 0052.
--
-- Categories and units are small configurable lookup tables (§4.1: "should
-- be configurable rather than hard-coded"), seeded with sensible defaults
-- via inventory_bootstrap() (same idempotent pattern as finance_bootstrap)
-- but freely extendable per school.
--
-- inventory_items.quantity is a maintained running total, not computed on
-- read — inventory_transactions is the append-only source of truth (no
-- update/delete policy at all, matching finance_ledger_entries' "audit
-- trail, not editable history" pattern from migration 0052) and a trigger
-- applies every transaction's signed quantity to its item on insert. This
-- keeps the common case (read current stock) a single cheap column read
-- rather than a sum() over history every time the dashboard loads.
--
-- receive/issue/adjustment/stocktake are unified as one shape at the
-- storage level — every row is just a signed quantity delta with a
-- `type` tag and whichever of reference/destination/person/reason/notes/
-- supplier_id apply to that type. Brief §4.7's physical stock-take is
-- exactly a `type = 'stocktake'` adjustment whose quantity is
-- (physical - system) — no separate stock-take table needed.
--
-- Permissions (brief §4.11: "do not create a completely separate
-- permissions system if the existing ERP already has one") reuse
-- finance_can_manage() rather than introducing a new storekeeper
-- capability — a deliberate simplification: a school small enough for
-- this whole brief already routes inventory through the same
-- accounts-clerk/bursar/admin who runs the rest of Finance, per the
-- brief's own "typical school" framing throughout.
-- ============================================================================

begin;

create table public.inventory_categories (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  name text not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (school_id, name)
);
create trigger trg_inventory_categories_updated_at before update on public.inventory_categories
  for each row execute function public.set_updated_at();
create trigger trg_inventory_categories_school_id before insert on public.inventory_categories
  for each row execute function public.set_school_id();

alter table public.inventory_categories enable row level security;
create policy inventory_categories_read on public.inventory_categories for select
  using (school_id = public.current_school_id() and public.finance_can_manage());
create policy inventory_categories_write on public.inventory_categories for insert
  with check (public.finance_can_manage() and school_id = public.current_school_id());
create policy inventory_categories_update on public.inventory_categories for update
  using (public.finance_can_manage() and school_id = public.current_school_id());

create table public.inventory_units (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  name text not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (school_id, name)
);
create trigger trg_inventory_units_updated_at before update on public.inventory_units
  for each row execute function public.set_updated_at();
create trigger trg_inventory_units_school_id before insert on public.inventory_units
  for each row execute function public.set_school_id();

alter table public.inventory_units enable row level security;
create policy inventory_units_read on public.inventory_units for select
  using (school_id = public.current_school_id() and public.finance_can_manage());
create policy inventory_units_write on public.inventory_units for insert
  with check (public.finance_can_manage() and school_id = public.current_school_id());
create policy inventory_units_update on public.inventory_units for update
  using (public.finance_can_manage() and school_id = public.current_school_id());

create table public.inventory_items (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  name text not null,
  sku text,
  category_id uuid references public.inventory_categories(id) on delete restrict,
  unit_id uuid references public.inventory_units(id) on delete restrict,
  quantity numeric not null default 0,
  reorder_level numeric not null default 0 check (reorder_level >= 0),
  unit_cost numeric not null default 0 check (unit_cost >= 0),
  supplier_id uuid references public.finance_suppliers(id) on delete set null,
  storage_location text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (school_id, name)
);
create trigger trg_inventory_items_updated_at before update on public.inventory_items
  for each row execute function public.set_updated_at();
create trigger trg_inventory_items_school_id before insert on public.inventory_items
  for each row execute function public.set_school_id();
create index idx_inventory_items_school on public.inventory_items(school_id);
create index idx_inventory_items_category on public.inventory_items(category_id);

alter table public.inventory_items enable row level security;
create policy inventory_items_read on public.inventory_items for select
  using (school_id = public.current_school_id() and public.finance_can_manage());
create policy inventory_items_write on public.inventory_items for insert
  with check (public.finance_can_manage() and school_id = public.current_school_id());
create policy inventory_items_update on public.inventory_items for update
  using (public.finance_can_manage() and school_id = public.current_school_id());

create table public.inventory_transactions (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  item_id uuid not null references public.inventory_items(id) on delete restrict,
  type text not null check (type in ('receive', 'issue', 'adjustment', 'stocktake')),
  quantity numeric not null check (quantity <> 0), -- signed delta; +receive, -issue, +/- adjustment/stocktake
  unit_cost numeric,
  reference text,
  destination text,
  person text,
  reason text,
  notes text,
  supplier_id uuid references public.finance_suppliers(id) on delete set null,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);
create trigger trg_inventory_transactions_school_id before insert on public.inventory_transactions
  for each row execute function public.set_school_id();
create index idx_inventory_transactions_school on public.inventory_transactions(school_id);
create index idx_inventory_transactions_item on public.inventory_transactions(item_id);
create index idx_inventory_transactions_created_at on public.inventory_transactions(created_at);

alter table public.inventory_transactions enable row level security;
create policy inventory_transactions_read on public.inventory_transactions for select
  using (school_id = public.current_school_id() and public.finance_can_manage());
create policy inventory_transactions_write on public.inventory_transactions for insert
  with check (public.finance_can_manage() and school_id = public.current_school_id());
-- No update/delete policy — append-only, same as finance_ledger_entries.

create function public.inventory_apply_transaction()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  update public.inventory_items set quantity = quantity + new.quantity, updated_at = now() where id = new.item_id;
  return new;
end;
$$;
create trigger trg_inventory_apply_transaction after insert on public.inventory_transactions
  for each row execute function public.inventory_apply_transaction();

-- ---------------------------------------------------------------------------
-- inventory_bootstrap — idempotent per-school defaults, same pattern as
-- finance_bootstrap(). Called once whenever the Inventory screen opens.
-- ---------------------------------------------------------------------------
create function public.inventory_bootstrap()
returns void
language plpgsql security definer set search_path = public
as $$
declare v_school uuid := public.current_school_id();
begin
  if not public.finance_can_manage() then raise exception 'Not authorized' using errcode = '42501'; end if;
  insert into public.inventory_units (school_id, name)
    select v_school, u from unnest(array['Pieces', 'Boxes', 'Packets', 'Cartons', 'Litres', 'Kilograms', 'Bags', 'Reams']) as u
    where not exists (select 1 from public.inventory_units where school_id = v_school);
  insert into public.inventory_categories (school_id, name)
    select v_school, c from unnest(array[
      'Stationery', 'Teaching Materials', 'Cleaning Supplies', 'Kitchen & Food Supplies',
      'Uniforms', 'Sports Equipment', 'Maintenance', 'ICT Accessories', 'Office Supplies', 'Other'
    ]) as c
    where not exists (select 1 from public.inventory_categories where school_id = v_school);
end;
$$;
grant execute on function public.inventory_bootstrap() to authenticated;

-- ---------------------------------------------------------------------------
-- inventory_receive — brief §4.2.
-- ---------------------------------------------------------------------------
create function public.inventory_receive(
  p_item_id uuid, p_quantity numeric, p_unit_cost numeric default null, p_supplier_id uuid default null,
  p_reference text default null, p_location text default null, p_notes text default null, p_date date default current_date
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_school uuid := public.current_school_id();
  v_new_qty numeric;
begin
  if not public.finance_can_manage() then raise exception 'Not authorized to manage inventory' using errcode = '42501'; end if;
  if p_quantity is null or p_quantity <= 0 then raise exception 'Quantity must be greater than zero'; end if;
  if not exists (select 1 from public.inventory_items where id = p_item_id and school_id = v_school) then
    raise exception 'Item not found';
  end if;
  if p_supplier_id is not null and not exists (select 1 from public.finance_suppliers where id = p_supplier_id and school_id = v_school) then
    raise exception 'Supplier not found';
  end if;

  insert into public.inventory_transactions (school_id, item_id, type, quantity, unit_cost, supplier_id, reference, notes, created_by)
    values (v_school, p_item_id, 'receive', p_quantity, p_unit_cost, p_supplier_id, nullif(p_reference, ''), nullif(p_notes, ''), auth.uid());

  update public.inventory_items
    set unit_cost = coalesce(p_unit_cost, unit_cost),
        storage_location = coalesce(nullif(p_location, ''), storage_location),
        supplier_id = coalesce(p_supplier_id, supplier_id)
    where id = p_item_id
    returning quantity into v_new_qty;

  return jsonb_build_object('item_id', p_item_id, 'new_quantity', v_new_qty);
end;
$$;
grant execute on function public.inventory_receive(uuid, numeric, numeric, uuid, text, text, text, date) to authenticated;

-- ---------------------------------------------------------------------------
-- inventory_issue — brief §4.3. Blocks issuing more than is on hand — a
-- small school's store should never show negative stock.
-- ---------------------------------------------------------------------------
create function public.inventory_issue(
  p_item_id uuid, p_quantity numeric, p_destination text default null, p_person text default null,
  p_reason text default null, p_notes text default null, p_date date default current_date
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_school uuid := public.current_school_id();
  v_current numeric;
  v_new_qty numeric;
begin
  if not public.finance_can_manage() then raise exception 'Not authorized to manage inventory' using errcode = '42501'; end if;
  if p_quantity is null or p_quantity <= 0 then raise exception 'Quantity must be greater than zero'; end if;

  select quantity into v_current from public.inventory_items where id = p_item_id and school_id = v_school for update;
  if not found then raise exception 'Item not found'; end if;
  if p_quantity > v_current then raise exception 'Only % currently in stock — cannot issue %', v_current, p_quantity; end if;

  insert into public.inventory_transactions (school_id, item_id, type, quantity, destination, person, reason, notes, created_by)
    values (v_school, p_item_id, 'issue', -p_quantity, nullif(p_destination, ''), nullif(p_person, ''), nullif(p_reason, ''), nullif(p_notes, ''), auth.uid());

  select quantity into v_new_qty from public.inventory_items where id = p_item_id;
  return jsonb_build_object('item_id', p_item_id, 'new_quantity', v_new_qty);
end;
$$;
grant execute on function public.inventory_issue(uuid, numeric, text, text, text, text, date) to authenticated;

-- ---------------------------------------------------------------------------
-- inventory_adjust — brief §4.4 (damaged/expired/lost/found/corrections).
-- p_quantity_delta may be positive or negative; the resulting stock may
-- never go negative.
-- ---------------------------------------------------------------------------
create function public.inventory_adjust(
  p_item_id uuid, p_quantity_delta numeric, p_reason text, p_notes text default null, p_date date default current_date
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_school uuid := public.current_school_id();
  v_current numeric;
  v_new_qty numeric;
begin
  if not public.finance_can_manage() then raise exception 'Not authorized to manage inventory' using errcode = '42501'; end if;
  if p_quantity_delta is null or p_quantity_delta = 0 then raise exception 'Adjustment quantity cannot be zero'; end if;
  if coalesce(trim(p_reason), '') = '' then raise exception 'A reason is required for a stock adjustment'; end if;

  select quantity into v_current from public.inventory_items where id = p_item_id and school_id = v_school for update;
  if not found then raise exception 'Item not found'; end if;
  if v_current + p_quantity_delta < 0 then raise exception 'This adjustment would take stock below zero (currently %)', v_current; end if;

  insert into public.inventory_transactions (school_id, item_id, type, quantity, reason, notes, created_by)
    values (v_school, p_item_id, 'adjustment', p_quantity_delta, p_reason, nullif(p_notes, ''), auth.uid());

  select quantity into v_new_qty from public.inventory_items where id = p_item_id;
  return jsonb_build_object('item_id', p_item_id, 'new_quantity', v_new_qty);
end;
$$;
grant execute on function public.inventory_adjust(uuid, numeric, text, text, date) to authenticated;

-- ---------------------------------------------------------------------------
-- inventory_stocktake — brief §4.7. Records the DIFFERENCE as one
-- 'stocktake'-type adjustment; a zero difference is confirmed but not
-- logged (nothing actually changed, so there's nothing for history to
-- show — the brief's own worked example is about the difference, not
-- about proving a null check happened).
-- ---------------------------------------------------------------------------
create function public.inventory_stocktake(
  p_item_id uuid, p_physical_quantity numeric, p_reason text default null, p_notes text default null, p_date date default current_date
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_school uuid := public.current_school_id();
  v_system numeric;
  v_delta numeric;
begin
  if not public.finance_can_manage() then raise exception 'Not authorized to manage inventory' using errcode = '42501'; end if;
  if p_physical_quantity is null or p_physical_quantity < 0 then raise exception 'Physical quantity cannot be negative'; end if;

  select quantity into v_system from public.inventory_items where id = p_item_id and school_id = v_school for update;
  if not found then raise exception 'Item not found'; end if;

  v_delta := p_physical_quantity - v_system;
  if v_delta = 0 then
    return jsonb_build_object('item_id', p_item_id, 'system_quantity', v_system, 'physical_quantity', p_physical_quantity, 'difference', 0, 'recorded', false);
  end if;

  insert into public.inventory_transactions (school_id, item_id, type, quantity, reason, notes, created_by)
    values (v_school, p_item_id, 'stocktake', v_delta,
            coalesce(nullif(p_reason, ''), 'Physical stock count'), nullif(p_notes, ''), auth.uid());

  return jsonb_build_object('item_id', p_item_id, 'system_quantity', v_system, 'physical_quantity', p_physical_quantity, 'difference', v_delta, 'recorded', true);
end;
$$;
grant execute on function public.inventory_stocktake(uuid, numeric, text, text, date) to authenticated;

commit;
