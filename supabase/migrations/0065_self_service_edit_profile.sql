-- 0065_self_service_edit_profile.sql
-- Every logged-in user gets an "Edit Profile" screen to update their own
-- name/phone (and, for staff, the personal fields 0034 already covers).
-- Same SECURITY DEFINER pattern as staff_update_own_profile (0034) — never
-- touches role/status/email/login, only the caller's own row.

-- Generic path: updates profiles.name/phone for the caller's own row.
-- Used directly by parents/students/finance-only accounts, and also keeps
-- profiles.name/phone in sync for staff accounts (see below).
create or replace function public.profile_update_own(p_name text, p_phone text)
returns public.profiles
language plpgsql security definer set search_path = public
as $$
declare
  v_row public.profiles%rowtype;
begin
  if p_name is null or trim(p_name) = '' then
    raise exception 'Name cannot be empty';
  end if;

  update public.profiles set
    name = trim(p_name),
    phone = nullif(trim(coalesce(p_phone, '')), '')
  where id = auth.uid()
  returning * into v_row;

  if v_row.id is null then raise exception 'Profile not found'; end if;
  return v_row;
end;
$$;
grant execute on function public.profile_update_own(text, text) to authenticated;

-- Extend the staff self-service RPC (0034) to also accept a name change —
-- writes staff.full_name (the record every report/list actually reads)
-- AND profiles.name (what the topbar/greeting reads) together, so the two
-- never drift apart. Signature gains a leading param, so the old 6-arg
-- overload from 0034 must be dropped first or both would exist side by side.
drop function if exists public.staff_update_own_profile(text, text, date, text, text, text);

create or replace function public.staff_update_own_profile(
  p_full_name text, p_phone text, p_gender text, p_date_of_birth date,
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
  if p_full_name is null or trim(p_full_name) = '' then
    raise exception 'Name cannot be empty';
  end if;

  update public.staff set
    full_name = trim(p_full_name),
    phone = p_phone,
    gender = p_gender::gender_t,
    date_of_birth = p_date_of_birth,
    national_id = p_national_id,
    next_of_kin_name = p_next_of_kin_name,
    next_of_kin_contact = p_next_of_kin_contact
  where id = v_staff_id and school_id = v_school
  returning * into v_row;

  if v_row.id is null then raise exception 'Staff record not found'; end if;

  update public.profiles set name = trim(p_full_name), phone = p_phone
  where id = auth.uid();

  return v_row;
end;
$$;
grant execute on function public.staff_update_own_profile(text, text, text, date, text, text, text) to authenticated;
