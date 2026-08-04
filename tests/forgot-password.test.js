/**
 * Unit tests for netlify/functions/forgot-password.js — landing-redesign
 * brief B2's "no OTP/email verification for now" reset flow. Tests focus on:
 * the (phone, school_code, role) triple must match exactly one active
 * profile at an active school, the new password is validated, and only
 * admin/teacher/parent roles are ever reachable.
 */
const { resetForgottenPassword } = require('../netlify/functions/forgot-password.js');

let passed = 0, failed = 0;
function check(name, cond) {
  if (cond) { passed++; }
  else { failed++; console.error('FAIL:', name); }
}

function mockAdmin(opts) {
  opts = opts || {};
  const schools = opts.schools || [];
  const profiles = opts.profiles || [];
  const updateCalls = [];
  return {
    _updateCalls: updateCalls,
    from(table) {
      return {
        _filters: [],
        select() { return this; },
        eq(col, val) { this._filters.push([col, val]); return this; },
        async maybeSingle() {
          const rows = table === 'schools' ? schools : table === 'profiles' ? profiles : [];
          const hit = rows.find((r) => this._filters.every(([c, v]) => String(r[c]) === String(v)));
          return { data: hit || null, error: null };
        }
      };
    },
    auth: {
      admin: {
        async updateUserById(id, changes) {
          updateCalls.push({ id, changes });
          if (opts.forceUpdateError) return { data: null, error: { message: 'update failed' } };
          return { data: { user: { id } }, error: null };
        }
      }
    }
  };
}

const SCHOOL = { id: 'school-1', code: 'greenhill', status: 'active' };
const ADMIN_PROFILE = { id: 'uid-1', school_id: 'school-1', phone: '0712345678', role: 'admin', status: 'active' };

(async () => {
  // ---- validation ----------------------------------------------------------
  {
    const res = await resetForgottenPassword(mockAdmin(), { school_code: 'greenhill', role: 'admin', new_password: 'abcdef' });
    check('rejects a missing phone number', res.ok === false);
  }
  {
    const res = await resetForgottenPassword(mockAdmin(), { phone: '0712345678', role: 'admin', new_password: 'abcdef' });
    check('rejects a missing school_code', res.ok === false);
  }
  {
    const res = await resetForgottenPassword(mockAdmin(), { phone: '0712345678', school_code: 'greenhill', role: 'admin', new_password: '123' });
    check('rejects a too-short new password', res.ok === false);
  }
  {
    const res = await resetForgottenPassword(mockAdmin(), { phone: '0712345678', school_code: 'greenhill', role: 'student', new_password: 'abcdef' });
    check('rejects a non-resettable role (student)', res.ok === false);
  }

  // ---- happy path ------------------------------------------------------------
  {
    const admin = mockAdmin({ schools: [SCHOOL], profiles: [ADMIN_PROFILE] });
    const res = await resetForgottenPassword(admin, { phone: '0712345678', school_code: 'GreenHill', role: 'admin', new_password: 'newpass1' });
    check('happy path succeeds', res.ok === true);
    check('resets the password for the correct auth user id', admin._updateCalls.length === 1 && admin._updateCalls[0].id === 'uid-1');
    check('sends the new password through', admin._updateCalls[0].changes.password === 'newpass1');
  }

  // ---- no match ----------------------------------------------------------
  {
    const admin = mockAdmin({ schools: [SCHOOL], profiles: [ADMIN_PROFILE] });
    const res = await resetForgottenPassword(admin, { phone: '0700000000', school_code: 'greenhill', role: 'admin', new_password: 'newpass1' });
    check('reports a generic failure for a phone number that does not match any profile', res.ok === false && admin._updateCalls.length === 0);
  }
  {
    const admin = mockAdmin({ schools: [SCHOOL], profiles: [{ ...ADMIN_PROFILE, status: 'inactive' }] });
    const res = await resetForgottenPassword(admin, { phone: '0712345678', school_code: 'greenhill', role: 'admin', new_password: 'newpass1' });
    check('refuses to reset an inactive account', res.ok === false && admin._updateCalls.length === 0);
  }
  {
    const admin = mockAdmin({ schools: [{ ...SCHOOL, status: 'inactive' }], profiles: [ADMIN_PROFILE] });
    const res = await resetForgottenPassword(admin, { phone: '0712345678', school_code: 'greenhill', role: 'admin', new_password: 'newpass1' });
    check('refuses to reset for an inactive school', res.ok === false && admin._updateCalls.length === 0);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
