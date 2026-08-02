# Shule — Frontend (Phase 3, complete)

This is the actual app running on Supabase + Netlify — a real, static,
no-build-step SPA (plain HTML/CSS/JS, ES modules) that talks to Supabase
directly via `supabase-js`, secured by the Row-Level Security policies from
Phase 1.

## What's working

Every screen referenced in the navigation is now fully built and wired up —
there are no "coming soon" placeholders left. In the order they appear for an
admin:

- **Sign-in** (staff/admin by email, student by admission number), session
  handling, change-password, sign-out.
- **Dashboard** — stats, gender split, per-class counts, setup checklist.
- **Academic Calendar** — years + terms (single active year/term enforced).
- **Classes & Streams** — inline stream management.
- **Subjects** — CBC list ("Load CBC subjects") + custom subjects.
- **Students** — list/filter by class+stream, add/edit/delete; creating a
  student auto-provisions their login and shows the default password.
- **Bulk Upload** — paste or upload a CSV, preview with per-row validation,
  import, then auto-provision a login for every newly created student.
- **Staff** — list/add/edit/delete, with an optional "grant admin access"
  toggle when creating a new staff login.
- **Class Subjects** — tick which subjects each class offers (every stream
  of that class inherits them automatically).
- **Teacher Assignments** — who teaches what, in which class/stream.
- **Grading Scales** — configure score → letter-grade bands; one scale is
  the default used for grading.
- **Exams** — set up assessment events per academic year/term.
- **Enter Marks** — per exam/class/stream/subject entry grid with live
  client-side range validation.
- **Mark List** (broadsheet) — students × subjects matrix with totals,
  average, and tie-aware class position, printable.
- **Report Forms** — per-student report card (computed server-side via the
  `get_report_card()` RPC, since a student's own session can't read
  classmates' scores to rank itself), printable.
- **Class List** — printable class register with toggleable columns.
- **School Settings** — school name/motto/contact details + logo upload
  (client-side resized before saving).
- **User Accounts** — reset a password or disable/enable any login.
- **My Results** — the student-facing view of their own report cards.

Every screen above (both the data layer and the DOM/interaction layer) is
verified: 136 unit tests (`npm test`) against a mocked Supabase client for
every data-access module, plus a full Playwright browser run clicking
through every screen as both an admin and a student session with zero
console/page errors.

## One-time setup

1. **Run the database.** If you haven't already, follow
   `supabase/SETUP_GUIDE.md` (schema.sql, seed.sql, first admin). If you
   *did* already run Phase 1's schema.sql on a live project, also run
   `supabase/MIGRATION_if_already_applied.sql` — a few columns changed shape
   since then (details in that file).
2. **Fill in `src/lib/config.js`** with your Supabase project's URL and anon
   key (Project Settings → API in the Supabase dashboard). The anon key is
   safe to expose in client code — RLS is what actually enforces access.
3. **Set the Netlify function's environment variables** (`SUPABASE_URL`,
   `SUPABASE_SERVICE_ROLE_KEY`) as covered in `netlify/functions/README.md` —
   needed for creating student/staff logins.

## Previewing locally

No build step is required to run the site — it's static files. From the
project root:

```
python3 -m http.server 8080
```

then open `http://localhost:8080/index.html`. (The Netlify function won't
run under a plain static server — for that, use `npx netlify dev` once you
have the Netlify CLI set up, covered in the Phase 4 deployment guide.)

## Running the tests

```
npm install
npm test
```

Runs all 136 unit tests (admin-provision + every data-access module) against
mocked clients — no live Supabase project needed.

## The one dependency, vendored not CDN-loaded

`src/vendor/supabase-js.esm.js` is a pre-built bundle of `@supabase/supabase-js`,
generated once with esbuild — the app has zero runtime dependency on a
third-party CDN staying up. See `src/vendor/README.md` if you ever want to
upgrade the library version.

## What's next

The app is feature-complete for this build. The remaining step is putting it
on the public internet — see **`DEPLOYMENT_GUIDE.md`** for the full Netlify
deployment walkthrough (Git setup, environment variables, verifying the live
site, troubleshooting).
