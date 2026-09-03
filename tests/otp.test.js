/**
 * Unit tests for the new phone-OTP verification pipeline:
 *   netlify/functions/_lib/otp.js (pure crypto helpers)
 *   netlify/functions/send-otp.js (rate-limited code send)
 *   netlify/functions/verify-otp.js (code check -> signed token)
 * This is the security-hardening piece requested to close the "no OTP for
 * signup/password reset" gap both school-signup.js and forgot-password.js
 * used to flag in their own comments — see their own test files for how the
 * resulting otp_verified_token is now required there.
 */
process.env.OTP_TOKEN_SECRET = 'test-secret-do-not-use-in-prod';
const { generateCode, hashCode, signVerifiedToken, verifyToken, MAX_ATTEMPTS } = require('../netlify/functions/_lib/otp.js');
const { sendOtp } = require('../netlify/functions/send-otp.js');
const { verifyOtp } = require('../netlify/functions/verify-otp.js');

let passed = 0, failed = 0;
function check(name, cond) { if (cond) passed++; else { failed++; console.error('FAIL:', name); } }

function mockAdmin(seedRows) {
  const rows = (seedRows || []).map((r, i) => ({ id: 'otp-' + i, attempts: 0, consumed_at: null, ...r }));
  return {
    _rows: rows,
    from(table) {
      if (table !== 'phone_otps') throw new Error('unexpected table ' + table);
      const state = { filters: [], order: null, limitN: null };
      const api = {
        select() { return api; },
        eq(col, val) { state.filters.push(['eq', col, val]); return api; },
        gte(col, val) { state.filters.push(['gte', col, val]); return api; },
        is(col, val) { state.filters.push(['is', col, val]); return api; },
        order(col, opts) { state.order = { col, ascending: !opts || opts.ascending !== false }; return api; },
        limit(n) { state.limitN = n; return api; },
        async insert(obj) {
          rows.push({ id: 'otp-' + rows.length, attempts: 0, consumed_at: null, created_at: new Date().toISOString(), ...obj });
          return { error: null };
        },
        update(patch) {
          return {
            async eq(col, val) {
              const hit = rows.find((r) => String(r[col]) === String(val));
              if (hit) Object.assign(hit, patch);
              return { error: null };
            }
          };
        },
        then(resolve) {
          let hit = rows.filter((r) => state.filters.every(([kind, c, v]) => {
            if (kind === 'eq') return String(r[c]) === String(v);
            if (kind === 'gte') return r[c] >= v;
            if (kind === 'is') return v === null ? (r[c] === null || r[c] === undefined) : r[c] === v;
            return true;
          }));
          if (state.order) {
            hit = hit.slice().sort((a, b) => (a[state.order.col] > b[state.order.col] ? -1 : 1) * (state.order.ascending ? -1 : 1));
          }
          if (state.limitN) hit = hit.slice(0, state.limitN);
          resolve({ data: hit, error: null });
        }
      };
      return api;
    }
  };
}

(async () => {
  // ---- otp.js: signVerifiedToken / verifyToken ------------------------------
  {
    const token = signVerifiedToken('0712345678', 'signup');
    check('verifyToken accepts its own freshly-signed token', verifyToken(token, '0712345678', 'signup'));
    check('verifyToken normalizes stray spaces/hyphens before comparing', verifyToken(token, '0712 345 678', 'signup'));
    check('verifyToken rejects the wrong purpose', !verifyToken(token, '0712345678', 'password_reset'));
    check('verifyToken rejects the wrong phone', !verifyToken(token, '0700000000', 'signup'));
    check('verifyToken rejects a tampered token', !verifyToken(token + 'x', '0712345678', 'signup'));
    check('verifyToken rejects garbage', !verifyToken('not-a-token', '0712345678', 'signup'));
    check('verifyToken rejects an empty token', !verifyToken('', '0712345678', 'signup'));
  }
  {
    const code = generateCode();
    check('generateCode produces a 6-digit string', /^\d{6}$/.test(code));
    check('hashCode is deterministic for the same phone/purpose/code', hashCode('0712345678', 'signup', code) === hashCode('0712345678', 'signup', code));
    check('hashCode differs for a different phone (same code)', hashCode('0712345678', 'signup', code) !== hashCode('0700000000', 'signup', code));
    check('hashCode differs for a different purpose (same phone/code)', hashCode('0712345678', 'signup', code) !== hashCode('0712345678', 'password_reset', code));
  }

  // ---- send-otp.js -----------------------------------------------------------
  {
    const admin = mockAdmin();
    const res = await sendOtp(admin, { phone: 'not-a-phone', purpose: 'signup' });
    check('sendOtp rejects an invalid phone number', res.ok === false);
  }
  {
    const admin = mockAdmin();
    const res = await sendOtp(admin, { phone: '0712345678', purpose: 'bogus' });
    check('sendOtp rejects an unknown purpose', res.ok === false);
  }
  {
    // No SMS_PROVIDER_API_KEY set in this test env — same "recorded, not
    // actually deliverable" honesty send-message.js already has.
    const admin = mockAdmin();
    const res = await sendOtp(admin, { phone: '0712345678', purpose: 'signup' });
    check('sendOtp succeeds (records a code) even with no provider configured', res.ok === true && res.sent === false);
    check('sendOtp actually inserted a phone_otps row', admin._rows.length === 1 && admin._rows[0].phone === '0712345678');
    check('sendOtp stores a hash, never the raw code', admin._rows[0].code_hash && admin._rows[0].code_hash.length === 64);
  }
  {
    // Resend cooldown: a second request for the same phone+purpose within
    // 30s is refused.
    const admin = mockAdmin([{ phone: '0712345678', purpose: 'signup', code_hash: 'x', expires_at: new Date(Date.now() + 300000).toISOString(), created_at: new Date().toISOString() }]);
    const res = await sendOtp(admin, { phone: '0712345678', purpose: 'signup' });
    check('sendOtp enforces the resend cooldown', res.ok === false && /wait/i.test(res.message));
  }
  {
    // Window cap: 5 sends already in the last 15 minutes (each well outside
    // the 30s cooldown) refuses a 6th.
    const now = Date.now();
    const seed = Array.from({ length: 5 }).map((_, i) => ({
      phone: '0712345678', purpose: 'signup', code_hash: 'x',
      expires_at: new Date(now + 300000).toISOString(),
      created_at: new Date(now - (i + 1) * 60000).toISOString()
    }));
    const admin = mockAdmin(seed);
    const res = await sendOtp(admin, { phone: '0712345678', purpose: 'signup' });
    check('sendOtp enforces the 15-minute send cap', res.ok === false && /too many/i.test(res.message));
  }
  {
    // A different phone number is never blocked by another number's history.
    const admin = mockAdmin([{ phone: '0712345678', purpose: 'signup', code_hash: 'x', expires_at: new Date(Date.now() + 300000).toISOString(), created_at: new Date().toISOString() }]);
    const res = await sendOtp(admin, { phone: '0700000000', purpose: 'signup' });
    check('sendOtp rate limits are per phone number, not global', res.ok === true);
  }

  // ---- verify-otp.js ----------------------------------------------------------
  {
    const admin = mockAdmin();
    const res = await verifyOtp(admin, { phone: '0712345678', purpose: 'signup', code: '123456' });
    check('verifyOtp rejects when no code was ever requested', res.ok === false);
  }
  {
    const code = '654321';
    const admin = mockAdmin([{
      phone: '0712345678', purpose: 'signup', code_hash: hashCode('0712345678', 'signup', code),
      expires_at: new Date(Date.now() + 300000).toISOString()
    }]);
    const res = await verifyOtp(admin, { phone: '0712345678', purpose: 'signup', code: '000000' });
    check('verifyOtp rejects an incorrect code', res.ok === false && /incorrect/i.test(res.message));
    check('verifyOtp increments the attempt counter on a miss', admin._rows[0].attempts === 1);
  }
  {
    const code = '654321';
    const admin = mockAdmin([{
      phone: '0712345678', purpose: 'signup', code_hash: hashCode('0712345678', 'signup', code),
      expires_at: new Date(Date.now() - 1000).toISOString() // already expired
    }]);
    const res = await verifyOtp(admin, { phone: '0712345678', purpose: 'signup', code });
    check('verifyOtp rejects an expired code even if it\'s otherwise correct', res.ok === false && /expired/i.test(res.message));
  }
  {
    const code = '654321';
    const admin = mockAdmin([{
      phone: '0712345678', purpose: 'signup', code_hash: hashCode('0712345678', 'signup', code),
      expires_at: new Date(Date.now() + 300000).toISOString(), attempts: MAX_ATTEMPTS
    }]);
    const res = await verifyOtp(admin, { phone: '0712345678', purpose: 'signup', code });
    check('verifyOtp refuses once max attempts is already reached, even with the right code', res.ok === false && /too many/i.test(res.message));
  }
  {
    const code = '654321';
    const admin = mockAdmin([{
      phone: '0712345678', purpose: 'signup', code_hash: hashCode('0712345678', 'signup', code),
      expires_at: new Date(Date.now() + 300000).toISOString()
    }]);
    const res = await verifyOtp(admin, { phone: '0712345678', purpose: 'signup', code });
    check('verifyOtp succeeds with the correct, unexpired code', res.ok === true && !!res.verified_token);
    check('the issued token actually verifies for this phone+purpose', verifyToken(res.verified_token, '0712345678', 'signup'));
    check('verifyOtp marks the row consumed so it cannot be reused', !!admin._rows[0].consumed_at);
  }
  {
    // Reusing an already-consumed code must fail — verifyOtp only ever looks
    // at unconsumed rows (`.is('consumed_at', null)`).
    const code = '654321';
    const admin = mockAdmin([{
      phone: '0712345678', purpose: 'signup', code_hash: hashCode('0712345678', 'signup', code),
      expires_at: new Date(Date.now() + 300000).toISOString(), consumed_at: new Date().toISOString()
    }]);
    const res = await verifyOtp(admin, { phone: '0712345678', purpose: 'signup', code });
    check('verifyOtp rejects replaying an already-consumed code', res.ok === false);
  }
  {
    const admin = mockAdmin();
    const res = await verifyOtp(admin, { phone: '0712345678', purpose: 'signup', code: 'abcdef' });
    check('verifyOtp rejects a non-numeric code without even hitting the database', res.ok === false);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
