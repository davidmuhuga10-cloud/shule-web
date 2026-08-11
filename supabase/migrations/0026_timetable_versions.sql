-- 0026_timetable_versions.sql
-- Round 5 §10 (timetable version history): instead of hard-deleting the
-- previous timetable on every regenerate, keep the last 3 generated
-- versions per (academic_year_id, term_id) around — deactivated, not
-- deleted — so a school can reactivate an older one if a fresh regenerate
-- turns out worse (a teacher unavailability change, a bad Constraint, etc).
--
-- No separate "versions" table: every row in timetable_entries already IS
-- one version's data. This just adds version_number (which generation a
-- row belongs to, per scope) and is_active (whether that generation is
-- currently "the" timetable people see/print/edit) directly onto the table
-- that already holds the data.
--
-- Existing rows all default to version_number=1, is_active=true, so this
-- upgrades in place with zero data loss and no manual backfill — a school
-- with an existing timetable just finds it's now "version 1, active".

alter table public.timetable_entries add column if not exists version_number integer not null default 1;
alter table public.timetable_entries add column if not exists is_active boolean not null default true;

create index if not exists idx_tt_entries_version_scope on public.timetable_entries(academic_year_id, term_id, version_number);

-- The 3 slot-uniqueness indexes from 0018_timetable.sql were scoped to
-- (year, term, day, period, stream/staff/room) — global for the whole
-- scope. That's wrong now that multiple versions' rows coexist in the same
-- scope: two DIFFERENT versions may legitimately place the same
-- stream/teacher/room in the same slot (that's the entire point of a
-- regenerate producing a different layout). Uniqueness now needs to be
-- scoped PER VERSION, not per whole scope.
drop index if exists public.idx_tt_entries_unique_stream_slot;
drop index if exists public.idx_tt_entries_unique_staff_slot;
drop index if exists public.idx_tt_entries_unique_room_slot;

create unique index idx_tt_entries_unique_stream_slot
  on public.timetable_entries(academic_year_id, term_id, version_number, day_of_week, period_index, stream_id);
create unique index idx_tt_entries_unique_staff_slot
  on public.timetable_entries(academic_year_id, term_id, version_number, day_of_week, period_index, staff_id) where staff_id is not null;
create unique index idx_tt_entries_unique_room_slot
  on public.timetable_entries(academic_year_id, term_id, version_number, day_of_week, period_index, room_id) where room_id is not null;

-- Note: "only one active version per scope" is an app-level invariant
-- (Db.timetable.generate() / entries.reactivateVersion() always deactivate
-- before activating), the same way several other multi-step invariants in
-- this schema are enforced in the API layer rather than as a DB constraint
-- — a genuine cross-row "at most one TRUE per group" rule needs a trigger
-- to express in SQL, which is more machinery than this warrants.
