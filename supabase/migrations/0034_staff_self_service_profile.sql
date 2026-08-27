-- 0034_staff_self_service_profile.sql
-- ----------------------------------------------------------------------------
-- Next Sprint 2 §11: "Teachers currently have no way to update their own
-- profile (phone number, gender, other personal details) — this is only
-- editable from the admin side."
--
-- The `staff` table only has staff_admin_update (public.is_admin()) — no
-- teacher-write policy exists at all today. Rather than adding a broad
-- "teacher can update their own staff row" RLS policy (Postgres RLS is
-- row-level, not column-level — that would also let a teacher change their
-- own role, employment_start_date, status, or email via a raw REST call,
-- even if the UI form never shows those fields), this is a narrow
-- SECURITY DEFINER RPC — the same pattern this schema already uses for
-- every other "only THIS specific, safe thing" write (finance_reverse_
-- collection, resolve_staff_login_email, etc). It only ever touches the
-- caller's OWN linked staff row (via profiles.staff_id = auth.uid()'s
-- profile), and only ever writes the personal-detail columns explicitly
-- listed below — role/status/employment_start_date/email/tsc_number are
-- untouched no matter what's passed in, because they're simply not
-- parameters this function accepts.
-- ----------------------------------------------------------------------------

create or replace function public.staff_update_own_profile(
  p_phone text, p_gender text, p_date_of_birth date,
  p_national_id text, p_next_of_kin_name text, p_next_of_kin_contact text
)
returns public.staff
language plpgsql security definer set search_path = public
as $$
declare
  v_staff_id uuid;
  v_school uuid := public.current_school_id();
  v_row public.staff%rowtype;
begin
  select staff_id into v_staff_id from public.profiles where id = auth.uid();
  if v_staff_id is null then raise exception 'This account is not linked to a staff record'; end if;
  if p_gender is not null and p_gender not in ('Male', 'Female') then
    raise exception 'Invalid gender';
  end if;

  update public.staff set
    phone = p_phone,
    gender = p_gender::gender_t,
    date_of_birth = p_date_of_birth,
    national_id = p_national_id,
    next_of_kin_name = p_next_of_kin_name,
    next_of_kin_contact = p_next_of_kin_contact
  where id = v_staff_id and school_id = v_school
  returning * into v_row;

  if v_row.id is null then raise exception 'Staff record not found'; end if;
  return v_row;
end;
$$;

grant execute on function public.staff_update_own_profile(text, text, date, text, text, text) to authenticated;

-- ============================================================================
-- Next Sprint 2 §13: "Add a feature to transfer fees between students, but
-- only where an overpayment exists — useful when a parent has two children
-- at the school and wants to move the excess from one to the other."
--
-- Distinct from the existing finance_transfer_collection() (moves one whole
-- payment/receipt to a different student, no overpayment check at all) —
-- this moves a chosen AMOUNT of a student's CURRENT credit/overpayment to
-- another student, and refuses if the source student doesn't actually have
-- that much overpayment. Implemented as a debit note on the source (brings
-- their balance back toward zero, i.e. consumes the credit) plus a credit
-- note on the destination (reduces what they owe) — both inserted against
-- the school's 'Balance B/F' vote head (finance_bootstrap() always seeds
-- one) — the same vote head opening-balance carry-forward already uses for
-- this kind of cross-cutting adjustment, so no new vote-head picker is
-- needed in the UI. The overpayment check re-derives the balance from
-- finance_student_balance() SERVER-SIDE rather than trusting whatever
-- balance the client last saw — a client-side number can be stale by the
-- time the transfer is submitted.
-- ============================================================================
create or replace function public.finance_transfer_overpayment(
  p_from_student_id uuid, p_to_student_id uuid, p_amount numeric,
  p_academic_year_id uuid, p_term_id uuid, p_reason text
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_school uuid := public.current_school_id();
  v_bf_id uuid;
  v_balance numeric;
  v_debit_id uuid;
  v_credit_id uuid;
  v_from_name text;
  v_to_name text;
begin
  if not public.finance_can_manage() then raise exception 'Not authorized' using errcode = '42501'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'Amount must be greater than zero'; end if;
  if p_from_student_id = p_to_student_id then raise exception 'Choose two different students'; end if;

  select full_name into v_from_name from public.students where id = p_from_student_id and school_id = v_school;
  if v_from_name is null then raise exception 'Source student not found'; end if;
  select full_name into v_to_name from public.students where id = p_to_student_id and school_id = v_school;
  if v_to_name is null then raise exception 'Destination student not found'; end if;

  select (public.finance_student_balance(p_from_student_id) ->> 'balance')::numeric into v_balance;
  if v_balance >= 0 then
    raise exception '% has no overpayment to transfer (current balance: KES %).', v_from_name, v_balance;
  end if;
  if p_amount > (-1 * v_balance) then
    raise exception '% only has an overpayment of KES % — cannot transfer KES %.', v_from_name, (-1 * v_balance), p_amount;
  end if;

  select id into v_bf_id from public.finance_vote_heads where school_id = v_school and code = 'BALANCE_BF';
  if v_bf_id is null then raise exception 'Balance B/F vote head not found — open Finance once to run initial setup, then try again.'; end if;

  insert into public.finance_debit_notes (school_id, student_id, academic_year_id, term_id, vote_head_id, amount, reason, created_by)
    values (v_school, p_from_student_id, p_academic_year_id, p_term_id, v_bf_id, p_amount,
      trim('Fee transfer to ' || v_to_name || case when coalesce(p_reason, '') <> '' then ': ' || p_reason else '' end),
      auth.uid())
    returning id into v_debit_id;

  insert into public.finance_credit_notes (school_id, student_id, academic_year_id, term_id, vote_head_id, amount, reason, created_by)
    values (v_school, p_to_student_id, p_academic_year_id, p_term_id, v_bf_id, p_amount,
      trim('Fee transfer from ' || v_from_name || case when coalesce(p_reason, '') <> '' then ': ' || p_reason else '' end),
      auth.uid())
    returning id into v_credit_id;

  return jsonb_build_object('debit_note_id', v_debit_id, 'credit_note_id', v_credit_id);
end;
$$;
grant execute on function public.finance_transfer_overpayment(uuid, uuid, numeric, uuid, uuid, text) to authenticated;
