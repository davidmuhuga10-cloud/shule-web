/**
 * Unit tests for netlify/functions/admin-impersonate.js against a bespoke
 * mock Supabase admin client (no live project needed). Covers the two
 * things that matter most for a "Login as School" feature: it must never
 * touch the target's password, and every start/end must land in the audit
 * log with the acting Super Admin as the actor.
 */
const { startImpersonation, endImpersonation } = require('../netlify/functions/admin-impersonate.js');

let passed = 0, failed = 0;
function check(name, cond) { if (cond) passed++; else { failed++; console.error('FAIL:', name); } }

function mockAdmin(opts) {
  opts = opts || {};
  const tables = { schools: [], profiles: [], admin_impersonation_sessions: [], admin_audit_log: [], ...opts.tables };
  let idCounter = 0;

  function builderFor(table) {
    const b = {
      _filters: [], _order: null, _limit: null,
      select() { return this; },
      eq(col, val) { this._filters.push([col, val]); return this; },
      order() { this._order = true; return this; },
      limit(n) { this._limit = n; return this; },
      _rows() { return (tables[table] || []).filter((r) => this._filters.every(([c, v]) => String(r[c]) === String(v))); },
      async maybeSingle() { const rows = this._rows(); return { data: rows[0] || null, error: null }; },
      async single() { const rows = this._rows(); return { data: rows[0] || null, error: rows[0] ? null : { message: 'not found' } }; },
      then(resolve) { resolve({ data: this._rows(), error: null }); },
      insert(row) {
        const withId = { id: 'gen-' + (++idCounter), ended_at: null, ...row };
        tables[table] = tables[table] || [];
        tables[table].push(withId);
        return {
          select() { return { async single() { return { data: withId, error: null }; } }; },
          then(resolve) { resolve({ error: null }); }
        };
      },
      update(patch) {
        return {
          eq: (col, val) => ({
            async then(resolve) {
              const row = (tables[table] || []).find((r) => String(r[col]) === String(val));
              if (row) Object.assign(row, patch);
              resolve({ error: null });
            }
          })
        };
      }
    };
    return b;
  }

  return {
    _tables: tables,
    from(table) { return builderFor(table); },
    auth: {
      admin: {
        async generateLink({ email }) {
          if (opts.forceLinkError) return { data: null, error: { message: 'provider error' } };
          return { data: { properties: { hashed_token: 'tok-' + email } }, error: null };
        }
      }
    }
  };
}

(async () => {
  // ---- startImpersonation: happy path ----------------------------------
  {
    const admin = mockAdmin({
      tables: {
        schools: [{ id: 'school-1', name: 'Green Hill', deleted_at: null, locked_at: null }],
        profiles: [{ id: 'p1', email: 'admin@greenhill.test', name: 'Head Teacher', role: 'admin', school_id: 'school-1', created_at: '2024-01-01' }]
      }
    });
    const res = await startImpersonation(admin, { school_id: 'school-1' }, 'super-admin-id');
    check('startImpersonation succeeds and never touches a password', res.ok && res.email === 'admin@greenhill.test' && res.token_hash === 'tok-admin@greenhill.test');
    check('startImpersonation records an impersonation session', admin._tables.admin_impersonation_sessions.some((s) => s.school_id === 'school-1' && s.admin_id === 'super-admin-id'));
    check('startImpersonation writes an audit log entry with the Super Admin as actor', admin._tables.admin_audit_log.some((a) => a.action === 'impersonation_start' && a.actor === 'super-admin-id' && a.target_school_id === 'school-1'));
  }

  // ---- startImpersonation: refuses a deleted school ----------------------
  {
    const admin = mockAdmin({ tables: { schools: [{ id: 'school-2', name: 'Closed School', deleted_at: '2025-01-01' }] } });
    const res = await startImpersonation(admin, { school_id: 'school-2' }, 'super-admin-id');
    check('startImpersonation refuses a deleted school', res.ok === false);
  }

  // ---- startImpersonation: no admin login on file -------------------------
  {
    const admin = mockAdmin({ tables: { schools: [{ id: 'school-3', name: 'No Admin School', deleted_at: null }] } });
    const res = await startImpersonation(admin, { school_id: 'school-3' }, 'super-admin-id');
    check('startImpersonation refuses when the school has no admin email on file', res.ok === false);
  }

  // ---- endImpersonation: closes the session and audits it -----------------
  // Note: the caller here is the IMPERSONATED profile's own token (the new
  // tab never holds Super Admin credentials — see the file header comment
  // in admin-impersonate.js), so the third arg must match target_profile_id,
  // not admin_id.
  {
    const admin = mockAdmin({ tables: { admin_impersonation_sessions: [{ id: 'sess-1', school_id: 'school-1', admin_id: 'super-admin-id', target_profile_id: 'target-profile-1', ended_at: null }] } });
    const res = await endImpersonation(admin, { session_id: 'sess-1' }, 'target-profile-1');
    check('endImpersonation succeeds when the caller owns the session', res.ok === true);
    check('endImpersonation sets ended_at', !!admin._tables.admin_impersonation_sessions.find((s) => s.id === 'sess-1').ended_at);
    check('endImpersonation writes an audit log entry with the original Super Admin as actor', admin._tables.admin_audit_log.some((a) => a.action === 'impersonation_end' && a.actor === 'super-admin-id'));
  }

  // ---- endImpersonation: refuses a caller who does not own the session ----
  {
    const admin = mockAdmin({ tables: { admin_impersonation_sessions: [{ id: 'sess-3', school_id: 'school-1', admin_id: 'super-admin-id', target_profile_id: 'target-profile-1', ended_at: null }] } });
    let threw = null;
    try {
      await endImpersonation(admin, { session_id: 'sess-3' }, 'some-other-profile');
    } catch (e) { threw = e; }
    check('endImpersonation refuses a caller who is not the impersonated profile', threw && threw.statusCode === 403);
    check('endImpersonation does not close the session on a refused attempt', !admin._tables.admin_impersonation_sessions.find((s) => s.id === 'sess-3').ended_at);
  }

  // ---- endImpersonation: already-ended session is a no-op, not an error ---
  {
    const admin = mockAdmin({ tables: { admin_impersonation_sessions: [{ id: 'sess-2', school_id: 'school-1', admin_id: 'super-admin-id', target_profile_id: 'target-profile-1', ended_at: '2025-01-01T00:00:00Z' }] } });
    const res = await endImpersonation(admin, { session_id: 'sess-2' }, 'target-profile-1');
    check('endImpersonation on an already-closed session returns ok without re-auditing', res.ok === true && !admin._tables.admin_audit_log.length);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
})();
