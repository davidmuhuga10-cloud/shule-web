/**
 * Unit tests for netlify/functions/school-seed.js — the background-seeding
 * step split out of school-signup.js by the landing-redesign brief's C1
 * ("Background School Creation"). See that file's header comment.
 */
const { seedSchool } = require('../netlify/functions/school-seed.js');

let passed = 0, failed = 0;
function check(name, cond) {
  if (cond) { passed++; }
  else { failed++; console.error('FAIL:', name); }
}

function mockAdmin(opts) {
  opts = opts || {};
  const schools = opts.schools || [];
  const rpcCalls = [];
  return {
    _rpcCalls: rpcCalls,
    from(table) {
      return {
        _filters: [],
        select() { return this; },
        eq(col, val) { this._filters.push([col, val]); return this; },
        async maybeSingle() {
          const rows = table === 'schools' ? schools : [];
          const hit = rows.find((r) => this._filters.every(([c, v]) => String(r[c]) === String(v)));
          return { data: hit || null, error: null };
        }
      };
    },
    async rpc(name, args) {
      rpcCalls.push({ name, args });
      if (opts.forceSeedError) return { data: null, error: { message: 'seed failed' } };
      return { data: null, error: null };
    }
  };
}

(async () => {
  {
    const res = await seedSchool(mockAdmin(), {});
    check('rejects a missing school_id', res.ok === false);
  }
  {
    const res = await seedSchool(mockAdmin({ schools: [] }), { school_id: 'nope' });
    check('reports failure for a school that does not exist', res.ok === false && /not found/i.test(res.message));
  }
  {
    const admin = mockAdmin({ schools: [{ id: 'school-1' }] });
    const res = await seedSchool(admin, { school_id: 'school-1' });
    check('happy path succeeds', res.ok === true);
    check('calls seed_school_defaults with the right school id', admin._rpcCalls.some((c) => c.name === 'seed_school_defaults' && c.args.p_school_id === 'school-1'));
  }
  {
    const admin = mockAdmin({ schools: [{ id: 'school-1' }], forceSeedError: true });
    const res = await seedSchool(admin, { school_id: 'school-1' });
    check('reports failure (not a thrown error) when the RPC itself fails', res.ok === false);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
