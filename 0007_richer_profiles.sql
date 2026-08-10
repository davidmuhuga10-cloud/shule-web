-- ============================================================================
-- 0007_richer_profiles.sql — Phase 2c (school side): richer student & staff
-- bio-data fields, feeding the new printouts (merit list, transcript, leaving
-- certificate) built alongside this migration.
--
-- Deliberately does NOT add a photo field. There's no Supabase Storage
-- bucket wired up in this project yet (only precedent for images today is
-- the school logo in schoolSettings.mjs, which base64-encodes a small
-- resized thumbnail directly into a per-school settings row — fine for ONE
-- row per school, but doing the same per-student/per-staff would bloat
-- every list query by tens of KB per row for potentially hundreds of rows).
-- The right fix is a proper Storage bucket + RLS policies, which is new
-- infrastructure this project has never exercised and can't be verified
-- against a real Supabase project from this sandbox the same rigorous way
-- every other migration here has been (local Postgres has no `storage`
-- schema). Rather than ship unverified Storage RLS, photos are deferred to
-- their own dedicated, separately-verified pass — see PRODUCT_ROADMAP.md.
--
-- Every column below is a plain, nullable text/date column — no enum
-- hazards, no new tables, nothing that needs splitting across a
-- transaction. Safe to run as a single paste in the SQL Editor.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- students: UPI/assessment numbers (NEMIS/KNEC), guardian detail beyond a
-- bare name+contact, previous-school info (useful when a student transfers
-- IN), medical notes, and date of birth.
-- ----------------------------------------------------------------------------
alter table public.students add column if not exists date_of_birth date;
alter table public.students add column if not exists admission_date date;      -- when they joined this school — feeds the leaving certificate
alter table public.students add column if not exists upi_number text;          -- NEMIS Unique Personal Identifier
alter table public.students add column if not exists assessment_number text;   -- KNEC/CBC assessment number
alter table public.students add column if not exists previous_school text;
alter table public.students add column if not exists guardian_relationship text; -- e.g. Mother, Father, Guardian
alter table public.students add column if not exists guardian_id_number text;
alter table public.students add column if not exists medical_notes text;       -- allergies/conditions, freeform

-- ----------------------------------------------------------------------------
-- staff: TSC number, national ID, date of birth, next of kin — standard
-- Kenyan school HR record-keeping fields.
-- ----------------------------------------------------------------------------
alter table public.staff add column if not exists date_of_birth date;
alter table public.staff add column if not exists national_id text;
alter table public.staff add column if not exists tsc_number text;
alter table public.staff add column if not exists next_of_kin_name text;
alter table public.staff add column if not exists next_of_kin_contact text;

-- Nothing to backfill — every new column is nullable and defaults to null
-- for all existing rows, which is exactly the right "unknown, fill in when
-- convenient" state for data that predates this migration.
