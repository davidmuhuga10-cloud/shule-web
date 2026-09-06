-- ============================================================================
-- 0051_transport_charge_override.sql
-- ----------------------------------------------------------------------------
-- Finance Expansion brief §5.4/5.6 ("Students Changing Routes" / "Transport
-- Charges should be editable where necessary because schools may have
-- special arrangements or negotiated charges for individual students").
--
-- finance_assign_route() already auto-updates a student's transport invoice
-- line to the new route/direction's standard charge whenever they change
-- route — that part was already correct. What was missing: no way to keep
-- a different charge on purpose (a negotiated rate) when reassigning. This
-- adds one optional parameter, defaulting to the existing auto-computed
-- behaviour when omitted, so every existing caller is unaffected.
--
-- Same overload-avoidance pattern as 0049: adding a parameter changes the
-- signature, so the old one must be dropped explicitly first.
-- ============================================================================

begin;

drop function if exists public.finance_assign_route(uuid, uuid, text, uuid, uuid);

create function public.finance_assign_route(
  p_student_id uuid, p_route_id uuid, p_direction text, p_academic_year_id uuid, p_term_id uuid,
  p_amount_override numeric default null
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
  if p_amount_override is not null and p_amount_override < 0 then raise exception 'Charge cannot be negative'; end if;

  select * into v_route from public.finance_routes where id = p_route_id and school_id = v_school;
  if not found then raise exception 'Route not found'; end if;

  select id into v_vote_head_id from public.finance_vote_heads where school_id = v_school and is_transport = true limit 1;
  if v_vote_head_id is null then
    insert into public.finance_vote_heads (school_id, name, code, is_transport, priority)
      values (v_school, 'Transport', 'TRANSPORT', true, 200) returning id into v_vote_head_id;
  end if;

  v_amount := coalesce(p_amount_override, case when p_direction = 'two_way' then v_route.two_way_amount else v_route.one_way_amount end);
  v_desc := v_route.name || ' — ' || initcap(replace(p_direction, '_', ' ')) || case when p_amount_override is not null then ' (negotiated rate)' else '' end;

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

grant execute on function public.finance_assign_route(uuid, uuid, text, uuid, uuid, numeric) to authenticated;

commit;
