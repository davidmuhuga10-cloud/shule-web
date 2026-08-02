# Upgrading your live Shule project to multi-tenant (Phase 0)

This is the one-time upgrade that turns your single-school Shule deployment
into a platform that can host **any number of schools** on the same
Supabase project and Netlify site — the foundation the rest of
`PRODUCT_ROADMAP.md` builds on. You confirmed no school is actively using
the system yet, which is exactly the case this migration was written for:
there is exactly one school's worth of data (your own admin login, and
whatever you've entered so far) to carry over, not a live customer cutover.

Nothing about how the app looks changes — same theme, same colours, same
navigation. What changes: every school's data is now isolated from every
other school's by Postgres itself, logging in asks for a **School Code** in
addition to your email/admission number, and a **"Create your school's
account"** link lets a brand-new school sign itself up without you doing
anything by hand.

## Before you start

In the Supabase dashboard: **Database → Backups**, and take a manual backup
(or just note that on the free tier, Supabase keeps automatic daily
backups — either way, get a timestamp you could restore to if needed). This
migration is additive and was verified against a local Postgres instance
with the same "already deployed, one admin, some data" shape as your
project, but it's still a real schema change to a live database — the same
good habit as before any migration.

## Step 1 — Run the migration SQL

1. Open your Supabase project → **SQL Editor**.
2. Open `supabase/migrations/0002_multi_tenant.sql` from this project, copy
   its entire contents, paste into a new SQL Editor query, and run it.
3. It should finish with no errors, and the last thing it prints (in the
   **Results/Messages** pane, as `NOTICE`s) looks like:

   ```
   NOTICE:  =====================================================================
   NOTICE:  Migration complete. Your School Code is: my-school  (school name: My School)
   NOTICE:  Use this code in the "School Code" field on the Shule login screen.
   NOTICE:  =====================================================================
   ```

   **Write down that School Code** — it's derived automatically from
   whatever your `school_name` setting already was (falls back to
   "myschool" if you hadn't set one). You (and anyone else at your school)
   will type this on the login screen from now on.

Don't have a `school_name` set yet, or want a different code than the one
it picked? Change it any time afterwards:

```sql
update public.schools set code = 'your-preferred-code' where code = 'the-one-it-picked';
```

(Codes are lowercase letters/numbers/hyphens only, 3-32 characters.)

## Step 2 — Deploy the updated frontend

The code in this delivery already has the multi-tenant frontend changes
(the School Code field, the sign-up screen, the school-scoped student login
email rule). Push it to your GitHub repo the same way as before — Netlify's
existing auto-deploy will pick it up:

```
git add -A
git commit -m "Upgrade to multi-tenant (Phase 0)"
git push
```

No new Netlify environment variables are needed — `SUPABASE_URL` and
`SUPABASE_SERVICE_ROLE_KEY` are unchanged, and `src/lib/config.js` still
points at the same one Supabase project (that's the whole point: one
project now serves every school).

## Step 3 — Sign in and confirm

Once Netlify finishes deploying, open your site. The login screen now has a
**School Code** field above the email/admission-number field. Enter the
code from Step 1, your existing admin email and password, and sign in as
usual — everything you had before (classes, students, settings, etc.) is
still there, just now tagged as belonging to your school.

## Step 4 — Try self-serve signup (optional, recommended)

Click **"Create your school's account"** on the login screen and create a
throwaway test school (its own name, code, admin email, password). It
should create the account and sign you straight in as that school's admin,
seeded with the default CBC subjects and grading scale. This proves the
whole self-serve path — the thing that lets Shule grow beyond your own
school — actually works end to end on your live project. There's no
"delete a school" button in the app yet (that's expected, deliberately
scoped out for now per `PRODUCT_ROADMAP.md`'s "what we're not building yet"
list) — if you want to remove the test school afterwards, run this in the
SQL editor:

```sql
-- Replace 'test-school-code' with whatever code you used above.
delete from auth.users where id in (
  select id from public.profiles where school_id = (select id from public.schools where code = 'test-school-code')
);
delete from public.schools where code = 'test-school-code'; -- cascades to every table for that school
```

## What actually changed, for the curious

- New `schools` table — one row per school, with a unique `code`.
- Every existing table (`staff`, `students`, `classes`, `exams`, `results`,
  `settings`, etc.) got a `school_id` column, backfilled to your one
  existing school, then locked to `NOT NULL` with a foreign key.
- A `current_school_id()` helper and an auto-stamping trigger, so every
  insert your admin/teacher screens already make gets tagged with the right
  school automatically — **none of the application's data-access code
  (`src/lib/api/*.mjs`) had to change** for this.
- Every Row-Level Security policy now also requires
  `school_id = current_school_id()` — verified against a real local
  Postgres instance simulating two separate schools before this was handed
  to you: an admin from School A cannot read, insert into, update, or
  delete anything belonging to School B, and a student can only ever see
  their own record.
- Two new server-side pieces: `get_school_public_info()` (a public,
  anonymous-safe RPC the login screen uses to preview a school's name
  before anyone signs in) and `seed_school_defaults()` (used by the new
  `netlify/functions/school-signup.js` to seed a brand-new school with the
  same CBC subjects/grading scale you started with).
- `studentEmailFor()` (the admission-number → login-email translator) now
  takes the school's code as well, so two schools can each have a student
  numbered "23" without their synthetic logins colliding — this is a real
  constraint of sharing one Supabase Auth pool across every school, not a
  cosmetic change.

See `PRODUCT_ROADMAP.md` Section 3 and Section 7 (Phase 0) for the full
reasoning behind this design, and Section 6 for what's planned next on top
of it (capability-based staff permissions, a Parent account kind).
