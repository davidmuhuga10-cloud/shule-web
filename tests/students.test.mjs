import { createMockSupabase } from './helpers/mockSupabase.mjs';
import { createStudentsApi } from '../src/lib/api/students.mjs';

let passed = 0, failed = 0;
function check(name, cond) { if (cond) passed++; else { failed++; console.error('FAIL:', name); } }

async function run() {
  // ---- list + numeric sort ---------------------------------------------------
  {
    const sb = createMockSupabase({
      classes: [{ id: 'c1', name: 'Grade 7' }],
      students: [
        { id: 's1', admission_no: '23', full_name: 'Jane', gender: 'Female', class_id: 'c1', status: 'active' },
        { id: 's2', admission_no: '5', full_name: 'Amos', gender: 'Male', class_id: 'c1', status: 'active' },
        { id: 's3', admission_no: '100', full_name: 'Zed', gender: 'Male', class_id: 'c1', status: 'active' },
        { id: 's4', admission_no: '1', full_name: 'Inactive Kid', gender: 'Male', class_id: 'c1', status: 'inactive' }
      ]
    });
    const api = createStudentsApi(sb);
    const res = await api.list({ class_id: 'c1' });
    check('list() only returns active students by default', res.data.length === 3);
    check('list() sorts numerically (5, 23, 100), not alphabetically', res.data.map((s) => s.admission_no).join(',') === '5,23,100');
    check('list() joins class_name', res.data[0].class_name === 'Grade 7');
  }

  // ---- search (brief §5) -------------------------------------------------------
  {
    const sb = createMockSupabase({
      classes: [{ id: 'c1', name: 'Grade 7' }, { id: 'c2', name: 'Grade 8' }],
      students: [
        { id: 's1', admission_no: '2023', full_name: 'Jane Wanjiru', gender: 'Female', class_id: 'c1', status: 'active' },
        { id: 's2', admission_no: '2045', full_name: 'Amos Otieno', gender: 'Male', class_id: 'c2', status: 'active' },
        { id: 's3', admission_no: '9999', full_name: 'Left Student', gender: 'Male', class_id: 'c1', status: 'left' }
      ]
    });
    const api = createStudentsApi(sb);
    const byName = await api.search('jane');
    check('search matches by name, case-insensitively', byName.data.length === 1 && byName.data[0].id === 's1');
    const byAdm = await api.search('2045');
    check('search matches by admission number', byAdm.data.length === 1 && byAdm.data[0].id === 's2');
    check('search only considers active students', (await api.search('left student')).data.length === 0);
    check('search returns nothing for a blank query', (await api.search('   ')).data.length === 0);
    check('search joins class_name like list() does', byAdm.data[0].class_name === 'Grade 8');
  }

  // ---- save validation --------------------------------------------------------
  {
    const sb = createMockSupabase({ classes: [{ id: 'c1', name: 'Grade 7' }] });
    const api = createStudentsApi(sb);
    check('save rejects missing admission number', (await api.save({ full_name: 'X', gender: 'Male', class_id: 'c1' })).ok === false);
    check('save rejects missing name', (await api.save({ admission_no: '1', gender: 'Male', class_id: 'c1' })).ok === false);
    check('save rejects an invalid gender', (await api.save({ admission_no: '1', full_name: 'X', gender: 'Other', class_id: 'c1' })).ok === false);
    check('save rejects a missing class', (await api.save({ admission_no: '1', full_name: 'X', gender: 'Male' })).ok === false);
    const good = await api.save({ admission_no: '1', full_name: 'Amos', gender: 'Male', class_id: 'c1' });
    check('save accepts a valid student', good.ok === true);
  }
  {
    const sb = createMockSupabase({ students: [{ id: 's1', admission_no: '23', full_name: 'Jane', gender: 'Female', class_id: 'c1' }] });
    const api = createStudentsApi(sb);
    const dup = await api.save({ admission_no: '23', full_name: 'Someone Else', gender: 'Male', class_id: 'c1' });
    check('save rejects a duplicate admission number', dup.ok === false);
    // Editing the SAME student with their own admission number must be allowed.
    const selfEdit = await api.save({ id: 's1', admission_no: '23', full_name: 'Jane Updated', gender: 'Female', class_id: 'c1' });
    check('save allows re-saving the same student with their own admission number', selfEdit.ok === true);
  }

  // ---- richer profile fields (Phase 2c) -----------------------------------------
  {
    const sb = createMockSupabase({});
    const api = createStudentsApi(sb);
    const saved = await api.save({
      admission_no: '1', full_name: 'Amos', gender: 'Male', class_id: 'c1',
      date_of_birth: '2015-03-14', admission_date: '2022-01-10',
      upi_number: 'UPI123', assessment_number: 'KNEC456', previous_school: 'Green Hills Academy',
      guardian_relationship: 'Mother', guardian_id_number: '12345678', medical_notes: 'Asthma'
    });
    check('save persists richer profile fields', saved.ok === true
      && saved.data.date_of_birth === '2015-03-14' && saved.data.admission_date === '2022-01-10'
      && saved.data.upi_number === 'UPI123' && saved.data.assessment_number === 'KNEC456'
      && saved.data.previous_school === 'Green Hills Academy' && saved.data.guardian_relationship === 'Mother'
      && saved.data.guardian_id_number === '12345678' && saved.data.medical_notes === 'Asthma');
    const minimal = await api.save({ admission_no: '2', full_name: 'Bee', gender: 'Female', class_id: 'c1' });
    check('save defaults richer profile fields to blank/null when omitted', minimal.ok === true
      && minimal.data.date_of_birth === null && minimal.data.upi_number === '');
  }

  // ---- stream required unless the class has no streams (feature brief) --------
  {
    const sb = createMockSupabase({
      classes: [{ id: 'c1', name: 'Grade 7' }, { id: 'c2', name: 'Grade 8' }],
      streams: [{ id: 'str1', class_id: 'c1', name: 'North' }]
    });
    const api = createStudentsApi(sb);
    const noStream = await api.save({ admission_no: '1', full_name: 'Amos', gender: 'Male', class_id: 'c1' });
    check('save rejects a missing stream when the class has streams', noStream.ok === false);
    const withStream = await api.save({ admission_no: '1', full_name: 'Amos', gender: 'Male', class_id: 'c1', stream_id: 'str1' });
    check('save accepts a stream when the class has streams', withStream.ok === true);
    const noStreamNeeded = await api.save({ admission_no: '2', full_name: 'Bee', gender: 'Female', class_id: 'c2' });
    check('save does not require a stream when the class has none', noStreamNeeded.ok === true);
  }

  // ---- bulkCreate --------------------------------------------------------------
  {
    const sb = createMockSupabase({ students: [{ id: 's1', admission_no: '10', full_name: 'Existing Kid' }] });
    const api = createStudentsApi(sb);
    const res = await api.bulkCreate({
      class_id: 'c1',
      rows: [
        { admission_no: '11', full_name: 'New Kid A', gender: 'Male' },
        { admission_no: '12', full_name: 'New Kid B', gender: 'Female' },
        { admission_no: '10', full_name: 'Clashes With Existing', gender: 'Male' }, // dup vs existing
        { admission_no: '13', full_name: '', gender: 'Male' }, // missing name
        { admission_no: '', full_name: 'No Admission No', gender: 'Male' }, // missing admission no
        { admission_no: '14', full_name: 'Bad Gender', gender: 'Other' }, // bad gender
        { admission_no: '11', full_name: 'Duplicate In File', gender: 'Male' } // dup within the same batch
      ]
    });
    check('bulkCreate succeeds', res.ok === true);
    check('bulkCreate creates exactly the 2 valid, non-duplicate rows', res.created === 2);
    check('bulkCreate reports 5 skipped rows with reasons', res.skipped.length === 5);
    check('bulkCreate reports the correct total', res.total === 7);
    const listed = await api.list({ class_id: 'c1' });
    check('bulkCreate actually inserted the accepted rows', listed.data.some((s) => s.admission_no === '11') && listed.data.some((s) => s.admission_no === '12'));
    check('bulkCreate returns the created rows (with ids) for login provisioning', res.createdRows.length === 2 && res.createdRows.every((r) => r.id));
  }
  {
    const sb = createMockSupabase({});
    const api = createStudentsApi(sb);
    const res = await api.bulkCreate({ rows: [{ admission_no: '1', full_name: 'X', gender: 'Male' }] });
    check('bulkCreate requires a class to be chosen', res.ok === false);
  }
  {
    // Round 2 §6: stream is now read PER ROW from the spreadsheet's own
    // "Stream" column, and is always optional — even for a class that has
    // streams set up. The old "choose one stream for the whole batch up
    // front, and it's compulsory" gate is gone entirely.
    const sb = createMockSupabase({
      classes: [{ id: 'c1', name: 'Grade 7' }],
      streams: [{ id: 'str1', class_id: 'c1', name: 'North' }, { id: 'str2', class_id: 'c1', name: 'South' }]
    });
    const api = createStudentsApi(sb);
    const noStream = await api.bulkCreate({ class_id: 'c1', rows: [{ admission_no: '1', full_name: 'X', gender: 'Male' }] });
    check('bulkCreate no longer requires a stream when the class has streams', noStream.ok === true && noStream.created === 1);
    check('bulkCreate leaves stream_id null when the row names none', noStream.createdRows[0].stream_id === null);

    const withStream = await api.bulkCreate({ class_id: 'c1', rows: [{ admission_no: '2', full_name: 'Y', gender: 'Male', stream: 'North' }] });
    check('bulkCreate resolves a per-row stream name to the right stream_id', withStream.ok === true && withStream.createdRows[0].stream_id === 'str1');

    const caseInsensitive = await api.bulkCreate({ class_id: 'c1', rows: [{ admission_no: '3', full_name: 'Z', gender: 'Male', stream: ' south ' }] });
    check('bulkCreate matches a per-row stream name case-insensitively and trims whitespace', caseInsensitive.ok === true && caseInsensitive.createdRows[0].stream_id === 'str2');

    const unknownStream = await api.bulkCreate({ class_id: 'c1', rows: [{ admission_no: '4', full_name: 'Unknown Stream Kid', gender: 'Male', stream: 'Nonexistent' }] });
    check('bulkCreate skips a row naming a stream that does not exist on this class', unknownStream.ok === true && unknownStream.created === 0);
    check('bulkCreate reports why the unknown-stream row was skipped', unknownStream.skipped.length === 1 && /not found/i.test(unknownStream.skipped[0].reason));

    // A single upload spanning multiple streams in the same class, in one batch.
    const multiStream = await api.bulkCreate({
      class_id: 'c1',
      rows: [
        { admission_no: '5', full_name: 'North Kid', gender: 'Male', stream: 'North' },
        { admission_no: '6', full_name: 'South Kid', gender: 'Female', stream: 'South' }
      ]
    });
    check('bulkCreate can enroll students into different streams of the same class in one upload',
      multiStream.ok === true && multiStream.created === 2
      && multiStream.createdRows.find((r) => r.admission_no === '5').stream_id === 'str1'
      && multiStream.createdRows.find((r) => r.admission_no === '6').stream_id === 'str2');
  }
  {
    // Richer bio-data fields flow through bulkCreate exactly like the single
    // Add Student form's "More details" section (brief: "one can upload a
    // lot of information via the sheet without having to go back and edit").
    const sb = createMockSupabase({ classes: [{ id: 'c1', name: 'Grade 7' }] });
    const api = createStudentsApi(sb);
    const res = await api.bulkCreate({
      class_id: 'c1',
      rows: [{
        admission_no: '1', full_name: 'Amos', gender: 'Male',
        date_of_birth: '2015-03-14', admission_date: '2022-01-10',
        upi_number: 'UPI123', assessment_number: 'KNEC456', previous_school: 'Green Hills Academy',
        guardian_relationship: 'Mother', guardian_id_number: '12345678', medical_notes: 'Asthma'
      }]
    });
    check('bulkCreate succeeds with richer bio-data columns', res.ok === true && res.created === 1);
    const saved = res.createdRows[0];
    check('bulkCreate persists richer bio-data fields', saved.date_of_birth === '2015-03-14' && saved.upi_number === 'UPI123'
      && saved.assessment_number === 'KNEC456' && saved.previous_school === 'Green Hills Academy'
      && saved.guardian_relationship === 'Mother' && saved.guardian_id_number === '12345678' && saved.medical_notes === 'Asthma');
  }

  // ---- archive / restore (Phase 2b: soft-remove instead of hard delete) --------
  {
    const sb = createMockSupabase({
      classes: [{ id: 'c1', name: 'Grade 7' }],
      students: [{ id: 's1', admission_no: '1', full_name: 'Jane', gender: 'Female', class_id: 'c1', status: 'active' }]
    });
    const api = createStudentsApi(sb);

    const archived = await api.archive('s1', { reason: 'transferred', notes: 'Moved to Nairobi' });
    check('archive() moves status to left', archived.ok === true && archived.data.status === 'left');
    check('archive() records the reason and notes', archived.data.left_reason === 'transferred' && archived.data.left_notes === 'Moved to Nairobi');
    check('archive() stamps a left_date automatically when none given', !!archived.data.left_date);

    const activeList = await api.list({ class_id: 'c1' });
    check('archived student no longer appears in the default (active) list', activeList.data.length === 0);
    const archivedList = await api.list({ class_id: 'c1', status: 'left' });
    check('archived student appears when explicitly asking for status=left', archivedList.data.length === 1);

    const restored = await api.restore('s1');
    check('restore() moves status back to active', restored.ok === true && restored.data.status === 'active');
    check('restore() clears the leaving reason/date/notes', restored.data.left_reason === null && restored.data.left_date === null);
    const activeAgain = await api.list({ class_id: 'c1' });
    check('restored student reappears in the active list', activeAgain.data.length === 1);
  }
  {
    const sb = createMockSupabase({});
    const api = createStudentsApi(sb);
    const noId = await api.archive(null, {});
    check('archive() requires a student id', noId.ok === false);
  }
  {
    const sb = createMockSupabase({
      students: [{ id: 's1', admission_no: '1', full_name: 'Jane', gender: 'Female', class_id: 'c1', status: 'active' }]
    });
    const api = createStudentsApi(sb);
    const archived = await api.archive('s1', { reason: 'not-a-real-reason' });
    check('archive() falls back to "other" for an unrecognized reason', archived.ok === true && archived.data.left_reason === 'other');
  }

  // ---- bulkMove (Phase 2b: move a whole class/stream at once) ------------------
  {
    const sb = createMockSupabase({
      classes: [{ id: 'c1', name: 'Grade 7' }, { id: 'c2', name: 'Grade 8' }],
      streams: [{ id: 'str1', class_id: 'c2', name: 'North' }],
      students: [
        { id: 's1', admission_no: '1', full_name: 'A', gender: 'Male', class_id: 'c1', status: 'active' },
        { id: 's2', admission_no: '2', full_name: 'B', gender: 'Female', class_id: 'c1', status: 'active' },
        { id: 's3', admission_no: '3', full_name: 'C', gender: 'Male', class_id: 'c1', status: 'active' }
      ]
    });
    const api = createStudentsApi(sb);

    check('bulkMove requires at least one student', (await api.bulkMove({ class_id: 'c2' })).ok === false);
    check('bulkMove requires a target class', (await api.bulkMove({ student_ids: ['s1'] })).ok === false);

    const moved = await api.bulkMove({ student_ids: ['s1', 's2'], class_id: 'c2', stream_id: 'str1' });
    check('bulkMove reports how many students moved', moved.ok === true && moved.moved === 2);

    const inC2 = await api.list({ class_id: 'c2' });
    check('the two moved students are now in the new class', inC2.data.length === 2);
    check('the two moved students carried the new stream', inC2.data.every((s) => s.stream_id === 'str1'));
    const stillInC1 = await api.list({ class_id: 'c1' });
    check('the un-selected student stayed in the original class', stillInC1.data.length === 1 && stillInC1.data[0].id === 's3');
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

run();
