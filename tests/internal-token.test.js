/**
 * Unit tests for netlify/functions/_lib/internalToken.js — the short-lived
 * signed token send-message.js uses to authorize its own fire-and-forget
 * call to deliver-sms-background.js (see that file's header for why this
 * gate exists: there's no signed-in caller on that request at all).
 */
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';
const { sign, verify } = require('../netlify/functions/_lib/internalToken.js');

let passed = 0, failed = 0;
function check(name, cond) { if (cond) passed++; else { failed++; console.error('FAIL:', name); } }

(async () => {
  {
    const token = sign({ batch_id: 'batch-1' });
    const claims = verify(token);
    check('verify accepts a freshly-signed token', !!claims);
    check('verify returns the signed payload', claims && claims.batch_id === 'batch-1');
  }
  {
    check('verify rejects garbage input', verify('not-a-real-token') === null);
    check('verify rejects an empty/missing token', verify(undefined) === null && verify('') === null);
  }
  {
    const token = sign({ batch_id: 'batch-1' });
    const [body] = token.split('.');
    const tampered = `${body}.deadbeef00000000deadbeef00000000deadbeef00000000deadbeef000000`;
    check('verify rejects a token with a tampered signature', verify(tampered) === null);
  }
  {
    // Tamper with the payload itself (different batch_id) but keep the
    // original mac — must still fail, not just "verify but wrong batch".
    const token = sign({ batch_id: 'batch-1' });
    const [body, mac] = token.split('.');
    const decoded = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    const forgedBody = Buffer.from(JSON.stringify({ ...decoded, batch_id: 'batch-EVIL' })).toString('base64url');
    check('verify rejects a payload edited to point at a different batch', verify(`${forgedBody}.${mac}`) === null);
  }
  {
    // Simulate an expired token by signing one with exp already in the past.
    const crypto = require('crypto');
    const secret = process.env.INTERNAL_FUNCTION_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY;
    const body = Buffer.from(JSON.stringify({ batch_id: 'batch-1', exp: Date.now() - 1000 })).toString('base64url');
    const mac = crypto.createHmac('sha256', secret).update(body).digest('base64url');
    check('verify rejects an expired token', verify(`${body}.${mac}`) === null);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
