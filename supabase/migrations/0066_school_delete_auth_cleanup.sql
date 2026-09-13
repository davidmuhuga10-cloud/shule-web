-- 0066_school_delete_auth_cleanup.sql
-- ----------------------------------------------------------------------------
-- Live feedback: manually deleting a school (Chogoria Academy, a duplicate
-- Morning Glory) left every one of its Supabase Auth accounts behind —
-- `delete from public.schools` cascades cleanly through every app table
-- (see 0035's admin_delete_school/admin_purge_expired_deleted_schools), but
-- auth.users is a separate schema with nothing wiring it to school_id at
-- all, so those logins just become orphaned. Cleaning them up meant opening
-- Authentication > Users and deleting each one by hand — fine for a demo
-- school with a handful of accounts, completely unworkable for a real
-- school with hundreds or thousands of students once this scales ("imagine
-- a school with 5000 students requests for a deletion").
--
-- Fix: every hard-delete path for a school (the 30-day purge sweep AND a
-- new immediate "delete now" for Super Admin) now also deletes every one
-- of that school's auth.users rows in the SAME transaction, via one shared
-- internal function — postgres already has DELETE privilege on auth.users
-- in this project (verified: has_table_privilege('postgres','auth.users',
-- 'DELETE') = true, same role these RPCs run as), and auth.users' own
-- child tables (identities, sessions, refresh_tokens, mfa factors, etc.)
-- already cascade from auth.users.id, so one delete there is enough — no
-- Auth Admin API call needed. profiles.id also references auth.users(id)
-- on delete cascade, so deleting the auth user removes its profile too;
-- deleting the school afterward cascades away everything else (students,
-- staff, finance, timetable...) exactly as before.
-- ----------------------------------------------------------------------------

create or replace function public.admin_hard_delete_school_internal(p_school_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  -- Not a public entry point (no is_super_admin() check here) — both
  -- callers below already gate on it before reaching this. Keep the
  -- "collect the auth ids, delete auth.users, then delete the school" body
  -- in exactly one place so neither call path can drift out of sync.
  delete from auth.users where id in (select id from public.profiles where school_id = p_school_id);
  delete from public.schools where id = p_school_id;
end;
$$;

-- Same 30-day sweep as before, now routed through the shared cleanup so a
-- purge also takes the expired school's logins with it.
create or replace function public.admin_purge_expired_deleted_schools()
returns integer
language plpgsql security definer set search_path = public
as $$
declare
  v_count integer := 0;
  v_id uuid;
begin
  if not public.is_super_admin() then raise exception 'Not authorized' using errcode = '42501'; end if;
  for v_id in
    select id from public.schools where deleted_at is not null and deleted_at < now() - interval '30 days'
  loop
    perform public.admin_hard_delete_school_internal(v_id);
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

-- Live feedback ("a demo school, delete everything"): an immediate,
-- no-waiting hard delete — same typed-confirmation safety as
-- admin_delete_school, but only ever callable on a school that's ALREADY
-- soft-deleted (deleted_at is not null). That ordering is deliberate: the
-- normal "Delete school" button (admin_delete_school, unchanged by this
-- migration) is still the only way to start deleting a LIVE school, and it
-- stays a reversible soft-delete either way. This is the second step —
-- "don't make me wait 30 days for the purge sweep, I'm sure" — for a
-- school that's already sitting in the deleted/recoverable list.
create or replace function public.admin_hard_delete_school_now(p_school_id uuid, p_confirm_name text)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_name text;
begin
  if not public.is_super_admin() then raise exception 'Not authorized' using errcode = '42501'; end if;
  select name into v_name from public.schools where id = p_school_id and deleted_at is not null;
  if not found then raise exception 'School not found (it must already be soft-deleted — use "Delete school" first)'; end if;
  if trim(p_confirm_name) <> trim(v_name) then
    raise exception 'Typed name does not match the school name exactly — nothing was deleted.';
  end if;

  insert into public.admin_audit_log (actor, action, target_school_id, details)
    values (auth.uid(), 'hard_delete_school_now', p_school_id, jsonb_build_object('name', v_name));

  perform public.admin_hard_delete_school_internal(p_school_id);
end;
$$;

grant execute on function public.admin_hard_delete_school_now(uuid, text) to authenticated;
