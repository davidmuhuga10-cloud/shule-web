-- ============================================================================
-- 0061_finance_fee_structure_atomic_save.sql
-- ----------------------------------------------------------------------------
-- POST-BUILD AUDIT (Task #49): feeStructures.save() in src/lib/api/finance.mjs
-- used to be FOUR separate client round-trips — update/insert the header,
-- delete the old classes+items, then insert the new classes and items with
-- Promise.all. If the connection dropped or an insert failed between steps
-- (e.g. after classes were re-tagged but before items were re-inserted), a
-- fee structure was left half-written: tagged to classes but with zero vote
-- head amounts, which "Invoice Now" would then happily turn into real
-- zero-amount invoices for every student in those classes.
--
-- This wraps the whole save in one plpgsql function so it's a single
-- transaction: either everything lands, or nothing does (an exception rolls
-- the whole thing back automatically — no explicit ROLLBACK needed inside a
-- function body in Postgres; an unhandled exception unwinds the entire call).
-- ============================================================================

begin;

create function public.finance_save_fee_structure(
  p_id uuid,
  p_name text,
  p_academic_year_id uuid,
  p_term_id uuid,
  p_class_ids uuid[],
  p_items jsonb -- [{"vote_head_id": "...", "amount": 123}, ...]
)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_school uuid := public.current_school_id();
  v_id uuid;
  v_item jsonb;
begin
  if not public.finance_can_manage() then raise exception 'Not authorized to manage fees' using errcode = '42501'; end if;
  if coalesce(trim(p_name), '') = '' then raise exception 'Fee structure name is required.'; end if;
  if p_academic_year_id is null or p_term_id is null then raise exception 'Choose an academic year and term.'; end if;
  if p_class_ids is null or array_length(p_class_ids, 1) is null then raise exception 'Choose at least one class this fee structure applies to.'; end if;
  if p_items is null or jsonb_array_length(p_items) = 0 then raise exception 'Add at least one vote head amount.'; end if;

  if p_id is not null then
    update public.finance_fee_structures
      set name = trim(p_name), academic_year_id = p_academic_year_id, term_id = p_term_id
      where id = p_id and school_id = v_school
      returning id into v_id;
    if v_id is null then raise exception 'Fee structure not found.'; end if;
    delete from public.finance_fee_structure_classes where fee_structure_id = v_id;
    delete from public.finance_fee_structure_items where fee_structure_id = v_id;
  else
    insert into public.finance_fee_structures (name, academic_year_id, term_id)
      values (trim(p_name), p_academic_year_id, p_term_id)
      returning id into v_id;
  end if;

  insert into public.finance_fee_structure_classes (fee_structure_id, class_id)
    select v_id, cid from unnest(p_class_ids) as cid;

  for v_item in select * from jsonb_array_elements(p_items)
  loop
    if (v_item->>'vote_head_id') is not null and (v_item->>'amount')::numeric >= 0 then
      insert into public.finance_fee_structure_items (fee_structure_id, vote_head_id, amount)
        values (v_id, (v_item->>'vote_head_id')::uuid, (v_item->>'amount')::numeric);
    end if;
  end loop;

  return v_id;
end;
$$;
grant execute on function public.finance_save_fee_structure(uuid, text, uuid, uuid, uuid[], jsonb) to authenticated;

commit;
