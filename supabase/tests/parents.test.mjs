import { createMockSupabase } from './helpers/mockSupabase.mjs';
import { createParentsApi } from '../src/lib/api/parents.mjs';

let passed = 0, failed = 0;
function check(name, cond) { if (cond) passed++; else { failed++; console.error('FAIL:', name); } }

async function run() {
  // ---- list: admin-side parent accounts ----------------------------------------
  {
    const sb = createMockSupabase({
      profiles: [
        { id: 'p1', name: 'Jane Parent', email: 'x@y.parents.shule.internal', role: 'parent', status: 'active' },
        { id: 'p2', name: 'Mr Teacher', email: 't@school.com', role: 'teacher', status: 'active' }
      ]
    });
    const api = createParentsApi(sb, async () => ({ ok: true }));
    const res = await api.list();
    check('list only returns parent-role profiles', res.ok === true && res.data.length === 1 && res.data[0].id === 'p1');
  }

  // ---- links: merges parent + student names --------------------------------------
  {
    const sb = createMockSupabase({
      profiles: [{ id: 'p1', name: 'Jane Parent', email: 'jane@x.internal', role: 'parent' }],
      students: [{ id: 's1', full_name: 'Amos', admission_no: '5' }],
      parent_links: [{ id: 'l1', parent_profile_id: 'p1', student_id: 's1', relationship: 'Mother', created_at: 't1' }]
    });
    const api = createParentsApi(sb, async () => ({ ok: true }));
    const res = await api.links();
    check('links succeeds', res.ok === true && res.data.length === 1);
    check('links attaches the parent name', res.data[0].parent_name === 'Jane Parent');
    check('links attaches the student name + admission no', res.data[0].student_name === 'Amos' && res.data[0].admission_no === '5');
  }
  {
    const sb = createMockSupabase({});
    const api = createParentsApi(sb, async () => ({ ok: true }));
    const res = await api.links();
    check('links handles no links at all', res.ok === true && res.data.length === 0);
  }

  // ---- provision: validates then delegates to the injected admin function -------
  {
    let calledWith = null;
    const sb = createMockSupabase({});
    const api = createParentsApi(sb, async (action, payload) => { calledWith = { action, payload }; return { ok: true }; });
    check('provision rejects missing name/phone', (await api.provision({})).ok === false);
    const res = await api.provision({ full_name: 'Jane Parent', phone: '0712345678' });
    check('provision delegates to create_parent', res.ok === true && calledWith.action === 'create_parent');
    check('provision passes through name and phone', calledWith.payload.full_name === 'Jane Parent' && calledWith.payload.phone === '0712345678');
  }

  // ---- linkStudent / unlink -------------------------------------------------------
  {
    const sb = createMockSupabase({});
    const api = createParentsApi(sb, async () => ({ ok: true }));
    check('linkStudent requires both a parent and a student', (await api.linkStudent({})).ok === false);
    const res = await api.linkStudent({ parent_profile_id: 'p1', student_id: 's1', relationship: 'Father' });
    check('linkStudent inserts a parent_links row', res.ok === true && sb._tables.parent_links.length === 1);
    check('linkStudent stores the relationship', sb._tables.parent_links[0].relationship === 'Father');

    const unlinkRes = await api.unlink(res.data.id);
    check('unlink removes the row', unlinkRes.ok === true && sb._tables.parent_links.length === 0);
  }
  {
    const sb = createMockSupabase({});
    const api = createParentsApi(sb, async () => ({ ok: true }));
    check('unlink requires a link id', (await api.unlink()).ok === false);
  }

  // ---- myChildren: parent-side read ------------------------------------------------
  {
    const sb = createMockSupabase({
      classes: [{ id: 'c1', name: 'Grade 7' }],
      students: [
        { id: 's1', admission_no: '23', full_name: 'Jane Jr', class_id: 'c1', stream_id: null, guardian_name: '', guardian_contact: '' },
        { id: 's2', admission_no: '5', full_name: 'Amos Jr', class_id: 'c1', stream_id: null, guardian_name: '', guardian_contact: '' }
      ],
      // Simulates RLS already having scoped this to the signed-in parent's own links.
      parent_links: [
        { id: 'l1', parent_profile_id: 'p1', student_id: 's1', relationship: 'Mother' },
        { id: 'l2', parent_profile_id: 'p1', student_id: 's2', relationship: 'Mother' }
      ]
    });
    const api = createParentsApi(sb, async () => ({ ok: true }));
    const res = await api.myChildren();
    check('myChildren succeeds', res.ok === true);
    check('myChildren returns both linked children', res.data.length === 2);
    check('myChildren sorts numerically by admission number', res.data.map((c) => c.admission_no).join(',') === '5,23');
    check('myChildren attaches the class name', res.data[0].class_name === 'Grade 7');
    check('myChildren attaches the relationship', res.data[0].relationship === 'Mother');
  }
  {
    const sb = createMockSupabase({ parent_links: [] });
    const api = createParentsApi(sb, async () => ({ ok: true }));
    const res = await api.myChildren();
    check('myChildren returns an empty list for a parent with no links', res.ok === true && res.data.length === 0);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

run();
