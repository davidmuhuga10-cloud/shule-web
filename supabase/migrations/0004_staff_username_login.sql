-- ============================================================================
-- Shule — Migration 0004: username/phone login for admins & teachers
-- ============================================================================
-- Run this as ONE query in the Supabase SQL Editor (unlike 0003a/0003b, this
-- one is safe to run as a single paste — nothing here adds a new enum value,
-- so there's no "unsafe use of new value" transaction hazard to split around).
--
-- What changes:
--   - Admins/teachers no longer sign in with their real email address. They
--     sign in with a short username (their first name, e.g. "mercy") OR their
--     phone number, combined with their School Code in one field
--     ("mercy@tumaini" or "0712345678@tumaini") — see splitLoginUsername() in
--     studentEmail.shared.js and resolve_staff_login_email() below.
--   - Existing admin/teacher accounts are backfilled automatically by this
--     migration: each gets an auto-assigned username (their first name, with
--     a number appended if another staff member at the same school already
--     has it), and their sign-in identity is switched to match. Their
--     PASSWORD does not change — only what they type as their "email" does.
--   - Students are NOT touched — that login is frozen for now.
--   - Parents are NOT touched by this file — a separate change (0005) makes
--     a parent's password their linked child's admission number.
--
-- IMPORTANT — read this before running:
--   Once this runs, every existing admin/teacher's OLD real-email login stops
--   working immediately (Supabase Auth only holds one email per account, and
--   this migration overwrites it). This script prints each account's new
--   username to the Messages panel — write those down before closing SQL
--   Editor. Test the NEW login in a private/incognito window WITHOUT closing
--   your current logged-in tab first, so if anything looks wrong you're not
--   locked out while we fix it.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. New columns + per-school uniqueness (partial indexes — students/parents
--    never set these, so they don't collide with each other on null=null).
-- ----------------------------------------------------------------------------
alter table public.profiles add column if not exists username text;
alter table public.profiles add column if not exists phone text;
create unique index if not exists idx_profiles_username_per_school on public.profiles(school_id, username) where username is not null;
create unique index if not exists idx_profiles_phone_per_school on public.profiles(school_id, phone) where phone is not null;

-- ----------------------------------------------------------------------------
-- 2. resolve_staff_login_email RPC — see the header comment in schema.sql's
--    copy of this function for the full reasoning. Anonymous-safe by design:
--    returns only a matching synthetic email (or nothing), never who exists.
-- ----------------------------------------------------------------------------
create or replace function public.resolve_staff_login_email(p_school_code text, p_identifier text)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select p.email
  from public.profiles p
  join public.schools s on s.id = p.school_id
  where s.code = lower(trim(coalesce(p_school_code, '')))
    and s.status = 'active'
    and p.role in ('admin', 'teacher')
    and p.status = 'active'
    and (p.username = lower(trim(coalesce(p_identifier, ''))) or p.phone = trim(coalesce(p_identifier, '')))
  limit 1;
$$;
grant execute on function public.resolve_staff_login_email(text, text) to anon, authenticated;

-- ----------------------------------------------------------------------------
-- 3. Backfill: assign a username (+ switch the Auth login identity) to every
--    EXISTING admin/teacher profile that doesn't have one yet. Also copies
--    each teacher's phone from their `staff` record onto `profiles.phone`,
--    where one is on file, so the phone-login path works immediately for
--    anyone who already has a phone number saved.
-- ----------------------------------------------------------------------------
do $$
declare
  r record;
  v_base text;
  v_candidate text;
  v_suffix int;
  v_school_code text;
  v_new_email text;
  v_old_email text;
begin
  for r in
    select p.id, p.name, p.email, p.school_id, p.staff_id
    from public.profiles p
    where p.role in ('admin', 'teacher') and p.username is null
  loop
    v_base := lower(regexp_replace(trim(split_part(trim(r.name), ' ', 1)), '[^a-zA-Z0-9]+', '-', 'g'));
    v_base := trim(both '-' from v_base);
    if v_base = '' then v_base := 'staff'; end if;

    v_candidate := v_base;
    v_suffix := 1;
    while exists (
      select 1 from public.profiles
      where school_id = r.school_id and username = v_candidate
    ) loop
      v_suffix := v_suffix + 1;
      v_candidate := v_base || v_suffix::text;
    end loop;

    select code into v_school_code from public.schools where id = r.school_id;
    v_new_email := v_candidate || '@' || v_school_code || '.staff.shule.internal';
    v_old_email := r.email;

    update public.profiles set username = v_candidate, email = v_new_email where id = r.id;
    update auth.users set email = v_new_email where id = r.id;

    -- Best-effort: carry over a phone number already on file for this
    -- person's staff record (teachers only — the bootstrap admin has no
    -- linked staff row, so has no phone to carry over here).
    if r.staff_id is not null then
      update public.profiles set phone = s.phone
        from public.staff s
        where public.profiles.id = r.id and s.id = r.staff_id and s.phone is not null and trim(s.phone) <> '';
    end if;

    raise notice 'Migrated profile % (%): old login email was %, new username is "%" (new login: %@school-code)',
      r.id, r.name, v_old_email, v_candidate, v_candidate;
  end loop;
end $$;

do $$ begin
  raise notice '=====================================================================';
  raise notice 'Migration 0004 complete. Every admin/teacher above has a new username';
  raise notice '(shown next to their name) — write these down. Their PASSWORD has not';
  raise notice 'changed. Going forward, sign in with username@schoolcode (or, if a';
  raise notice 'phone number was on file, phone@schoolcode also works) instead of a';
  raise notice 'real email address.';
  raise notice '=====================================================================';
end $$;
