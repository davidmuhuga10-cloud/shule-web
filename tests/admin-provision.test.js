/**
 * Unit tests for netlify/functions/admin-provision.js and _lib/supabaseAdmin.js
 * against a mock Supabase client (no live project needed).
 *
 * Multi-tenancy note: every provisioning action now takes a `schoolId`
 * (the calling admin's own school, resolved server-side via requireAdmin())
 * and every insert/lookup must be scoped by it — these tests cover both the
 * happy path AND the cross-tenant rejection cases, since a bug there would
 * be a real privilege-escalation hole (service_role bypasses RLS entirely).
 */
const { studentEmailFor, studentPasswordFor, DEFAULT_TEACHER_PASSWORD } =
  require('../netlify/functions/_lib/studentLogin.js');
const { requireAdmin } = require('../netlify/functions/_lib/supabaseAdmin.js');
const {
  createStudentLogin, createStaffLogin, resetPassword, setLoginStatus
} = require('../netlify/functions/admin-provision.js');

let passed = 0, failed = 0;
function check(name, cond) {
  if (cond) { passed++; }
  else { failed++; console.error('FAIL:', name); }
}

const SCHOOL_A = 'school-a';
const SCHOOL_B = 'school-b';

/** Builds a fresh mock admin client with in-memory tables + auth. */
function mockAdmin(opts) {
  opts = opts || {};
  const tables = {
    profiles: [],
    students: [{ id: 'stu-1', admission_no: '5' }],
    schools: [{ id: SCHOOL_A, code: 'alpha', name: 'Alpha School' }, { id: SCHOOL_B, code: 'beta', name: 'Beta School' }],
    ...opts.tables
  };
  const authUsers = opts.authUsers || {}; // token -> user
  let nextUid = 1;
  const bannedUsers = {};

  function builderFor(table) {
    return {
      _filters: [],
      select() { return this; },
      eq(col, val) { this._filters.push([col, val]); return this; },
      async maybeSingle() {
        const rows = tables[table] || [];
        const hit = rows.find(r => this._filters.every(([c, v]) => String(r[c]) === String(v)));
        return { data: hit || null, error: null };
      },
      async insert(obj) {
        if (opts.forceInsertError && table === 'profiles') {
          return { error: { message: 'forced insert failure' } };
        }
        tables[table] = tables[table] || [];
        tables[table].push(obj);
        return { error: null };
      },
      update(patch) {
        return {
          _filters: [],
          eq(col, val) { this._filters.push([col, val]); return this; },
          then: undefined,
          async run() {
            const rows = tables[table] || [];
            let touched = 0;
            rows.forEach(r => {
              if (this._filters.every(([c, v]) => String(r[c]) === String(v))) { Object.assign(r, patch); touched++; }
            });
            return { error: null, count: touched };
          }
        };
      }
    };
  }

  // `.update(patch).eq(a,b).eq(c,d)` needs to actually resolve like a
  // thenable once every .eq() is chained — wrap update() so its returned
  // object is awaitable directly after the last .eq(), matching real
  // supabase-js ergonomics (`await q.update(p).eq(...).eq(...)`).
  function builderForWithAwaitableUpdate(table) {
    const base = builderFor(table);
    const origUpdate = base.update.bind(base);
    base.update = (patch) => {
      const chain = origUpdate(patch);
      const eqOrig = chain.eq.bind(chain);
      chain.eq = (...args) => { eqOrig(...args); return makeAwaitable(chain); };
      return chain;
    };
    return base;
  }
  function makeAwaitable(chain) {
    chain.then = (resolve) => chain.run().then(resolve);
    return chain;
  }

  return {
    _tables: tables,
    _bannedUsers: bannedUsers,
    from(table) { return builderForWithAwaitableUpdate(table); },
    auth: {
      async getUser(token) {
        const user = authUsers[token];
        return user ? { data: { user }, error: null } : { data: null, error: { message: 'invalid token' } };
      },
      admin: {
        async createUser({ email, password }) {
          if (String(password).length < 6) return { data: null, error: { message: 'Password too short' } };
          const id = 'uid-' + (nextUid++);
          return { data: { user: { id, email } }, error: null };
        },
        async deleteUser(id) { return { error: null }; },
        async updateUserById(id, patch) {
          if (patch.ban_duration) bannedUsers[id] = patch.ban_duration !== 'none';
          return { data: {}, error: null };
        }
      }
    }
  };
}

(async () => {
  // ---- studentEmailFor / studentPasswordFor -------------------------------
  check('studentEmailFor slugifies admission no + folds in school code', studentEmailFor('23', 'alpha') === '23@alpha.students.shule.internal');
  check('studentEmailFor handles short/odd chars', studentEmailFor('A-9', 'Alpha') === 'a-9@alpha.students.shule.internal');
  check('studentEmailFor falls back admission no on empty', studentEmailFor('', 'alpha') === 'student@alpha.students.shule.internal');
  check('studentEmailFor throws without a school code', (() => {
    try { studentEmailFor('23'); return false; } catch (e) { return true; }
  })());
  check('studentEmailFor keeps two schools\' identical admission numbers distinct', studentEmailFor('1', 'alpha') !== studentEmailFor('1', 'beta'));
  check('studentPasswordFor meets 6-char floor for a 1-digit admission no',
    studentPasswordFor('5').length >= 6 && studentPasswordFor('5') === 'student-5');
  check('DEFAULT_TEACHER_PASSWORD meets 6-char floor', DEFAULT_TEACHER_PASSWORD.length >= 6);

  // ---- requireAdmin --------------------------------------------------------
  {
    const admin = mockAdmin({
      authUsers: { 'good-admin-token': { id: 'admin-1' } },
      tables: { profiles: [{ id: 'admin-1', role: 'admin', status: 'active', school_id: SCHOOL_A }] }
    });
    const res = await requireAdmin({ headers: { authorization: 'Bearer good-admin-token' } }, admin);
    check('requireAdmin accepts a valid active admin', res.user.id === 'admin-1');
    check('requireAdmin returns the admin\'s school_id', res.profile.school_id === SCHOOL_A);
  }
  {
    const admin = mockAdmin({ authUsers: {}, tables: { profiles: [] } });
    let threw = false, code = null;
    try { await requireAdmin({ headers: {} }, admin); } catch (e) { threw = true; code = e.statusCode; }
    check('requireAdmin rejects missing bearer token (401)', threw && code === 401);
  }
  {
    const admin = mockAdmin({
      authUsers: { 'teacher-token': { id: 'teacher-1' } },
      tables: { profiles: [{ id: 'teacher-1', role: 'teacher', status: 'active', school_id: SCHOOL_A }] }
    });
    let threw = false, code = null;
    try { await requireAdmin({ headers: { authorization: 'Bearer teacher-token' } }, admin); }
    catch (e) { threw = true; code = e.statusCode; }
    check('requireAdmin rejects a non-admin role (403)', threw && code === 403);
  }
  {
    const admin = mockAdmin({
      authUsers: { 'suspended-admin-token': { id: 'admin-2' } },
      tables: { profiles: [{ id: 'admin-2', role: 'admin', status: 'inactive', school_id: SCHOOL_A }] }
    });
    let threw = false, code = null;
    try { await requireAdmin({ headers: { authorization: 'Bearer suspended-admin-token' } }, admin); }
    catch (e) { threw = true; code = e.statusCode; }
    check('requireAdmin rejects an inactive admin account (403)', threw && code === 403);
  }

  // ---- createStudentLogin --------------------------------------------------
  {
    const admin = mockAdmin();
    const res = await createStudentLogin(admin, { student_id: 'stu-1', admission_no: '5', full_name: 'Amos Test' }, SCHOOL_A);
    check('createStudentLogin succeeds', res.ok === true);
    check('createStudentLogin uses the school-scoped synthetic email', res.email === '5@alpha.students.shule.internal');
    check('createStudentLogin uses the padded default password', res.defaultPassword === 'student-5');
    check('createStudentLogin returns a >=6-char default password', res.defaultPassword.length >= 6);
    const profile = admin._tables.profiles.find(p => p.student_id === 'stu-1');
    check('createStudentLogin inserts a linked profile row with role student', profile && profile.role === 'student');
    check('createStudentLogin stamps the profile with the caller\'s school_id', profile.school_id === SCHOOL_A);
  }
  {
    // Idempotency: calling twice for the same student, in the SAME school, must not create a duplicate.
    const admin = mockAdmin({ tables: { profiles: [{ id: 'existing-1', student_id: 'stu-1', role: 'student', school_id: SCHOOL_A }] } });
    const res = await createStudentLogin(admin, { student_id: 'stu-1', admission_no: '5', full_name: 'Amos Test' }, SCHOOL_A);
    check('createStudentLogin is idempotent for an already-provisioned student', res.ok === true && res.alreadyProvisioned === true);
  }
  {
    // A student_id that happens to already be provisioned, but for a DIFFERENT
    // school, must not be treated as "already provisioned" for this caller.
    const admin = mockAdmin({ tables: { profiles: [{ id: 'existing-1', student_id: 'stu-1', role: 'student', school_id: SCHOOL_B }] } });
    const res = await createStudentLogin(admin, { student_id: 'stu-1', admission_no: '5', full_name: 'Amos Test' }, SCHOOL_A);
    check('createStudentLogin does not treat another school\'s provisioned student as already-done', res.ok === true && !res.alreadyProvisioned);
  }
  {
    // Missing required fields
    const admin = mockAdmin();
    const res = await createStudentLogin(admin, { student_id: 'stu-1' }, SCHOOL_A);
    check('createStudentLogin validates required fields', res.ok === false);
  }
  {
    // Rollback: if the profile insert fails, the orphaned auth user must be deleted.
    const admin = mockAdmin({ forceInsertError: true });
    let deleteCalled = false;
    const origDelete = admin.auth.admin.deleteUser;
    admin.auth.admin.deleteUser = async (id) => { deleteCalled = true; return origDelete(id); };
    const res = await createStudentLogin(admin, { student_id: 'stu-9', admission_no: '9', full_name: 'Rollback Test' }, SCHOOL_A);
    check('createStudentLogin rolls back the auth user when the profile insert fails', res.ok === false && deleteCalled === true);
  }

  // ---- createStaffLogin -----------------------------------------------------
  {
    const admin = mockAdmin();
    const res = await createStaffLogin(admin, { staff_id: 'staff-1', email: 'teacher@test.school', full_name: 'Mr Teacher', role: 'teacher' }, SCHOOL_A);
    check('createStaffLogin succeeds', res.ok === true);
    check('createStaffLogin defaults password to teacher123', res.defaultPassword === 'teacher123');
    const profile = admin._tables.profiles.find(p => p.staff_id === 'staff-1');
    check('createStaffLogin tags admin-flagged staff correctly', profile && profile.role === 'teacher');
    check('createStaffLogin stamps the profile with the caller\'s school_id', profile.school_id === SCHOOL_A);
  }
  {
    const admin = mockAdmin();
    const res = await createStaffLogin(admin, { staff_id: 'staff-2', email: 'head@test.school', full_name: 'Head Teacher', role: 'admin' }, SCHOOL_A);
    const profile = admin._tables.profiles.find(p => p.staff_id === 'staff-2');
    check('createStaffLogin can provision an admin-role staff account', profile && profile.role === 'admin');
  }

  // ---- resetPassword ----------------------------------------------------------
  {
    const admin = mockAdmin({
      tables: {
        profiles: [{ id: 'p-student', role: 'student', student_id: 'stu-1', school_id: SCHOOL_A }],
        students: [{ id: 'stu-1', admission_no: '5' }]
      }
    });
    const res = await resetPassword(admin, { profile_id: 'p-student' }, SCHOOL_A);
    check('resetPassword regenerates the deterministic student default', res.ok === true && res.defaultPassword === 'student-5');
  }
  {
    const admin = mockAdmin({ tables: { profiles: [{ id: 'p-teacher', role: 'teacher', school_id: SCHOOL_A }] } });
    const res = await resetPassword(admin, { profile_id: 'p-teacher' }, SCHOOL_A);
    check('resetPassword regenerates the teacher default', res.ok === true && res.defaultPassword === 'teacher123');
  }
  {
    const admin = mockAdmin({ tables: { profiles: [{ id: 'p-teacher', role: 'teacher', school_id: SCHOOL_A }] } });
    const res = await resetPassword(admin, { profile_id: 'p-teacher', new_password: 'abc' }, SCHOOL_A);
    check('resetPassword enforces the 6-char minimum on an explicit password', res.ok === false);
  }
  {
    const admin = mockAdmin({ tables: { profiles: [] } });
    const res = await resetPassword(admin, { profile_id: 'ghost' }, SCHOOL_A);
    check('resetPassword rejects an unknown profile', res.ok === false);
  }
  {
    // Cross-tenant guard: a profile that exists, but in a DIFFERENT school,
    // must be treated as not found for this caller.
    const admin = mockAdmin({ tables: { profiles: [{ id: 'p-other-school', role: 'teacher', school_id: SCHOOL_B }] } });
    const res = await resetPassword(admin, { profile_id: 'p-other-school' }, SCHOOL_A);
    check('resetPassword refuses to touch a profile belonging to a different school', res.ok === false);
  }

  // ---- setLoginStatus ----------------------------------------------------------
  {
    const admin = mockAdmin({ tables: { profiles: [{ id: 'p-1', status: 'active', school_id: SCHOOL_A }] } });
    const res = await setLoginStatus(admin, { profile_id: 'p-1', status: 'inactive' }, SCHOOL_A);
    check('setLoginStatus disables (bans) the auth account', res.ok === true && admin._bannedUsers['p-1'] === true);
    const profile = admin._tables.profiles.find(p => p.id === 'p-1');
    check('setLoginStatus updates the profile status column', profile.status === 'inactive');
  }
  {
    const admin = mockAdmin({ tables: { profiles: [{ id: 'p-1', status: 'inactive', school_id: SCHOOL_A }] } });
    const res = await setLoginStatus(admin, { profile_id: 'p-1', status: 'active' }, SCHOOL_A);
    check('setLoginStatus re-enables a previously disabled account', res.ok === true && admin._bannedUsers['p-1'] === false);
  }
  {
    const admin = mockAdmin();
    const res = await setLoginStatus(admin, { profile_id: 'p-1', status: 'bogus' }, SCHOOL_A);
    check('setLoginStatus rejects an invalid status value', res.ok === false);
  }
  {
    // Cross-tenant guard again, for the disable/enable action.
    const admin = mockAdmin({ tables: { profiles: [{ id: 'p-other', status: 'active', school_id: SCHOOL_B }] } });
    const res = await setLoginStatus(admin, { profile_id: 'p-other', status: 'inactive' }, SCHOOL_A);
    check('setLoginStatus refuses to touch a profile belonging to a different school', res.ok === false);
    check('setLoginStatus did not ban the other school\'s account', admin._bannedUsers['p-other'] === undefined);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
