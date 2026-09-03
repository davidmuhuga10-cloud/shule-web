/**
 * Unit tests for netlify/functions/forgot-password.js — landing-redesign
 * brief B2's "no OTP/email verification for now" reset flow. Tests focus on:
 * the (phone, school_code, role) triple must match exactly one active
 * profile at an active school, the new password is validated, and only
 * admin/teacher/parent roles are ever reachable.
 */
process.env.OTP_TOKEN_SECRET = 'test-secret-do-not-use-in-prod';
const { resetForgottenPassword } = require('../netlify/functions/forgot-password.js');
const { signVerifiedToken } = require('../netlify/functions/_lib/otp.js');

// Every test below that expects to reach the account lookup needs a real
// verified-phone token for that exact phone number — forgot-password.js now
// requires the caller to have gone through send-otp.js/verify-otp.js first
// (purpose 'password_reset') rather than trusting a bare phone-number claim.
const OTP_TOKEN_0712345678 = signVerifiedToken('0712345678', 'password_reset');
const OTP_TOKEN_0700000000 = signVerifiedToken('0700000000', 'password_reset');

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

  // ---- OTP verification is now required -------------------------------------
  {
    const admin = mockAdmin({ schools: [SCHOOL], profiles: [ADMIN_PROFILE] });
    const res = await resetForgottenPassword(admin, { phone: '0712345678', school_code: 'greenhill', role: 'admin', new_password: 'newpass1' });
    check('rejects a reset with no otp_verified_token at all', res.ok === false && /verify your phone/i.test(res.message) && admin._updateCalls.length === 0);
  }
  {
    const admin = mockAdmin({ schools: [SCHOOL], profiles: [ADMIN_PROFILE] });
    const res = await resetForgottenPassword(admin, {
      phone: '0712345678', school_code: 'greenhill', role: 'admin', new_password: 'newpass1',
      otp_verified_token: signVerifiedToken('0712345678', 'signup') // right phone, wrong purpose
    });
    check('rejects a token verified for a different purpose (signup, not password_reset)', res.ok === false && admin._updateCalls.length === 0);
  }

  // ---- happy path ------------------------------------------------------------
  {
    const admin = mockAdmin({ schools: [SCHOOL], profiles: [ADMIN_PROFILE] });
    const res = await resetForgottenPassword(admin, {
      phone: '0712345678', school_code: 'GreenHill', role: 'admin', new_password: 'newpass1',
      otp_verified_token: OTP_TOKEN_0712345678
    });
    check('happy path succeeds', res.ok === true);
    check('resets the password for the correct auth user id', admin._updateCalls.length === 1 && admin._updateCalls[0].id === 'uid-1');
    check('sends the new password through', admin._updateCalls[0].changes.password === 'newpass1');
  }

  // ---- no match ----------------------------------------------------------
  {
    const admin = mockAdmin({ schools: [SCHOOL], profiles: [ADMIN_PROFILE] });
    const res = await resetForgottenPassword(admin, {
      phone: '0700000000', school_code: 'greenhill', role: 'admin', new_password: 'newpass1', otp_verified_token: OTP_TOKEN_0700000000
    });
    check('reports a generic failure for a phone number that does not match any profile', res.ok === false && admin._updateCalls.length === 0);
  }
  {
    const admin = mockAdmin({ schools: [SCHOOL], profiles: [{ ...ADMIN_PROFILE, status: 'inactive' }] });
    const res = await resetForgottenPassword(admin, {
      phone: '0712345678', school_code: 'greenhill', role: 'admin', new_password: 'newpass1', otp_verified_token: OTP_TOKEN_0712345678
    });
    check('refuses to reset an inactive account', res.ok === false && admin._updateCalls.length === 0);
  }
  {
    const admin = mockAdmin({ schools: [{ ...SCHOOL, status: 'inactive' }], profiles: [ADMIN_PROFILE] });
    const res = await resetForgottenPassword(admin, {
      phone: '0712345678', school_code: 'greenhill', role: 'admin', new_password: 'newpass1', otp_verified_token: OTP_TOKEN_0712345678
    });
    check('refuses to reset for an inactive school', res.ok === false && admin._updateCalls.length === 0);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
