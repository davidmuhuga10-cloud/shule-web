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
const { studentEmailFor, studentPasswordFor, parentEmailFor, staffUsernameFor, staffEmailFor, DEFAULT_TEACHER_PASSWORD, DEFAULT_PARENT_PASSWORD } =
  require('../netlify/functions/_lib/studentLogin.js');
const { requireAdmin } = require('../netlify/functions/_lib/supabaseAdmin.js');
const {
  createStudentLogin, createStudentsBulk, createStaffLogin, createStaffBulk, createParentLogin, resetPassword, setLoginStatus
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
    students: [{ id: 'stu-1', admission_no: '5', school_id: SCHOOL_A }],
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
      limit() { return this; }, // no-op, matches real supabase-js chain shape
      async maybeSingle() {
        const rows = tables[table] || [];
        const hit = rows.find(r => this._filters.every(([c, v]) => String(r[c]) === String(v)));
        return { data: hit || null, error: null };
      },
      // Fallback list-fetch: awaiting the chain directly (no .maybeSingle()/
      // .single()) resolves to every matching row — e.g. findAvailableUsername's
      // `await admin.from('profiles').select('username').eq('school_id', id)`.
      then(resolve, reject) {
        const rows = tables[table] || [];
        const hits = rows.filter(r => this._filters.every(([c, v]) => String(r[c]) === String(v)));
        return Promise.resolve({ data: hits, error: null }).then(resolve, reject);
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

  // ---- createStudentsBulk ---------------------------------------------------
  // Perf fix: bulk import used to call createStudentLogin once per student —
  // sequential Netlify function round trips that made a 19-student import
  // feel like the site had frozen. createStudentsBulk provisions a whole
  // batch in ONE call instead.
  {
    const rows = [
      { student_id: 'b-1', admission_no: '101', full_name: 'Amina Otieno' },
      { student_id: 'b-2', admission_no: '102', full_name: 'Brian Kiptoo' },
      { student_id: 'b-3', admission_no: '103', full_name: 'Cynthia Wanjiru' }
    ];
    const admin = mockAdmin();
    const res = await createStudentsBulk(admin, { rows }, SCHOOL_A);
    check('createStudentsBulk succeeds', res.ok === true);
    check('createStudentsBulk provisions every row', res.provisioned === 3 && res.total === 3);
    check('createStudentsBulk returns one result per row', res.results.length === 3);
    check('createStudentsBulk results are all ok', res.results.every((r) => r.ok === true));
    const profiles = admin._tables.profiles.filter((p) => p.school_id === SCHOOL_A);
    check('createStudentsBulk inserted a profile per student', profiles.length === 3);
  }
  {
    // Rows spanning more than one internal concurrency batch (CONCURRENCY=5)
    // still all get provisioned correctly.
    const rows = Array.from({ length: 12 }, (_, i) => ({
      student_id: 'bulk-' + i, admission_no: String(200 + i), full_name: 'Student ' + i
    }));
    const admin = mockAdmin();
    const res = await createStudentsBulk(admin, { rows }, SCHOOL_A);
    check('createStudentsBulk handles more rows than the concurrency chunk size', res.ok === true && res.provisioned === 12);
  }
  {
    // Already-provisioned students in the batch are reported ok (idempotent), not double-created.
    const admin = mockAdmin({ tables: { profiles: [{ id: 'existing-1', student_id: 'b-1', role: 'student', school_id: SCHOOL_A }] } });
    const rows = [
      { student_id: 'b-1', admission_no: '101', full_name: 'Amina Otieno' },
      { student_id: 'b-2', admission_no: '102', full_name: 'Brian Kiptoo' }
    ];
    const res = await createStudentsBulk(admin, { rows }, SCHOOL_A);
    check('createStudentsBulk is idempotent for already-provisioned rows in the batch', res.ok === true && res.provisioned === 2);
    check('createStudentsBulk does not insert a duplicate profile for the already-provisioned row',
      admin._tables.profiles.filter((p) => p.student_id === 'b-1').length === 1);
  }
  {
    // A malformed row (missing full_name) fails on its own without aborting the rest of the batch.
    const admin = mockAdmin();
    const rows = [
      { student_id: 'b-1', admission_no: '101', full_name: 'Amina Otieno' },
      { student_id: 'b-2', admission_no: '102' } // missing full_name
    ];
    const res = await createStudentsBulk(admin, { rows }, SCHOOL_A);
    check('createStudentsBulk keeps going after one bad row', res.ok === true && res.provisioned === 1);
    check('createStudentsBulk reports the bad row as failed, not silently dropped', res.results.some((r) => r.ok === false));
  }
  {
    const admin = mockAdmin();
    const res = await createStudentsBulk(admin, { rows: [] }, SCHOOL_A);
    check('createStudentsBulk rejects an empty batch', res.ok === false);
  }

  // ---- staffUsernameFor / staffEmailFor --------------------------------------
  check('staffUsernameFor takes the lowercased first name', staffUsernameFor('Mercy Njeri') === 'mercy');
  check('staffEmailFor folds username + school code', staffEmailFor('mercy', 'alpha') === 'mercy@alpha.staff.shule.internal');
  check('staffEmailFor keeps two schools\' identical usernames distinct', staffEmailFor('mercy', 'alpha') !== staffEmailFor('mercy', 'beta'));
  check('staffEmailFor throws without a school code', (() => {
    try { staffEmailFor('mercy'); return false; } catch (e) { return true; }
  })());

  // ---- createStaffLogin -----------------------------------------------------
  // Staff logins no longer require (or even accept) an email — sign-in is by
  // username (first name) or phone number, both derived/assigned server-side.
  {
    const admin = mockAdmin();
    const res = await createStaffLogin(admin, { staff_id: 'staff-1', full_name: 'Mercy Njeri', role: 'teacher', phone: '0712345678' }, SCHOOL_A);
    check('createStaffLogin succeeds', res.ok === true);
    check('createStaffLogin assigns a first-name username', res.username === 'mercy');
    check('createStaffLogin defaults password to teacher123', res.defaultPassword === 'teacher123');
    const profile = admin._tables.profiles.find(p => p.staff_id === 'staff-1');
    check('createStaffLogin tags teacher-role staff correctly', profile && profile.role === 'teacher');
    check('createStaffLogin stamps the profile with the caller\'s school_id', profile.school_id === SCHOOL_A);
    check('createStaffLogin uses the school-scoped synthetic email', profile.email === 'mercy@alpha.staff.shule.internal');
    check('createStaffLogin carries the phone number onto the profile', profile.phone === '0712345678');
  }
  {
    const admin = mockAdmin();
    const res = await createStaffLogin(admin, { staff_id: 'staff-2', full_name: 'Head Teacher', role: 'admin' }, SCHOOL_A);
    const profile = admin._tables.profiles.find(p => p.staff_id === 'staff-2');
    check('createStaffLogin can provision an admin-role staff account', profile && profile.role === 'admin');
    check('createStaffLogin phone is optional (null when not provided)', profile.phone === null);
  }
  {
    // Two staff members sharing a first name at the SAME school must get
    // distinct usernames — "mercy", then "mercy2".
    const admin = mockAdmin();
    const first = await createStaffLogin(admin, { staff_id: 'staff-a', full_name: 'Mercy Njeri', role: 'teacher' }, SCHOOL_A);
    const second = await createStaffLogin(admin, { staff_id: 'staff-b', full_name: 'Mercy Otieno', role: 'teacher' }, SCHOOL_A);
    check('createStaffLogin gives the first "Mercy" the plain username', first.username === 'mercy');
    check('createStaffLogin gives a colliding "Mercy" a numeric suffix', second.username === 'mercy2');
  }
  {
    // Same first name, but at a DIFFERENT school — must not collide, and both get the plain username.
    const admin = mockAdmin();
    const a = await createStaffLogin(admin, { staff_id: 'staff-a', full_name: 'Mercy Njeri', role: 'teacher' }, SCHOOL_A);
    const b = await createStaffLogin(admin, { staff_id: 'staff-b', full_name: 'Mercy Otieno', role: 'teacher' }, SCHOOL_B);
    check('createStaffLogin keeps the same first name distinct across schools', a.username === 'mercy' && b.username === 'mercy');
  }
  {
    // Idempotency: calling twice for the same staff_id, in the SAME school, must not create a duplicate.
    const admin = mockAdmin();
    await createStaffLogin(admin, { staff_id: 'staff-1', full_name: 'Mercy Njeri', role: 'teacher' }, SCHOOL_A);
    const res = await createStaffLogin(admin, { staff_id: 'staff-1', full_name: 'Mercy Njeri', role: 'teacher' }, SCHOOL_A);
    check('createStaffLogin is idempotent for an already-provisioned staff_id', res.ok === true && res.alreadyProvisioned === true);
  }
  {
    const admin = mockAdmin();
    const res = await createStaffLogin(admin, { staff_id: 'staff-1' }, SCHOOL_A);
    check('createStaffLogin validates required fields (full_name)', res.ok === false);
  }
  {
    const admin = mockAdmin({ forceInsertError: true });
    let deleteCalled = false;
    const origDelete = admin.auth.admin.deleteUser;
    admin.auth.admin.deleteUser = async (id) => { deleteCalled = true; return origDelete(id); };
    const res = await createStaffLogin(admin, { staff_id: 'staff-9', full_name: 'Rollback Teacher', role: 'teacher' }, SCHOOL_A);
    check('createStaffLogin rolls back the auth user when the profile insert fails', res.ok === false && deleteCalled === true);
  }

  // ---- createStaffBulk -------------------------------------------------------
  // Same perf fix as createStudentsBulk, applied to Teachers & Staff bulk
  // upload (Round 2 §5) — one Netlify function call provisions a whole batch.
  {
    const rows = [
      { staff_id: 'bs-1', full_name: 'Amina Otieno', role: 'teacher', phone: '0711111111' },
      { staff_id: 'bs-2', full_name: 'Brian Kiptoo', role: 'teacher', phone: '0722222222' },
      { staff_id: 'bs-3', full_name: 'Cynthia Wanjiru', role: 'admin', phone: '0733333333' }
    ];
    const admin = mockAdmin();
    const res = await createStaffBulk(admin, { rows }, SCHOOL_A);
    check('createStaffBulk succeeds', res.ok === true);
    check('createStaffBulk provisions every row', res.provisioned === 3 && res.total === 3);
    check('createStaffBulk returns one result per row', res.results.length === 3);
    check('createStaffBulk results are all ok', res.results.every((r) => r.ok === true));
    const profiles = admin._tables.profiles.filter((p) => p.school_id === SCHOOL_A);
    check('createStaffBulk inserted a profile per staff member', profiles.length === 3);
    const adminProfile = profiles.find((p) => p.staff_id === 'bs-3');
    check('createStaffBulk honors a per-row admin role', adminProfile && adminProfile.role === 'admin');
  }
  {
    // Rows spanning more than one internal concurrency batch (CONCURRENCY=5).
    const rows = Array.from({ length: 12 }, (_, i) => ({
      staff_id: 'bulk-staff-' + i, full_name: 'Staff Member ' + i, role: 'teacher'
    }));
    const admin = mockAdmin();
    const res = await createStaffBulk(admin, { rows }, SCHOOL_A);
    check('createStaffBulk handles more rows than the concurrency chunk size', res.ok === true && res.provisioned === 12);
  }
  {
    // Already-provisioned staff in the batch are reported ok (idempotent), not double-created.
    const admin = mockAdmin({ tables: { profiles: [{ id: 'existing-1', staff_id: 'bs-1', role: 'teacher', school_id: SCHOOL_A }] } });
    const rows = [
      { staff_id: 'bs-1', full_name: 'Amina Otieno', role: 'teacher' },
      { staff_id: 'bs-2', full_name: 'Brian Kiptoo', role: 'teacher' }
    ];
    const res = await createStaffBulk(admin, { rows }, SCHOOL_A);
    check('createStaffBulk is idempotent for already-provisioned rows in the batch', res.ok === true && res.provisioned === 2);
    check('createStaffBulk does not insert a duplicate profile for the already-provisioned row',
      admin._tables.profiles.filter((p) => p.staff_id === 'bs-1').length === 1);
  }
  {
    // Two staff members sharing a first name within the SAME batch must still get distinct usernames.
    const admin = mockAdmin();
    const rows = [
      { staff_id: 'bs-mercy-1', full_name: 'Mercy Njeri', role: 'teacher' },
      { staff_id: 'bs-mercy-2', full_name: 'Mercy Otieno', role: 'teacher' }
    ];
    const res = await createStaffBulk(admin, { rows }, SCHOOL_A);
    const usernames = res.results.map((r) => r.username).sort();
    check('createStaffBulk assigns distinct usernames to same-first-name staff in one batch', usernames[0] === 'mercy' && usernames[1] === 'mercy2');
  }
  {
    // A malformed row (missing full_name) fails on its own without aborting the rest of the batch.
    const admin = mockAdmin();
    const rows = [
      { staff_id: 'bs-1', full_name: 'Amina Otieno', role: 'teacher' },
      { staff_id: 'bs-2' } // missing full_name
    ];
    const res = await createStaffBulk(admin, { rows }, SCHOOL_A);
    check('createStaffBulk keeps going after one bad row', res.ok === true && res.provisioned === 1);
    check('createStaffBulk reports the bad row as failed, not silently dropped', res.results.some((r) => r.ok === false));
  }
  {
    const admin = mockAdmin();
    const res = await createStaffBulk(admin, { rows: [] }, SCHOOL_A);
    check('createStaffBulk rejects an empty batch', res.ok === false);
  }

  // ---- parentEmailFor -------------------------------------------------------
  check('parentEmailFor slugifies the phone + folds in school code', parentEmailFor('0712345678', 'alpha') === '0712345678@alpha.parents.shule.internal');
  check('parentEmailFor keeps two schools\' identical phone numbers distinct', parentEmailFor('0700000000', 'alpha') !== parentEmailFor('0700000000', 'beta'));
  check('parentEmailFor throws without a school code', (() => {
    try { parentEmailFor('0712345678'); return false; } catch (e) { return true; }
  })());
  check('DEFAULT_PARENT_PASSWORD meets 6-char floor', DEFAULT_PARENT_PASSWORD.length >= 6);

  // ---- createParentLogin -----------------------------------------------------
  // A parent's password is now their linked child's admission number (not a
  // generic fixed default), so every call must supply a student_id up front.
  {
    const admin = mockAdmin();
    const res = await createParentLogin(admin, { full_name: 'Jane Parent', phone: '0712345678', student_id: 'stu-1' }, SCHOOL_A);
    check('createParentLogin succeeds', res.ok === true);
    check('createParentLogin uses the school-scoped synthetic email', res.email === '0712345678@alpha.parents.shule.internal');
    check('createParentLogin uses the linked child\'s admission number as the password', res.defaultPassword === studentPasswordFor('5'));
    const profile = admin._tables.profiles.find(p => p.email === res.email);
    check('createParentLogin inserts a linked profile row with role parent', profile && profile.role === 'parent');
    check('createParentLogin stamps the profile with the caller\'s school_id', profile.school_id === SCHOOL_A);
    check('createParentLogin does not set a staff_id or student_id on the profile itself (parent_links handles that)', !profile.staff_id && !profile.student_id);
  }
  {
    // Idempotency: calling twice for the same phone, in the SAME school, must not create a duplicate.
    const admin = mockAdmin();
    await createParentLogin(admin, { full_name: 'Jane Parent', phone: '0712345678', student_id: 'stu-1' }, SCHOOL_A);
    const res = await createParentLogin(admin, { full_name: 'Jane Parent', phone: '0712345678', student_id: 'stu-1' }, SCHOOL_A);
    check('createParentLogin is idempotent for an already-provisioned phone', res.ok === true && res.alreadyProvisioned === true);
    check('createParentLogin did not insert a second profile', admin._tables.profiles.filter(p => p.role === 'parent').length === 1);
  }
  {
    // Same phone number, but a DIFFERENT school — must not collide.
    const admin = mockAdmin({ tables: { students: [{ id: 'stu-1', admission_no: '5', school_id: SCHOOL_A }, { id: 'stu-2', admission_no: '7', school_id: SCHOOL_B }] } });
    await createParentLogin(admin, { full_name: 'Jane Parent', phone: '0712345678', student_id: 'stu-1' }, SCHOOL_A);
    const res = await createParentLogin(admin, { full_name: 'Jane B Parent', phone: '0712345678', student_id: 'stu-2' }, SCHOOL_B);
    check('createParentLogin keeps the same phone number distinct across schools', res.ok === true && !res.alreadyProvisioned);
  }
  {
    const admin = mockAdmin();
    const res = await createParentLogin(admin, { full_name: 'Jane Parent', phone: '0712345678' }, SCHOOL_A);
    check('createParentLogin validates required fields (student_id)', res.ok === false);
  }
  {
    // A student_id from a DIFFERENT school must be rejected, not silently used.
    const admin = mockAdmin({ tables: { students: [{ id: 'stu-2', admission_no: '7', school_id: SCHOOL_B }] } });
    const res = await createParentLogin(admin, { full_name: 'Jane Parent', phone: '0712345678', student_id: 'stu-2' }, SCHOOL_A);
    check('createParentLogin refuses a student_id belonging to a different school', res.ok === false);
  }
  {
    const admin = mockAdmin({ forceInsertError: true });
    let deleteCalled = false;
    const origDelete = admin.auth.admin.deleteUser;
    admin.auth.admin.deleteUser = async (id) => { deleteCalled = true; return origDelete(id); };
    const res = await createParentLogin(admin, { full_name: 'Rollback Parent', phone: '0799999999', student_id: 'stu-1' }, SCHOOL_A);
    check('createParentLogin rolls back the auth user when the profile insert fails', res.ok === false && deleteCalled === true);
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
    // A parent's default reset password is their linked child's admission
    // number — same rule as creation (see createParentLogin's comment).
    const admin = mockAdmin({
      tables: {
        profiles: [{ id: 'p-parent', role: 'parent', school_id: SCHOOL_A }],
        parent_links: [{ parent_profile_id: 'p-parent', student_id: 'stu-1' }],
        students: [{ id: 'stu-1', admission_no: '5' }]
      }
    });
    const res = await resetPassword(admin, { profile_id: 'p-parent' }, SCHOOL_A);
    check('resetPassword regenerates a parent\'s password from their linked child\'s admission number', res.ok === true && res.defaultPassword === 'student-5');
  }
  {
    // A parent with no link yet (edge case) must not throw — falls back to
    // studentPasswordFor('') rather than crashing.
    const admin = mockAdmin({
      tables: {
        profiles: [{ id: 'p-parent-unlinked', role: 'parent', school_id: SCHOOL_A }],
        parent_links: []
      }
    });
    const res = await resetPassword(admin, { profile_id: 'p-parent-unlinked' }, SCHOOL_A);
    check('resetPassword does not crash on an unlinked parent', res.ok === true);
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
