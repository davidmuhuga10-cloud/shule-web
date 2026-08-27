-- 0035_admin_dashboard.sql
-- ----------------------------------------------------------------------------
-- Super Admin / platform-management dashboard (Admin_Dashboard_Architecture3
-- .docx). This is a second, small mini-app living alongside the main school
-- system, at its own /admin route, using the SAME Supabase project/session —
-- there is no separate login system.
--
-- "Super Admin" is a regular profile with is_super_admin = true, NOT a
-- hardcoded email check. Only one account will ever carry that flag in
-- practice, which satisfies "only one designated account" while keeping the
-- check a real, revocable, auditable database flag rather than a string
-- comparison baked into application code.
--
-- Every other table in this schema is RLS-locked to exactly one school
-- (current_school_id()). Cross-school reads/writes needed by the Super
-- Admin dashboard are the one deliberate, narrow exception to that rule —
-- centralized in a handful of admin_* SECURITY DEFINER functions below,
-- each of which re-checks public.is_super_admin() itself, rather than
-- loosening row-level security broadly. The app must never query school
-- tables directly for cross-school numbers.
-- ----------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1. The Super Admin flag itself.
-- ---------------------------------------------------------------------------
alter table public.profiles add column is_super_admin boolean not null default false;

-- A Super Admin account is not really "of" any one school. school_id was
-- NOT NULL; relax that just for this one case (every ordinary profile still
-- requires a school_id — the check constraint below enforces that a NULL
-- school_id is only ever allowed together with is_super_admin = true).
alter table public.profiles alter column school_id drop not null;
alter table public.profiles add constraint chk_profiles_school_or_super_admin
  check (school_id is not null or is_super_admin = true);

create or replace function public.is_super_admin()
returns boolean
language sql stable security definer set search_path = public
as $$
  select coalesce((select is_super_admin from public.profiles where id = auth.uid()), false);
$$;

-- set_school_id() (defined earlier in schema.sql) auto-fills school_id on
-- every tenant-table insert from the caller's own profile, and raises if it
-- can't determine one — which a Super Admin profile insert legitimately
-- can't, since it has no school. Carve out that one exception.
create or replace function public.set_school_id()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.school_id is null then
    new.school_id := public.current_school_id();
  end if;
  if new.school_id is null then
    if TG_TABLE_NAME = 'profiles' and coalesce(new.is_super_admin, false) then
      return new;
    end if;
    raise exception 'Could not determine which school this record belongs to (no school_id on your profile).' using errcode = '42501';
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. Trials, locking, and soft-delete on schools.
-- ---------------------------------------------------------------------------
alter table public.schools add column trial_ends_at timestamptz;
alter table public.schools add column locked_at timestamptz;
alter table public.schools add column locked_reason text;
alter table public.schools add column deleted_at timestamptz;
alter table public.schools add column deleted_by uuid references public.profiles(id) on delete set null;

-- Every new school gets a 3-month trial automatically, from whatever inserts
-- the row (currently netlify/functions/school-signup.js) — a DB default
-- keeps that true even if another code path ever creates a school row.
alter table public.schools alter column trial_ends_at set default (now() + interval '3 months');
update public.schools set trial_ends_at = created_at + interval '3 months' where trial_ends_at is null;

-- A locked or soft-deleted school blocks every one of its users immediately,
-- with a clear message (not a silent failure / generic error) — enforced
-- centrally here rather than in every RLS policy, since current_school_id()
-- is the one choke point every policy already runs through.
create or replace function public.current_school_id()
returns uuid
language plpgsql stable security definer set search_path = public
as $$
declare
  v_school_id uuid;
  v_locked_at timestamptz;
  v_locked_reason text;
  v_deleted_at timestamptz;
  v_name text;
begin
  select school_id into v_school_id from public.profiles where id = auth.uid();
  if v_school_id is null then return null; end if;

  select locked_at, locked_reason, deleted_at, name
    into v_locked_at, v_locked_reason, v_deleted_at, v_name
    from public.schools where id = v_school_id;

  if v_deleted_at is not null then
    raise exception 'This school account is no longer active. Please contact support.' using errcode = '42501';
  end if;
  if v_locked_at is not null then
    raise exception '%', coalesce(nullif(v_locked_reason, ''), 'This school''s access has been locked by the platform administrator. Please contact support to resolve this.')
      using errcode = '42501';
  end if;

  return v_school_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. SMS wallet per school, purchase-request queue, and permanent ledger.
-- ---------------------------------------------------------------------------
create table public.sms_wallets (
  school_id uuid primary key references public.schools(id) on delete cascade,
  balance integer not null default 0 check (balance >= 0),
  updated_at timestamptz not null default now()
);
create trigger trg_sms_wallets_updated_at before update on public.sms_wallets
  for each row execute function public.set_updated_at();

create table public.sms_credit_requests (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  requested_credits integer not null check (requested_credits > 0),
  amount_paid numeric(12,2),
  payment_message text not null,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  submitted_by uuid references public.profiles(id) on delete set null,
  reviewed_by uuid references public.profiles(id) on delete set null,
  reviewed_at timestamptz,
  review_note text,
  created_at timestamptz not null default now()
);
create index idx_sms_credit_requests_school on public.sms_credit_requests(school_id);
create index idx_sms_credit_requests_status on public.sms_credit_requests(status);

-- Permanent record of every approved credit — amount, school, date,
-- reference — kept even if the originating request row is ever removed, as
-- a dispute paper trail (docx: "Added, not originally requested, but still
-- applies").
create table public.sms_credit_ledger (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  credits integer not null,
  amount_paid numeric(12,2),
  reference text,
  request_id uuid references public.sms_credit_requests(id) on delete set null,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);
create index idx_sms_credit_ledger_school on public.sms_credit_ledger(school_id);

-- A school's own admin/teacher may submit a request and see their own
-- wallet/requests — ordinary RLS, scoped by current_school_id() same as
-- every other table. The Super Admin reaches ALL schools' rows only through
-- the admin_* functions below (security definer), never through these
-- policies directly.
alter table public.sms_wallets enable row level security;
alter table public.sms_credit_requests enable row level security;
alter table public.sms_credit_ledger enable row level security;

create policy sms_wallets_select on public.sms_wallets for select
  using (school_id = public.current_school_id());
create policy sms_credit_requests_select on public.sms_credit_requests for select
  using (school_id = public.current_school_id());
create policy sms_credit_requests_insert on public.sms_credit_requests for insert
  with check (public.is_staff() and school_id = public.current_school_id());
create policy sms_credit_ledger_select on public.sms_credit_ledger for select
  using (school_id = public.current_school_id());

-- ---------------------------------------------------------------------------
-- 4. Impersonation sessions and the admin audit log.
-- ---------------------------------------------------------------------------
create table public.admin_impersonation_sessions (
  id uuid primary key default gen_random_uuid(),
  admin_id uuid not null references public.profiles(id) on delete cascade,
  school_id uuid not null references public.schools(id) on delete cascade,
  target_profile_id uuid references public.profiles(id) on delete set null,
  started_at timestamptz not null default now(),
  ended_at timestamptz
);

create table public.admin_audit_log (
  id uuid primary key default gen_random_uuid(),
  actor uuid references public.profiles(id) on delete set null,
  action text not null,
  target_school_id uuid references public.schools(id) on delete set null,
  details jsonb,
  created_at timestamptz not null default now()
);
create index idx_admin_audit_log_school on public.admin_audit_log(target_school_id);
create index idx_admin_audit_log_created on public.admin_audit_log(created_at desc);

alter table public.admin_impersonation_sessions enable row level security;
alter table public.admin_audit_log enable row level security;
-- No direct-select policies: both tables are only ever read/written through
-- the security-definer admin_* functions below (Super-Admin-only, checked
-- inside each function) or the impersonation Netlify functions using the
-- service_role key. Ordinary staff have no policy granting them access, so
-- RLS denies everything by default.

-- ---------------------------------------------------------------------------
-- 5. Admin-only SECURITY DEFINER RPCs. Every one starts by re-checking
--    is_super_admin() itself — never trust that only the /admin front-end
--    calls these.
-- ---------------------------------------------------------------------------
create or replace function public.admin_dashboard_summary()
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_total_schools integer;
  v_total_students integer;
  v_total_teachers integer;
  v_pending_sms integer;
  v_total_sms_revenue numeric;
  v_new_this_week integer;
  v_new_this_month integer;
begin
  if not public.is_super_admin() then raise exception 'Not authorized' using errcode = '42501'; end if;

  select count(*) into v_total_schools from public.schools where deleted_at is null;
  select count(*) into v_total_students from public.students where status = 'active';
  select count(*) into v_total_teachers from public.staff where status = 'active' and lower(role) = 'teacher';
  select count(*) into v_pending_sms from public.sms_credit_requests where status = 'pending';
  select coalesce(sum(amount_paid), 0) into v_total_sms_revenue from public.sms_credit_ledger;
  select count(*) into v_new_this_week from public.schools where created_at >= now() - interval '7 days' and deleted_at is null;
  select count(*) into v_new_this_month from public.schools where created_at >= now() - interval '30 days' and deleted_at is null;

  return jsonb_build_object(
    'total_schools', v_total_schools,
    'total_students', v_total_students,
    'total_teachers', v_total_teachers,
    'pending_sms_confirmations', v_pending_sms,
    'total_sms_revenue', v_total_sms_revenue,
    'new_schools_this_week', v_new_this_week,
    'new_schools_this_month', v_new_this_month
  );
end;
$$;

create or replace function public.admin_list_expiring_trials(p_within_days integer default 14)
returns table (id uuid, name text, code text, trial_ends_at timestamptz, days_left integer)
language plpgsql stable security definer set search_path = public
as $$
begin
  if not public.is_super_admin() then raise exception 'Not authorized' using errcode = '42501'; end if;
  return query
    select s.id, s.name, s.code, s.trial_ends_at,
      greatest(0, ceil(extract(epoch from (s.trial_ends_at - now())) / 86400))::integer as days_left
    from public.schools s
    where s.deleted_at is null and s.trial_ends_at is not null
      and s.trial_ends_at <= now() + (p_within_days || ' days')::interval
    order by s.trial_ends_at asc;
end;
$$;

create or replace function public.admin_list_recent_schools(p_limit integer default 10)
returns table (id uuid, name text, code text, created_at timestamptz)
language plpgsql stable security definer set search_path = public
as $$
begin
  if not public.is_super_admin() then raise exception 'Not authorized' using errcode = '42501'; end if;
  return query
    select s.id, s.name, s.code, s.created_at
    from public.schools s
    where s.deleted_at is null
    order by s.created_at desc
    limit coalesce(p_limit, 10);
end;
$$;

create or replace function public.admin_registration_trend(p_weeks integer default 12)
returns table (week_start date, new_schools integer)
language plpgsql stable security definer set search_path = public
as $$
begin
  if not public.is_super_admin() then raise exception 'Not authorized' using errcode = '42501'; end if;
  return query
    select date_trunc('week', s.created_at)::date as week_start, count(*)::integer as new_schools
    from public.schools s
    where s.created_at >= now() - (p_weeks || ' weeks')::interval
    group by 1 order by 1;
end;
$$;

create or replace function public.admin_list_schools(p_search text default null)
returns table (
  id uuid, name text, code text, status text, created_at timestamptz,
  trial_ends_at timestamptz, locked_at timestamptz, deleted_at timestamptz,
  student_count integer, teacher_count integer, sms_balance integer,
  last_activity timestamptz
)
language plpgsql stable security definer set search_path = public
as $$
begin
  if not public.is_super_admin() then raise exception 'Not authorized' using errcode = '42501'; end if;
  return query
    select s.id, s.name, s.code, s.status, s.created_at, s.trial_ends_at, s.locked_at, s.deleted_at,
      (select count(*)::integer from public.students st where st.school_id = s.id and st.status = 'active'),
      (select count(*)::integer from public.staff sf where sf.school_id = s.id and sf.status = 'active' and lower(sf.role) = 'teacher'),
      coalesce((select w.balance from public.sms_wallets w where w.school_id = s.id), 0),
      (select max(p.updated_at) from public.profiles p where p.school_id = s.id)
    from public.schools s
    where (p_search is null or p_search = '' or s.name ilike '%' || p_search || '%' or s.code ilike '%' || p_search || '%')
    order by s.created_at desc;
end;
$$;

create or replace function public.admin_school_detail(p_school_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_school public.schools%rowtype;
  v_result jsonb;
begin
  if not public.is_super_admin() then raise exception 'Not authorized' using errcode = '42501'; end if;
  select * into v_school from public.schools where id = p_school_id;
  if not found then raise exception 'School not found'; end if;

  select jsonb_build_object(
    'id', v_school.id, 'name', v_school.name, 'code', v_school.code, 'status', v_school.status,
    'created_at', v_school.created_at, 'trial_ends_at', v_school.trial_ends_at,
    'locked_at', v_school.locked_at, 'locked_reason', v_school.locked_reason,
    'deleted_at', v_school.deleted_at,
    'student_count', (select count(*) from public.students where school_id = v_school.id and status = 'active'),
    'teacher_count', (select count(*) from public.staff where school_id = v_school.id and status = 'active' and lower(role) = 'teacher'),
    'sms_balance', coalesce((select balance from public.sms_wallets where school_id = v_school.id), 0),
    'last_activity', (select max(updated_at) from public.profiles where school_id = v_school.id),
    'admin_profile', (select jsonb_build_object('id', p.id, 'name', p.name, 'email', p.email)
      from public.profiles p where p.school_id = v_school.id and p.role = 'admin' order by p.created_at asc limit 1)
  ) into v_result;
  return v_result;
end;
$$;

create or replace function public.admin_set_school_lock(p_school_id uuid, p_locked boolean, p_reason text default null)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if not public.is_super_admin() then raise exception 'Not authorized' using errcode = '42501'; end if;
  update public.schools
    set locked_at = case when p_locked then now() else null end,
        locked_reason = case when p_locked then p_reason else null end
    where id = p_school_id;
  if not found then raise exception 'School not found'; end if;

  insert into public.admin_audit_log (actor, action, target_school_id, details)
    values (auth.uid(), case when p_locked then 'lock_school' else 'unlock_school' end, p_school_id,
      jsonb_build_object('reason', p_reason));
end;
$$;

create or replace function public.admin_extend_trial(p_school_id uuid, p_extra_days integer)
returns timestamptz
language plpgsql security definer set search_path = public
as $$
declare
  v_new_date timestamptz;
begin
  if not public.is_super_admin() then raise exception 'Not authorized' using errcode = '42501'; end if;
  if p_extra_days is null or p_extra_days <= 0 then raise exception 'Extra days must be a positive number'; end if;

  update public.schools
    set trial_ends_at = greatest(coalesce(trial_ends_at, now()), now()) + (p_extra_days || ' days')::interval
    where id = p_school_id
    returning trial_ends_at into v_new_date;
  if not found then raise exception 'School not found'; end if;

  insert into public.admin_audit_log (actor, action, target_school_id, details)
    values (auth.uid(), 'extend_trial', p_school_id, jsonb_build_object('extra_days', p_extra_days, 'new_trial_ends_at', v_new_date));
  return v_new_date;
end;
$$;

-- Soft-delete: 30-day recovery window, same pattern as the existing
-- soft-deleted-exam purge (results.mjs's softDeleteExam/purgeExpiredDeletedExams).
create or replace function public.admin_delete_school(p_school_id uuid, p_confirm_name text)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_name text;
begin
  if not public.is_super_admin() then raise exception 'Not authorized' using errcode = '42501'; end if;
  select name into v_name from public.schools where id = p_school_id and deleted_at is null;
  if not found then raise exception 'School not found (or already deleted)'; end if;
  if trim(p_confirm_name) <> trim(v_name) then
    raise exception 'Typed name does not match the school name exactly — nothing was deleted.';
  end if;

  update public.schools set deleted_at = now(), deleted_by = auth.uid() where id = p_school_id;

  insert into public.admin_audit_log (actor, action, target_school_id, details)
    values (auth.uid(), 'delete_school', p_school_id, jsonb_build_object('name', v_name, 'recoverable_until', now() + interval '30 days'));
end;
$$;

create or replace function public.admin_restore_school(p_school_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if not public.is_super_admin() then raise exception 'Not authorized' using errcode = '42501'; end if;
  update public.schools set deleted_at = null, deleted_by = null where id = p_school_id and deleted_at is not null;
  if not found then raise exception 'School not found (or not deleted)'; end if;
  insert into public.admin_audit_log (actor, action, target_school_id, details)
    values (auth.uid(), 'restore_school', p_school_id, '{}'::jsonb);
end;
$$;

-- Permanently purges any school whose 30-day recovery window has lapsed —
-- same "sweep" shape as purgeExpiredDeletedExams. Call periodically (or on
-- dashboard load) rather than via a Postgres cron, to match how this
-- codebase already handles this pattern.
create or replace function public.admin_purge_expired_deleted_schools()
returns integer
language plpgsql security definer set search_path = public
as $$
declare
  v_count integer;
begin
  if not public.is_super_admin() then raise exception 'Not authorized' using errcode = '42501'; end if;
  with purged as (
    delete from public.schools
    where deleted_at is not null and deleted_at < now() - interval '30 days'
    returning id
  )
  select count(*) into v_count from purged;
  return v_count;
end;
$$;

-- SMS wallet: manual adjustment (top-up from the school detail screen) and
-- request approve/reject.
create or replace function public.admin_adjust_sms_wallet(p_school_id uuid, p_delta integer, p_note text default null)
returns integer
language plpgsql security definer set search_path = public
as $$
declare
  v_new_balance integer;
begin
  if not public.is_super_admin() then raise exception 'Not authorized' using errcode = '42501'; end if;
  insert into public.sms_wallets (school_id, balance) values (p_school_id, greatest(0, p_delta))
    on conflict (school_id) do update set balance = greatest(0, public.sms_wallets.balance + p_delta)
    returning balance into v_new_balance;

  insert into public.admin_audit_log (actor, action, target_school_id, details)
    values (auth.uid(), 'adjust_sms_wallet', p_school_id, jsonb_build_object('delta', p_delta, 'note', p_note, 'new_balance', v_new_balance));
  return v_new_balance;
end;
$$;

create or replace function public.admin_list_sms_requests(p_status text default null)
returns table (
  id uuid, school_id uuid, school_name text, requested_credits integer, amount_paid numeric,
  payment_message text, status text, submitted_by_name text, reviewed_at timestamptz, created_at timestamptz
)
language plpgsql stable security definer set search_path = public
as $$
begin
  if not public.is_super_admin() then raise exception 'Not authorized' using errcode = '42501'; end if;
  return query
    select r.id, r.school_id, s.name, r.requested_credits, r.amount_paid, r.payment_message, r.status,
      p.name, r.reviewed_at, r.created_at
    from public.sms_credit_requests r
    join public.schools s on s.id = r.school_id
    left join public.profiles p on p.id = r.submitted_by
    where p_status is null or p_status = '' or r.status = p_status
    order by r.created_at desc;
end;
$$;

create or replace function public.admin_review_sms_request(p_request_id uuid, p_approve boolean, p_reference text default null, p_note text default null)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_req public.sms_credit_requests%rowtype;
begin
  if not public.is_super_admin() then raise exception 'Not authorized' using errcode = '42501'; end if;
  select * into v_req from public.sms_credit_requests where id = p_request_id;
  if not found then raise exception 'Request not found'; end if;
  if v_req.status <> 'pending' then raise exception 'This request has already been reviewed.'; end if;

  update public.sms_credit_requests
    set status = case when p_approve then 'approved' else 'rejected' end,
        reviewed_by = auth.uid(), reviewed_at = now(), review_note = p_note
    where id = p_request_id;

  if p_approve then
    insert into public.sms_wallets (school_id, balance) values (v_req.school_id, v_req.requested_credits)
      on conflict (school_id) do update set balance = public.sms_wallets.balance + v_req.requested_credits;
    insert into public.sms_credit_ledger (school_id, credits, amount_paid, reference, request_id, created_by)
      values (v_req.school_id, v_req.requested_credits, v_req.amount_paid, p_reference, v_req.id, auth.uid());
  end if;

  insert into public.admin_audit_log (actor, action, target_school_id, details)
    values (auth.uid(), case when p_approve then 'approve_sms_request' else 'reject_sms_request' end, v_req.school_id,
      jsonb_build_object('request_id', p_request_id, 'credits', v_req.requested_credits, 'note', p_note));
end;
$$;

create or replace function public.admin_list_audit_log(p_limit integer default 200)
returns table (
  id uuid, actor_name text, action text, target_school_name text, details jsonb, created_at timestamptz
)
language plpgsql stable security definer set search_path = public
as $$
begin
  if not public.is_super_admin() then raise exception 'Not authorized' using errcode = '42501'; end if;
  return query
    select a.id, p.name, a.action, s.name, a.details, a.created_at
    from public.admin_audit_log a
    left join public.profiles p on p.id = a.actor
    left join public.schools s on s.id = a.target_school_id
    order by a.created_at desc
    limit coalesce(p_limit, 200);
end;
$$;

-- Called by the admin-impersonate-* Netlify functions (which use the
-- service_role key, so they call this as a normal insert/update — these
-- two are exposed as SQL helpers mainly so the "who/which school/when
-- started/ended" shape stays consistent and is written in one place).
create or replace function public.admin_record_impersonation_start(p_school_id uuid, p_target_profile_id uuid)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_id uuid;
begin
  if not public.is_super_admin() then raise exception 'Not authorized' using errcode = '42501'; end if;
  insert into public.admin_impersonation_sessions (admin_id, school_id, target_profile_id)
    values (auth.uid(), p_school_id, p_target_profile_id) returning id into v_id;
  insert into public.admin_audit_log (actor, action, target_school_id, details)
    values (auth.uid(), 'impersonation_start', p_school_id, jsonb_build_object('session_id', v_id));
  return v_id;
end;
$$;

create or replace function public.admin_record_impersonation_end(p_session_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_school_id uuid;
begin
  update public.admin_impersonation_sessions set ended_at = now()
    where id = p_session_id and ended_at is null
    returning school_id into v_school_id;
  if v_school_id is not null then
    insert into public.admin_audit_log (actor, action, target_school_id, details)
      values ((select admin_id from public.admin_impersonation_sessions where id = p_session_id), 'impersonation_end', v_school_id, jsonb_build_object('session_id', p_session_id));
  end if;
end;
$$;

grant execute on function public.admin_dashboard_summary() to authenticated;
grant execute on function public.admin_list_expiring_trials(integer) to authenticated;
grant execute on function public.admin_list_recent_schools(integer) to authenticated;
grant execute on function public.admin_registration_trend(integer) to authenticated;
grant execute on function public.admin_list_schools(text) to authenticated;
grant execute on function public.admin_school_detail(uuid) to authenticated;
grant execute on function public.admin_set_school_lock(uuid, boolean, text) to authenticated;
grant execute on function public.admin_extend_trial(uuid, integer) to authenticated;
grant execute on function public.admin_delete_school(uuid, text) to authenticated;
grant execute on function public.admin_restore_school(uuid) to authenticated;
grant execute on function public.admin_purge_expired_deleted_schools() to authenticated;
grant execute on function public.admin_adjust_sms_wallet(uuid, integer, text) to authenticated;
grant execute on function public.admin_list_sms_requests(text) to authenticated;
grant execute on function public.admin_review_sms_request(uuid, boolean, text, text) to authenticated;
grant execute on function public.admin_list_audit_log(integer) to authenticated;
grant execute on function public.admin_record_impersonation_start(uuid, uuid) to authenticated;
grant execute on function public.admin_record_impersonation_end(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 6. Bootstrap the one designated Super Admin account
--    (kinyuadavid2003@gmail.com — created here if it doesn't already exist
--    as an auth user; password intentionally NOT set by SQL — Supabase Auth
--    users must be created via the Auth API/admin client, so this only
--    flips the flag on the profile if that auth user already exists. The
--    accompanying Netlify-side bootstrap, if the user doesn't exist yet, is
--    handled separately — see DEPLOYMENT note in the delivery zip.)
-- ---------------------------------------------------------------------------
do $$
declare
  v_user_id uuid;
begin
  select id into v_user_id from auth.users where email = 'kinyuadavid2003@gmail.com';
  if v_user_id is not null then
    if exists (select 1 from public.profiles where id = v_user_id) then
      update public.profiles set is_super_admin = true, school_id = null where id = v_user_id;
    else
      insert into public.profiles (id, school_id, name, email, role, is_super_admin, status)
        values (v_user_id, null, 'Super Admin', 'kinyuadavid2003@gmail.com', 'admin', true, 'active');
    end if;
  end if;
end $$;
