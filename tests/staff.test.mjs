/**
 * Unit tests for src/lib/api/staff.mjs, covering save() plus the new
 * bulkCreate() added for Round 2 §5 ("Add bulk upload for Teachers/Staff,
 * matching the bulk upload capability that already exists for Students").
 */
import { createMockSupabase } from './helpers/mockSupabase.mjs';
import { createStaffApi } from '../src/lib/api/staff.mjs';

let passed = 0, failed = 0;
function check(name, cond) { if (cond) passed++; else { failed++; console.error('FAIL:', name); } }

async function run() {
  // ---- save() -----------------------------------------------------------
  {
    const sb = createMockSupabase({});
    const api = createStaffApi(sb);
    const res = await api.save({ full_name: 'Mercy Njeri', role: 'Teacher' });
    check('save creates a staff member', res.ok === true && res.data.full_name === 'Mercy Njeri');
  }
  {
    const sb = createMockSupabase({});
    const api = createStaffApi(sb);
    const res = await api.save({ full_name: '' });
    check('save rejects a missing full name', res.ok === false);
  }

  // ---- bulkCreate() -------------------------------------------------------
  {
    const sb = createMockSupabase({});
    const api = createStaffApi(sb);
    const res = await api.bulkCreate({
      rows: [
        { full_name: 'Amina Otieno', role: 'Teacher', phone: '0711111111' },
        { full_name: 'Brian Kiptoo', role: 'Bursar', phone: '0722222222' },
        { full_name: 'Cynthia Wanjiru', role: 'Teacher', is_admin: true }
      ]
    });
    check('bulkCreate imports every valid row', res.ok === true && res.created === 3);
    check('bulkCreate returns one createdRow per import', res.createdRows.length === 3);
    check('bulkCreate carries the is_admin flag through for login provisioning', res.createdRows[2].is_admin === true);
    check('bulkCreate defaults is_admin to false when not set', res.createdRows[0].is_admin === false);
    check('bulkCreate defaults role to Teacher only when the row omits one', sb._tables.staff[1].role === 'Bursar');
  }
  {
    const sb = createMockSupabase({});
    const api = createStaffApi(sb);
    const res = await api.bulkCreate({ rows: [] });
    check('bulkCreate rejects an empty batch', res.ok === false);
  }
  {
    const sb = createMockSupabase({});
    const api = createStaffApi(sb);
    const res = await api.bulkCreate({
      rows: [
        { full_name: '' , role: 'Teacher' },
        { full_name: 'Valid Person', role: 'Teacher' }
      ]
    });
    check('bulkCreate skips a row missing a full name rather than failing the whole batch', res.ok === true && res.created === 1);
    check('bulkCreate reports the skipped row with a reason', res.skipped.length === 1 && /full name/i.test(res.skipped[0].reason));
  }
  {
    // Duplicate email within the SAME batch is skipped, second occurrence only.
    const sb = createMockSupabase({});
    const api = createStaffApi(sb);
    const res = await api.bulkCreate({
      rows: [
        { full_name: 'First Person', email: 'shared@example.com', role: 'Teacher' },
        { full_name: 'Second Person', email: 'shared@example.com', role: 'Teacher' }
      ]
    });
    check('bulkCreate imports the first of a same-batch duplicate email', res.created === 1);
    check('bulkCreate skips the later duplicate-email row', res.skipped.length === 1 && /duplicate email/i.test(res.skipped[0].reason));
  }
  {
    // Duplicate email against an ALREADY-EXISTING staff record is skipped too.
    const sb = createMockSupabase({ staff: [{ id: 'existing-1', full_name: 'Existing Person', email: 'taken@example.com' }] });
    const api = createStaffApi(sb);
    const res = await api.bulkCreate({ rows: [{ full_name: 'New Person', email: 'taken@example.com', role: 'Teacher' }] });
    check('bulkCreate skips a row whose email already exists in the school', res.ok === true && res.created === 0);
    check('bulkCreate reports the existing-email skip', res.skipped.length === 1);
  }
  {
    // Rows with no email at all never collide with each other, even though
    // the empty string would otherwise look like a shared "duplicate".
    const sb = createMockSupabase({});
    const api = createStaffApi(sb);
    const res = await api.bulkCreate({
      rows: [
        { full_name: 'No Email One', role: 'Teacher' },
        { full_name: 'No Email Two', role: 'Teacher' }
      ]
    });
    check('bulkCreate does not treat two blank emails as duplicates of each other', res.created === 2);
  }
  {
    // Index alignment: is_admin flags must land on the RIGHT created row even
    // when earlier rows were skipped (this was a real bug caught in review —
    // createdRows used to be zipped against the original `rows` array by
    // position instead of against the filtered insert list).
    const sb = createMockSupabase({});
    const api = createStaffApi(sb);
    const res = await api.bulkCreate({
      rows: [
        { full_name: '', role: 'Teacher' }, // skipped — shifts every later index
        { full_name: 'Admin Person', role: 'Teacher', is_admin: true },
        { full_name: 'Regular Person', role: 'Teacher', is_admin: false }
      ]
    });
    const admin = res.createdRows.find((r) => r.full_name === 'Admin Person');
    const regular = res.createdRows.find((r) => r.full_name === 'Regular Person');
    check('bulkCreate keeps is_admin correctly attached after an earlier row is skipped', admin.is_admin === true && regular.is_admin === false);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

run();
