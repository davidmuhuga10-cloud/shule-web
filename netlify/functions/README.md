# admin-provision — the one privileged endpoint

This function is where the Supabase **service_role** key lives (never in the
browser). It requires the caller to already hold a valid Supabase session for
an **active admin** — verified server-side against the `profiles` table on
every call — before it will touch anything.

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

Students only ever type their admission number. Before calling
`supabase.auth.signInWithPassword()`, the frontend must translate it using
the exact same rule as `_lib/studentLogin.js`'s `studentEmailFor()`:

```js
function studentEmailFor(admissionNo) {
  const slug = String(admissionNo || '').trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return (slug || 'student') + '@students.shule.internal';
}
```

## Re-running the tests

`npm install && npm test` from the project root runs all 29 tests (in
`tests/admin-provision.test.js`) against a mocked `admin.auth`/`admin.from()`
client — no live Supabase project needed.
