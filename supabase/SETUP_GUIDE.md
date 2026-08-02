# Shule — Supabase backbone (Phase 1)

This is the first phase of moving Shule off Google Apps Script/Sheets onto
**Supabase (Postgres + Auth + Row-Level Security)** for the database, and
**Netlify** for hosting. This phase delivers the database only — schema,
security rules, and reference data. The frontend (the actual screens you use
day to day) is the next phase; see "What's next" at the bottom.

Everything here was tested against a real local Postgres instance before
delivery: every table, every RLS policy, and the numeric admission-number
sort were exercised as an actual `admin`, `teacher`, and `student` session
(and as a logged-out visitor) to confirm each role sees exactly what it
should and nothing more.

## 1. Create your Supabase project

1. Go to supabase.com and create a free project (pick a region close to
   Kenya, e.g. one of the EU regions, for the best latency).
2. Save these from **Project Settings → API** — you'll need them for the
   frontend later: **Project URL**, **anon public key**, and (kept secret,
   server-side only) the **service_role key**.

## 2. Run the schema

In the Supabase dashboard, open **SQL Editor** and run, in this exact order:

1. `schema.sql` — creates every table (staff, academic_years, terms, classes,
   streams, subjects, students, profiles, assignments, grading, exams,
   results, settings), the numeric admission-number sort helper, and all
   Row-Level Security policies.
2. `seed.sql` — loads the same reference data the Apps Script version
   shipped with: the 33 official CBC subjects (Pre-Primary, Lower Primary,
   Upper Primary, Junior Secondary), the default 12-band KCSE-style grading
   scale (A down to E), and blank school-settings rows (name, motto, P.O.
   Box, phone, email, logo).

Both files are safe to re-run — every insert is guarded, so running them
twice does not duplicate data.

## 3. Create your first admin login

Supabase Auth owns user accounts, so the very first login has to be created
through it rather than a plain SQL insert:

1. **Authentication → Users → Add user.** Use your real email (e.g.
   `admin@yourschool.ac.ke`), set a password, switch **Auto Confirm User**
   on. Copy the **User UID** it generates.
2. Back in the SQL editor:
   ```sql
   insert into public.profiles (id, name, email, role, status)
   values ('<paste the User UID here>', 'Administrator',
           'admin@yourschool.ac.ke', 'admin', 'active');
   ```

From then on, every other login (teachers and students) is created *from
inside the app* by the admin — same as the Apps Script version — once the
frontend is in place.

## 4. How roles work (mirrors the Apps Script version, enforced properly this time)

| Role | Can do |
|---|---|
| **admin** | Everything: manage staff, classes, streams, subjects, students, exams, results, grading scales, settings, and other user accounts. |
| **teacher** | Read classes/streams/subjects/students/staff; enter and edit exam results. Cannot change classes, subjects, staff records, or settings. |
| **student** | Read-only: their own student record and their own results only. Cannot see other students, staff, or anyone else's marks. |

The important upgrade over the Apps Script version: previously these rules
were only checked in the app's server code (`requireAuth_()`), which means a
bug there could have exposed data. Now they are enforced by Postgres itself
via Row-Level Security — even a direct database query bypassing the app
cannot violate them.

## 5. Why students and teachers don't log in with a Supabase-native email/password directly

Your original system let students log in with just their **admission
number** (password = admission number) and teachers with **their email**
(default password `teacher123`), both auto-provisioned on first login.
Supabase Auth is email/password-based, so the plan for the next phase is:

- **Staff/teachers**: log in with their real email — this maps directly,
  no change needed.
- **Students**: the frontend will map an admission number to an internal,
  synthetic email (e.g. `23@students.<yourschool>.internal`) behind the
  scenes, so from the student's point of view they still just type their
  admission number. Creating that hidden auth account requires Supabase's
  **service_role** key, which must never reach the browser — so this one
  privileged step runs in a small Netlify serverless function, not in
  client-side code. That function is part of the next phase.

## What's next

This phase is the database only. Still to come, in order:
1. The Netlify serverless function that provisions student/teacher logins
   using the service_role key safely (server-side only).
2. The frontend itself — an elevated version of the current Shule screens,
   talking to Supabase directly via `supabase-js`, with the same modules you
   already have (Students incl. Bulk Upload, Classes, Subjects/CBC, Staff,
   Assignments, Grading, Exams/Mark List/Report Forms/Class List, Academic
   Calendar, Settings incl. logo).
3. `netlify.toml` and the Netlify project setup/deploy guide.

A heads-up as your consultant on this move: Supabase's and Netlify's free
tiers have real limits (Supabase free projects pause after a week of no
API activity and cap database size/bandwidth; Netlify's free tier caps
build minutes and bandwidth) — unlike Apps Script, which is free
indefinitely on your own Google account. For a live school this is very
likely fine on the free tier initially, but worth planning for a paid tier
once you're in daily production use. We can size that properly once we get
to deployment.
