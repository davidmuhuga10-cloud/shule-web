/**
 * Unit tests for netlify/functions/school-signup.js against a mock Supabase
 * admin client. This is the one PUBLIC, unauthenticated endpoint in the
 * whole backend — it creates a brand-new tenant — so these tests lean
 * heavily on: validation, code-uniqueness, and rollback-on-partial-failure
 * (never leave an orphaned school/auth-user behind).
 *
 * The signing-up admin gives their PHONE number, not an email — same
 * username/phone login pattern every other admin/teacher account uses (see
 * PRODUCT_ROADMAP.md's login-UX notes / studentEmail.shared.js's
 * staffUsernameFor/staffEmailFor). A brand-new school has no other profiles
 * yet, so the first-name-derived username can never collide at signup time.
 */
process.env.OTP_TOKEN_SECRET = 'test-secret-do-not-use-in-prod';
const { createSchoolAndAdmin, slugifyCode } = require('../netlify/functions/school-signup.js');
const { signVerifiedToken } = require('../netlify/functions/_lib/otp.js');

// Every test below that expects to reach account creation needs a real
// verified-phone token for that exact phone number — school-signup.js now
// checks this itself (see its own header comment) rather than trusting the
// frontend to have run the OTP step.
const OTP_TOKEN_0712345678 = signVerifiedToken('0712345678', 'signup');

let passed = 0, failed = 0;
function check(name, cond) {
  if (cond) { passed++; }
  else { failed++; console.error('FAIL:', name); }
}

function mockAdmin(opts) {
  opts = opts || {};
  const tables = { schools: [], profiles: [], ...opts.tables };
  let nextSchoolId = 1;
  let nextUid = 1;
  const deletedSchoolIds = [];
  const deletedUserIds = [];
  let rpcCalls = [];

  function chainFor(table) {
    const chain = {
      _filters: [],
      select() { return this; },
      eq(col, val) { this._filters.push([col, val]); return this; },
      async maybeSingle() {
        const rows = tables[table] || [];
        const hit = rows.find(r => this._filters.every(([c, v]) => String(r[c]) === String(v)));
        return { data: hit || null, error: null };
      },
      insert(obj) {
        const insertChain = {
          select() { return insertChain; },
          async single() {
            if (opts.forceSchoolInsertError && table === 'schools') {
              return { data: null, error: { message: opts.forceSchoolInsertError } };
            }
            const row = { id: 'school-' + (nextSchoolId++), ...obj };
            tables.schools = tables.schools || [];
            tables.schools.push(row);
            return { data: row, error: null };
          }
        };
        // Plain (non-.select().single()) insert path, used for `profiles`.
        insertChain.then = (resolve) => {
          if (opts.forceProfileInsertError && table === 'profiles') {
            return Promise.resolve({ error: { message: opts.forceProfileInsertError } }).then(resolve);
          }
          tables[table] = tables[table] || [];
          tables[table].push(obj);
          return Promise.resolve({ error: null }).then(resolve);
        };
        return insertChain;
      },
      delete() {
        return {
          eq: async (col, val) => {
            const rows = tables[table] || [];
            const idx = rows.findIndex(r => String(r[col]) === String(val));
            if (idx >= 0) {
              if (table === 'schools') deletedSchoolIds.push(rows[idx].id);
              rows.splice(idx, 1);
            }
            return { error: null };
          }
        };
      }
    };
    return chain;
  }

  return {
    _tables: tables,
    _deletedSchoolIds: deletedSchoolIds,
    _deletedUserIds: deletedUserIds,
    _rpcCalls: rpcCalls,
    from(table) { return chainFor(table); },
    async rpc(name, args) {
      rpcCalls.push({ name, args });
      if (opts.forceSeedError) return { data: null, error: { message: 'seed failed' } };
      return { data: null, error: null };
    },
    auth: {
      admin: {
        async createUser({ email, password }) {
          if (opts.forceCreateUserError) return { data: null, error: { message: opts.forceCreateUserError } };
          if (String(password).length < 6) return { data: null, error: { message: 'Password too short' } };
          const id = 'uid-' + (nextUid++);
          return { data: { user: { id, email } }, error: null };
        },
        async deleteUser(id) { deletedUserIds.push(id); return { error: null }; }
      }
    }
  };
}

(async () => {
  // ---- slugifyCode -----------------------------------------------------
  check('slugifyCode lowercases and hyphenates', slugifyCode('Green Hill Academy') === 'green-hill-academy');
  check('slugifyCode strips stray punctuation', slugifyCode('St. Mary\'s!!') === 'st-mary-s');
  check('slugifyCode caps length at 30', slugifyCode('a'.repeat(50)).length === 30);

  // ---- validation --------------------------------------------------------
  {
    const admin = mockAdmin();
    const res = await createSchoolAndAdmin(admin, { school_name: '', school_code: 'x', admin_name: 'A', admin_phone: '0712345678', password: 'abcdef' });
    check('rejects missing school name', res.ok === false);
  }
  {
    const admin = mockAdmin();
    const res = await createSchoolAndAdmin(admin, { school_name: 'Test School', school_code: 'test', admin_name: '', admin_phone: '0712345678', password: 'abcdef' });
    check('rejects missing admin name', res.ok === false);
  }
  {
    const admin = mockAdmin();
    const res = await createSchoolAndAdmin(admin, { school_name: 'Test School', school_code: 'test', admin_name: 'A', admin_phone: '123', password: 'abcdef' });
    check('rejects a too-short admin phone number', res.ok === false);
  }
  {
    const admin = mockAdmin();
    const res = await createSchoolAndAdmin(admin, { school_name: 'Test School', school_code: 'test', admin_name: 'A', admin_phone: '', password: 'abcdef' });
    check('rejects a missing admin phone number', res.ok === false);
  }
  {
    const admin = mockAdmin();
    const res = await createSchoolAndAdmin(admin, { school_name: 'Test School', school_code: 'test', admin_name: 'A', admin_phone: '0712345678', password: '123' });
    check('rejects a too-short password', res.ok === false);
  }
  {
    const admin = mockAdmin();
    const res = await createSchoolAndAdmin(admin, { school_name: 'Test School', school_code: 'x', admin_name: 'A', admin_phone: '0712345678', password: 'abcdef' });
    check('rejects a too-short school code', res.ok === false);
  }

  // ---- OTP verification is now required -------------------------------------
  {
    const admin = mockAdmin();
    const res = await createSchoolAndAdmin(admin, {
      school_name: 'Test School', school_code: 'otptest', admin_name: 'A', admin_phone: '0712345678', password: 'abcdef'
    });
    check('rejects signup with no otp_verified_token at all', res.ok === false && /verify your phone/i.test(res.message));
  }
  {
    const admin = mockAdmin();
    const res = await createSchoolAndAdmin(admin, {
      school_name: 'Test School', school_code: 'otptest2', admin_name: 'A', admin_phone: '0712345678', password: 'abcdef',
      otp_verified_token: signVerifiedToken('0700000000', 'signup') // verified for a DIFFERENT phone number
    });
    check('rejects a token that was verified for a different phone number', res.ok === false && /verify your phone/i.test(res.message));
  }
  {
    const admin = mockAdmin();
    const res = await createSchoolAndAdmin(admin, {
      school_name: 'Test School', school_code: 'otptest3', admin_name: 'A', admin_phone: '0712345678', password: 'abcdef',
      otp_verified_token: signVerifiedToken('0712345678', 'password_reset') // right phone, wrong purpose
    });
    check('rejects a token verified for a different purpose (password_reset, not signup)', res.ok === false && /verify your phone/i.test(res.message));
  }

  // ---- happy path ----------------------------------------------------------
  {
    const admin = mockAdmin();
    const res = await createSchoolAndAdmin(admin, {
      school_name: 'Greenhill Academy', school_code: 'Greenhill', admin_name: 'Jane Wanjiru',
      admin_phone: '0712345678', password: 'supersecret', otp_verified_token: OTP_TOKEN_0712345678
    });
    check('happy path succeeds', res.ok === true);
    check('school code is normalized to lowercase', res.school_code === 'greenhill');
    check('reports the auto-assigned username (first name)', res.username === 'jane');
    check('a schools row was created', admin._tables.schools.some(s => s.code === 'greenhill'));
    const profile = admin._tables.profiles.find(p => p.username === 'jane');
    check('an admin profile row was created and linked to the new school', profile && profile.role === 'admin' && profile.school_id);
    check('the profile carries the admin\'s phone number', profile.phone === '0712345678');
    check('the profile\'s login email is the synthetic username@schoolcode address, not a real email', profile.email === 'jane@greenhill.staff.shule.internal');
    // Brief C1: seeding (seed_school_defaults) is no longer called from
    // school-signup itself — it moved to school-seed.js, invoked by the
    // client separately AFTER this response, so the admin isn't stuck
    // waiting on it. This endpoint's response just needs to hand back the
    // school_id so the client can make that follow-up call.
    check('seed_school_defaults is NOT called during signup itself (moved to school-seed.js)', !admin._rpcCalls.some(c => c.name === 'seed_school_defaults'));
    check('reports the new school_id for the follow-up school-seed call', res.school_id === 'school-1');
  }

  // ---- duplicate code --------------------------------------------------------
  {
    const admin = mockAdmin({ tables: { schools: [{ id: 'existing', code: 'taken', name: 'Existing School' }] } });
    const res = await createSchoolAndAdmin(admin, {
      school_name: 'New School', school_code: 'taken', admin_name: 'A', admin_phone: '0712345678', password: 'abcdef',
      otp_verified_token: OTP_TOKEN_0712345678
    });
    check('rejects an already-taken school code', res.ok === false && /already taken/i.test(res.message));
    check('did not create a second school row for a rejected duplicate code', admin._tables.schools.length === 1);
  }

  // ---- rollback: auth user creation fails after school row was created --------
  {
    const admin = mockAdmin({ forceCreateUserError: 'some auth provisioning error' });
    const res = await createSchoolAndAdmin(admin, {
      school_name: 'Rollback School', school_code: 'rollback1', admin_name: 'A', admin_phone: '0712345678', password: 'abcdef',
      otp_verified_token: OTP_TOKEN_0712345678
    });
    check('reports failure when the admin auth user cannot be created', res.ok === false);
    check('the orphaned school row was rolled back', admin._deletedSchoolIds.includes('school-1'));
    check('no profile was left behind', admin._tables.profiles.length === 0);
  }

  // ---- rollback: profile insert fails after auth user + school were created ---
  {
    const admin = mockAdmin({ forceProfileInsertError: 'forced failure' });
    const res = await createSchoolAndAdmin(admin, {
      school_name: 'Rollback School 2', school_code: 'rollback2', admin_name: 'A', admin_phone: '0712345678', password: 'abcdef',
      otp_verified_token: OTP_TOKEN_0712345678
    });
    check('reports failure when the profile insert fails', res.ok === false);
    check('the orphaned auth user was deleted', admin._deletedUserIds.length === 1);
    check('the orphaned school row was rolled back too', admin._deletedSchoolIds.includes('school-1'));
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
