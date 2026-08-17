-- ============================================================================
-- 0032_finance_round2.sql — Finance_Module_Round2.docx backend changes.
--
-- Covers:
--   §2  Dashboard: finance_dashboard() gains `total_balance` (what's still
--       owed overall — expected + debit notes - credit notes - collected)
--       so the UI can swap the "Total Payments" tile for "Total Balances".
--   §2  Automatic carry-forward: previously an admin had to remember to
--       call finance_carry_forward_balances() by hand. Now a trigger on
--       academic_years fires it automatically the moment a new year is
--       activated — see finance_auto_carry_forward_trigger() below for why
--       a DB trigger (not a UI hook) is the right place for a "shouldn't be
--       a manual step someone has to remember" requirement: it fires no
--       matter which screen flips a year to active, today or in five years.
--       (Terms don't need an equivalent — balances already run continuously
--       across a year's terms via one opening_balances row per (student,
--       year), not one per term, so there's no term-boundary reset to
--       automate in the first place.)
--   §8  Transport: finance_invoice_route() — bulk-invoices every student
--       assigned to a route for a given term, skipping anyone who already
--       has a transport line item on that route (no double-invoicing, per
--       the brief's explicit bug callout).
--   §9  Invoicing sub-reports: finance_vote_head_student_balances() — the
--       same "who hasn't cleared X" shape as finance_class_balances but
--       scoped to one vote head (used for "who hasn't cleared Transport").
--   §10 finance_uninvoice_structure() — removes a fee structure's line
--       items from every invoice they're on. Safe to run even after
--       payments were recorded against that vote head: collections/
--       allocations are a separate ledger untouched by this (see the
--       function's own comment for why that's fine, not a bug).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- §2 — finance_dashboard(): add total_balance (and the debit/credit note
-- totals it's built from) alongside the existing fields. Nothing existing
-- is removed, so nothing already relying on this RPC's other fields breaks.
-- ----------------------------------------------------------------------------
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
  v_total_debit numeric;
  v_total_credit numeric;
  v_total_balance numeric;
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

  select coalesce(sum(amount), 0) into v_total_debit
  from public.finance_debit_notes
  where school_id = v_school
    and (p_academic_year_id is null or academic_year_id = p_academic_year_id)
    and (p_term_id is null or term_id = p_term_id);

  select coalesce(sum(amount), 0) into v_total_credit
  from public.finance_credit_notes
  where school_id = v_school
    and (p_academic_year_id is null or academic_year_id = p_academic_year_id)
    and (p_term_id is null or term_id = p_term_id);

  v_total_balance := v_total_expected + v_total_debit - v_total_credit - v_total_collected;

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
    'total_expected', v_total_expected, 'total_debit_notes', v_total_debit, 'total_credit_notes', v_total_credit,
    'total_balance', v_total_balance,
    'pct_collected', case when v_total_expected > 0 then round((v_total_collected / v_total_expected) * 100) else 0 end,
    'per_class', v_per_class
  );
  return v_result;
end;
$$;

-- ----------------------------------------------------------------------------
-- §2 — automatic carry-forward. Fires right after an academic_years row
-- flips to 'active'. academic_years.save() (src/lib/api/academics.mjs)
-- updates the newly-active row FIRST, then archives every other active row
-- in a second statement — so at the moment this trigger runs, the
-- previously-active year is still status='active' in the table, which is
-- exactly what the lookup below depends on. Re-activating a year twice is
-- harmless: finance_carry_forward_balances() itself upserts on
-- (student_id, academic_year_id), so re-running it just resyncs figures
-- rather than duplicating anything.
-- ----------------------------------------------------------------------------
create or replace function public.finance_auto_carry_forward_trigger()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare v_prev_year_id uuid;
begin
  if new.status = 'active' and (old.status is distinct from 'active') then
    select id into v_prev_year_id from public.academic_years
      where school_id = new.school_id and status = 'active' and id <> new.id
      order by coalesce(start_date, '1900-01-01'::date) desc limit 1;
    if v_prev_year_id is not null then
      perform public.finance_carry_forward_balances(v_prev_year_id, new.id);
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_finance_auto_carry_forward on public.academic_years;
create trigger trg_finance_auto_carry_forward
  after update on public.academic_years
  for each row execute function public.finance_auto_carry_forward_trigger();

-- ----------------------------------------------------------------------------
-- §8 — bulk-invoice every student assigned to one route, for one term,
-- skipping anyone who already has a transport line item for that route (the
-- brief's explicit "must reject double-invoicing" bug callout). Mirrors
-- finance_assign_route()'s own invoice-line logic exactly, just walked over
-- every student on the route instead of one at a time.
-- ----------------------------------------------------------------------------
create or replace function public.finance_invoice_route(p_route_id uuid, p_academic_year_id uuid, p_term_id uuid)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_school uuid := public.current_school_id();
  v_route public.finance_routes%rowtype;
  v_vote_head_id uuid;
  v_student record;
  v_invoiced int := 0;
  v_skipped int := 0;
  v_amount numeric;
  v_desc text;
  v_invoice_id uuid;
  v_invoice_no text;
begin
  if not public.finance_can_manage() then raise exception 'Not authorized' using errcode = '42501'; end if;
  select * into v_route from public.finance_routes where id = p_route_id and school_id = v_school;
  if not found then raise exception 'Route not found'; end if;

  select id into v_vote_head_id from public.finance_vote_heads where school_id = v_school and is_transport = true limit 1;
  if v_vote_head_id is null then
    insert into public.finance_vote_heads (school_id, name, code, is_transport, priority)
      values (v_school, 'Transport', 'TRANSPORT', true, 200) returning id into v_vote_head_id;
  end if;

  for v_student in
    select sr.student_id, sr.direction
    from public.finance_student_routes sr
    where sr.route_id = p_route_id and sr.academic_year_id = p_academic_year_id and sr.term_id = p_term_id
  loop
    select id into v_invoice_id from public.finance_invoices
      where student_id = v_student.student_id and academic_year_id = p_academic_year_id and term_id = p_term_id;

    if v_invoice_id is not null and exists (
      select 1 from public.finance_invoice_items
      where invoice_id = v_invoice_id and vote_head_id = v_vote_head_id and route_id = p_route_id
    ) then
      v_skipped := v_skipped + 1;
      continue;
    end if;

    v_amount := case when v_student.direction = 'two_way' then v_route.two_way_amount else v_route.one_way_amount end;
    v_desc := v_route.name || ' — ' || initcap(replace(v_student.direction, '_', ' '));

    if v_invoice_id is null then
      v_invoice_no := 'INV-' || lpad(public.finance_next_no('invoice')::text, 6, '0');
      insert into public.finance_invoices (school_id, student_id, academic_year_id, term_id, invoice_no, created_by)
        values (v_school, v_student.student_id, p_academic_year_id, p_term_id, v_invoice_no, auth.uid())
        returning id into v_invoice_id;
    end if;

    insert into public.finance_invoice_items (invoice_id, vote_head_id, amount, description, route_id, direction)
      values (v_invoice_id, v_vote_head_id, v_amount, v_desc, p_route_id, v_student.direction);

    update public.finance_invoices set updated_at = now(), updated_by = auth.uid() where id = v_invoice_id;
    v_invoiced := v_invoiced + 1;
  end loop;

  return jsonb_build_object('invoiced_count', v_invoiced, 'skipped_count', v_skipped);
end;
$$;

-- ----------------------------------------------------------------------------
-- §9 — one vote head's balance per student (used for "students who haven't
-- cleared Transport specifically", but generic — works for any vote head).
-- Every subquery column is alias-qualified throughout (see finance_
-- class_balances' own comment in 0031 for why: this function's OUT
-- parameters share names with real columns, and an unqualified reference
-- resolves to the OUT parameter first, silently matching every row).
-- ----------------------------------------------------------------------------
create or replace function public.finance_vote_head_student_balances(
  p_vote_head_id uuid, p_academic_year_id uuid default null, p_term_id uuid default null
)
returns table (
  student_id uuid, admission_no text, full_name text, class_name text, stream_name text,
  expected numeric, paid numeric, balance numeric
)
language plpgsql stable security definer set search_path = public
as $$
declare v_school uuid := public.current_school_id();
begin
  if not public.finance_can_collect() then raise exception 'Not authorized' using errcode = '42501'; end if;
  return query
  select s.id, s.admission_no, s.full_name, c.name, st.name,
    coalesce((select sum(ii.amount) from public.finance_invoice_items ii join public.finance_invoices inv on inv.id = ii.invoice_id
      where inv.student_id = s.id and ii.vote_head_id = p_vote_head_id
        and (p_academic_year_id is null or inv.academic_year_id = p_academic_year_id)
        and (p_term_id is null or inv.term_id = p_term_id)), 0) as expected,
    coalesce((select sum(a.amount) from public.finance_collection_allocations a join public.finance_collections col on col.id = a.collection_id
      where col.student_id = s.id and a.vote_head_id = p_vote_head_id and col.status = 'active'
        and (p_academic_year_id is null or col.academic_year_id = p_academic_year_id)
        and (p_term_id is null or col.term_id = p_term_id)), 0) as paid,
    (coalesce((select sum(ii.amount) from public.finance_invoice_items ii join public.finance_invoices inv on inv.id = ii.invoice_id
      where inv.student_id = s.id and ii.vote_head_id = p_vote_head_id
        and (p_academic_year_id is null or inv.academic_year_id = p_academic_year_id)
        and (p_term_id is null or inv.term_id = p_term_id)), 0)
     - coalesce((select sum(a.amount) from public.finance_collection_allocations a join public.finance_collections col on col.id = a.collection_id
      where col.student_id = s.id and a.vote_head_id = p_vote_head_id and col.status = 'active'
        and (p_academic_year_id is null or col.academic_year_id = p_academic_year_id)
        and (p_term_id is null or col.term_id = p_term_id)), 0)) as balance
  from public.students s
  join public.classes c on c.id = s.class_id
  left join public.streams st on st.id = s.stream_id
  where s.school_id = v_school and s.status = 'active'
  order by c.level_order, c.name, s.full_name;
end;
$$;

-- ----------------------------------------------------------------------------
-- §10 — un-invoice: removes a fee structure's own line items from whatever
-- invoices they're on. This is safe even if a parent already paid toward
-- that vote head: finance_collections/finance_collection_allocations are a
-- completely separate ledger (a receipt already issued), so removing the
-- charge doesn't touch or reverse any payment — it just means that vote
-- head's "expected" drops, and the balance query naturally reflects the
-- student now being paid-ahead/credited on it, exactly like any other
-- overpayment. Nothing needs to "undo" a receipt for this to be safe.
-- ----------------------------------------------------------------------------
create or replace function public.finance_uninvoice_structure(p_fee_structure_id uuid)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_school uuid := public.current_school_id();
  v_removed int := 0;
  v_students int := 0;
begin
  if not public.finance_can_manage() then raise exception 'Not authorized' using errcode = '42501'; end if;
  if not exists (select 1 from public.finance_fee_structures where id = p_fee_structure_id and school_id = v_school) then
    raise exception 'Fee structure not found';
  end if;

  select count(distinct inv.student_id) into v_students
  from public.finance_invoice_items ii
  join public.finance_invoices inv on inv.id = ii.invoice_id
  where ii.fee_structure_id = p_fee_structure_id and inv.school_id = v_school;

  with deleted as (
    delete from public.finance_invoice_items ii
    using public.finance_invoices inv
    where ii.invoice_id = inv.id and ii.fee_structure_id = p_fee_structure_id and inv.school_id = v_school
    returning ii.id
  )
  select count(*) into v_removed from deleted;

  return jsonb_build_object('removed_items', v_removed, 'affected_students', v_students);
end;
$$;

grant execute on function public.finance_invoice_route(uuid, uuid, uuid) to authenticated;
grant execute on function public.finance_vote_head_student_balances(uuid, uuid, uuid) to authenticated;
grant execute on function public.finance_uninvoice_structure(uuid) to authenticated;
