/**
 * Unit tests for netlify/functions/keep-alive.js — the scheduled function
 * that pings the database every few days purely to stop Supabase's
 * free-tier "paused after 7 days of inactivity" behavior from kicking in
 * (see that file's own header comment, and netlify.toml's schedule entry).
 */
const { pingDatabase } = require('../netlify/functions/keep-alive.js');

let passed = 0, failed = 0;
function check(name, cond) {
  if (cond) { passed++; }
  else { failed++; console.error('FAIL:', name); }
}

function mockAdmin(opts) {
  opts = opts || {};
  return {
    from(table) {
      return {
        select() { return this; },
        limit() {
          if (opts.forceError) return Promise.resolve({ data: null, error: { message: 'connection failed' } });
          return Promise.resolve({ data: [{ id: 'school-1' }], error: null });
        }
      };
    }
  };
}

async function run() {
  const ok = await pingDatabase(mockAdmin());
  check('pingDatabase reports ok on a successful query', ok.ok === true);

  const failedResult = await pingDatabase(mockAdmin({ forceError: true }));
  check('pingDatabase reports failure (not a thrown exception) when the query errors', failedResult.ok === false);
  check('pingDatabase surfaces the underlying error message', failedResult.message === 'connection failed');

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

run();
