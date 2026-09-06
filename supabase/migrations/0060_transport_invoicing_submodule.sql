-- ============================================================================
-- 0060_transport_invoicing_submodule.sql
-- ----------------------------------------------------------------------------
-- POST-BUILD FEEDBACK item 8: "The system must clearly show which students
-- have already been invoiced for the term and which haven't." Bulk
-- invoicing (finance_invoice_route, 0032) already skips anyone already
-- invoiced server-side — the real gap is that the roster screen never
-- SHOWED that status per student, so a bursar had no way to see it before
-- clicking Invoice. This mirrors the exact same "already invoiced" check
-- finance_invoice_route uses internally (an invoice_item on that student's
-- term invoice, for this vote head + route), just as a read instead of a
-- side effect.
-- ============================================================================

begin;

create function public.finance_route_invoiced_students(p_route_id uuid, p_academic_year_id uuid, p_term_id uuid)
returns table(student_id uuid)
language plpgsql security definer set search_path = public
as $$
declare
  v_school uuid := public.current_school_id();
  v_vote_head_id uuid;
begin
  if not public.finance_can_manage() then raise exception 'Not authorized' using errcode = '42501'; end if;

  select id into v_vote_head_id from public.finance_vote_heads where school_id = v_school and is_transport = true limit 1;
  if v_vote_head_id is null then
    return; -- no transport vote head exists yet => nobody can possibly have been invoiced under it
  end if;

  return query
    select distinct i.student_id
    from public.finance_invoices i
    join public.finance_invoice_items ii on ii.invoice_id = i.id
    where i.school_id = v_school and i.academic_year_id = p_academic_year_id and i.term_id = p_term_id
      and ii.vote_head_id = v_vote_head_id and ii.route_id = p_route_id;
end;
$$;
grant execute on function public.finance_route_invoiced_students(uuid, uuid, uuid) to authenticated;

commit;
