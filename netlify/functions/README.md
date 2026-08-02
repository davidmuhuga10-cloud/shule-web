# Netlify Functions — the two privileged endpoints

Shule is multi-tenant: one Supabase project now serves every school, so every
one of these functions is careful about which tenant (`school_id`) a given
call is allowed to touch.

## admin-provision — provisioning logins for an EXISTING school

This function is where the Supabase **service_role** key lives (never in the
browser). It requires the caller to already hold a valid Supabase session for
an **active admin** — verified server-side against the `profiles` table on
every call — before it will touch anything. Every action is additionally
scoped to that admin's own `school_id` (resolved server-side, never trusted
from the request body) — this is what stops one school's admin from
resetting a password or disabling a login that belongs to a different
school, since the service_role key bypasses Row-Level Security entirely and
this scoping is the only thing standing in for it here.

Tested with 29 unit tests against a mocked Supabase client (auth checks,
idempotency, rollback-on-failure, password-floor enforcement, ban/unban) —
see the test notes at the bottom of this file for how to re-run them.

## Environment variables (set in Netlify: Site settings → Environment variables)

| Variable | Where to find it | Notes |
|---|---|---|
| `SUPABASE_URL` | Supabase → Project Settings → API | Same value the frontend uses. |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase → Project Settings → API | **Secret.** Only ever set as a Netlify function env var, never in frontend code or `VITE_`/public-prefixed vars. |

## Why this exists instead of "auto-provision on login"

The Apps Script version created a student/teacher login the first time
someone typed a plausible admission number or staff email at the sign-in
screen. That was reasonable for its simple custom auth, but doing the same
thing against Supabase Auth would mean exposing an *unauthenticated*
account-creation endpoint — a real hole, since anyone who knew (or guessed) a
real admission number could create a login for it before the real student
ever did.

Instead: **logins are provisioned by the admin, at the moment they create the
Student or Staff record** — not at first login. The frontend (Phase 3, next)
must call this function immediately after a successful student/staff save.

## Contract

`POST /.netlify/functions/admin-provision`
Header: `Authorization: Bearer <the calling admin's Supabase access_token>`
Body: JSON, see actions below. All responses are `{ ok: true, ... }` or
`{ ok: false, message }`.

| action | payload | what it does |
|---|---|---|
| `create_student` | `{ student_id, admission_no, full_name }` | Creates (or, if already provisioned, safely no-ops) a Supabase Auth user + linked `profiles` row for that student. Login email is derived from the admission number (`studentEmailFor()`); default password is `student-<admission_no>`. |
| `create_staff` | `{ staff_id, email, full_name, role }` (`role`: `'teacher'` \| `'admin'`) | Same, using the staff member's real email and default password `teacher123`. |
| `reset_password` | `{ profile_id, new_password? }` | Resets a login's password. Omit `new_password` to reset back to the deterministic default (same rule as above) — mirrors the old `resetUserPassword`. |
| `set_login_status` | `{ profile_id, status: 'active' \| 'inactive' }` | Disables/re-enables a login (e.g. when a student/teacher leaves), without deleting their historical records. |

### Example call from the frontend, right after creating a student

```js
const { data: { session } } = await supabase.auth.getSession();
const res = await fetch('/.netlify/functions/admin-provision', {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    authorization: `Bearer ${session.access_token}`
  },
  body: JSON.stringify({
    action: 'create_student',
    student_id: savedStudent.id,
    admission_no: savedStudent.admission_no,
    full_name: savedStudent.full_name
  })
});
const result = await res.json();
// result.defaultPassword — show this to the admin once, so they can hand it to the student.
```

### The student login screen must apply the same email rule

Students only ever type their admission number (plus, now, their **School
Code** — see below). Before calling `supabase.auth.signInWithPassword()`,
the frontend must translate it using the exact same rule as
`_lib/studentLogin.js`'s `studentEmailFor(admissionNo, schoolCode)`:

```js
function studentEmailFor(admissionNo, schoolCode) {
  const slug = (v) => String(v || '').trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug(admissionNo, 'student') + '@' + slug(schoolCode) + '.students.shule.internal';
}
```

The School Code has to be folded in because admission numbers are only
unique **within** a school, but this one Supabase project now serves every
school — two different schools can each have a student "23".

## school-signup — the ONE public, unauthenticated endpoint

This is where a brand-new school creates its own tenant: a `schools` row, a
first admin login, and a set of sensible defaults (CBC subjects, default
grading scale, default settings) via the `seed_school_defaults()` SQL
function. It's public by necessity — there's no admin session to check yet
for a school that doesn't exist yet — so it validates carefully (unique
School Code, valid email, 6+ char password) and rolls back anything it
already created if a later step fails, so a failed signup never leaves an
orphaned half-created school behind.

`POST /.netlify/functions/school-signup`
Body: `{ school_name, school_code, admin_name, admin_email, password }`
Response: `{ ok: true, school_code, school_name, admin_email, seeded }` or
`{ ok: false, message }`.

No CAPTCHA/rate-limiting yet — see `PRODUCT_ROADMAP.md`'s Phase 0 notes for
why that's a deliberate, revisit-later call rather than an oversight.

## Re-running the tests

`npm install && npm test` from the project root runs every test, including
`tests/admin-provision.test.js` and `tests/school-signup.test.js`, against
mocked `admin.auth`/`admin.from()` clients — no live Supabase project
needed. There's also a real-browser smoke test for the login/signup screens
at `tests/e2e/multitenant.e2e.mjs` (see the comment at the top of that file
for how to run it).
