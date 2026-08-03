/**
 * bulkUpload.mjs — Bulk Upload Students, redesigned per direct feedback:
 *   - No more "paste rows into a textarea" option — download the template,
 *     fill it in, upload the same file back. That's it.
 *   - Real .xlsx spreadsheets throughout (via src/lib/xlsxUtil.mjs), not CSV.
 *   - The template now covers every optional profile field too, so a whole
 *     class's full details can be imported in one go without a follow-up
 *     edit per student.
 *   - If ANY row fails validation (e.g. gender not filled in), the import is
 *     blocked entirely — fix it in the spreadsheet and re-upload, rather than
 *     silently skipping the bad rows.
 *   - Stream is required whenever the chosen class has streams set up (same
 *     rule as Add Student), enforced before you can even preview.
 */
import { esc, toast, options, renderPrereq } from '../app.js';
import { Db } from '../lib/api/index.mjs';
import { downloadXlsx, readXlsxFile } from '../lib/xlsxUtil.mjs';

const VALID_GENDERS = ['Male', 'Female'];

/** Column order is the contract between the template and the parser — kept
 *  simple/positional (no header-name matching) so re-arranging columns in
 *  the spreadsheet isn't silently "supported" in a half-working way. */
const TEMPLATE_COLUMNS = [
  { key: 'admission_no', label: 'Admission Number' },
  { key: 'full_name', label: 'Student Name' },
  { key: 'gender', label: 'Gender (Male/Female)' },
  { key: 'guardian_name', label: 'Guardian Name' },
  { key: 'guardian_contact', label: 'Guardian Contact' },
  { key: 'guardian_relationship', label: 'Guardian Relationship' },
  { key: 'guardian_id_number', label: 'Guardian ID Number' },
  { key: 'date_of_birth', label: 'Date of Birth (YYYY-MM-DD)' },
  { key: 'admission_date', label: 'Admission Date (YYYY-MM-DD)' },
  { key: 'upi_number', label: 'UPI Number (NEMIS)' },
  { key: 'assessment_number', label: 'Assessment Number (KNEC)' },
  { key: 'previous_school', label: 'Previous School' },
  { key: 'medical_notes', label: 'Medical Notes' }
];
const SAMPLE_ROW = {
  admission_no: '101', full_name: 'Amina Otieno', gender: 'Female',
  guardian_name: 'Jane Otieno', guardian_contact: '0712345678', guardian_relationship: 'Mother',
  guardian_id_number: '', date_of_birth: '', admission_date: '', upi_number: '', assessment_number: '',
  previous_school: '', medical_notes: ''
};

export async function viewBulkUpload(root) {
  const classesRes = await Db.classes.list();
  const classes = classesRes.ok ? classesRes.data : [];
  if (!classes.length) {
    renderPrereq(root, 'No classes found', 'Please create a class before bulk-uploading students.', 'classes', 'Go to Classes');
    return;
  }
  render(root, classes);
}

function downloadTemplate() {
  downloadXlsx('shule-student-upload-template.xlsx', [SAMPLE_ROW], TEMPLATE_COLUMNS, 'Students');
}

function looksLikeHeaderRow(row) {
  const first = String(row[0] || '').toLowerCase();
  const second = String(row[1] || '').toLowerCase();
  return first.indexOf('admission') !== -1 && second.indexOf('name') !== -1;
}

function rowsFromSheet(sheetRows) {
  const dataRows = sheetRows.length && looksLikeHeaderRow(sheetRows[0]) ? sheetRows.slice(1) : sheetRows;
  return dataRows
    .filter((r) => r.some((cell) => String(cell || '').trim() !== ''))
    .map((r) => {
      const row = {};
      TEMPLATE_COLUMNS.forEach((c, i) => { row[c.key] = String(r[i] || '').trim(); });
      return row;
    });
}

function validateRow(row) {
  if (!row.admission_no || !row.full_name) return 'Missing admission number or name.';
  if (VALID_GENDERS.indexOf(row.gender) === -1) return 'Gender must be exactly "Male" or "Female".';
  return null;
}

function render(root, classes, state) {
  state = state || { class_id: '', stream_id: '', streams: [] };
  const hasStreams = state.streams.length > 0;

  root.innerHTML = `
    <div class="page-head"><div><h2>Bulk Upload</h2><p>Import many students at once from a spreadsheet — download the template, fill it in, then upload the same file back.</p></div></div>
    <div class="card" style="margin-bottom:16px">
      <div class="card-h"><h3>1. Choose class &amp; stream</h3></div>
      <div class="card-b grid2">
        <div class="field"><label>Class</label><select id="bu-class">${options(classes, 'id', 'name', state.class_id, 'Choose a class')}</select></div>
        <div class="field"><label>Stream ${hasStreams ? '<span style="color:var(--danger,#c0392b)">*</span>' : '<span class="muted">(none for this class)</span>'}</label><select id="bu-stream" ${hasStreams ? '' : 'disabled'}><option value="">${hasStreams ? 'Choose a stream' : 'No streams on this class'}</option>${options(state.streams, 'id', 'name', state.stream_id)}</select></div>
      </div>
      <div class="card-b" style="padding-top:0"><p class="hint">Every row you import will be enrolled into this class/stream — the spreadsheet itself never sets the class. A stream must be chosen whenever the class has streams set up, same as adding one student at a time.</p></div>
    </div>

    <div class="card" style="margin-bottom:16px">
      <div class="card-h"><h3>2. Download template, fill it in, upload it back</h3></div>
      <div class="card-b">
        <p class="hint" style="margin-top:0">Only Admission Number, Student Name and Gender are required — every other column is optional, but filling them in now means you won't need to go back and edit each student afterward.</p>
        <button class="btn secondary" id="bu-template">⬇ Download template (.xlsx)</button>
        <div class="field" style="margin-top:14px"><label>Upload the filled-in spreadsheet</label><input id="bu-file" type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"></div>
        <button class="btn" id="bu-preview" style="margin-top:6px" disabled>Preview</button>
      </div>
    </div>

    <div id="bu-preview-area"></div>
  `;

  root.querySelector('#bu-class').onchange = async (e) => {
    const cid = e.target.value;
    const sres = cid ? await Db.streams.list(cid) : { ok: true, data: [] };
    render(root, classes, { class_id: cid, stream_id: '', streams: sres.ok ? sres.data : [] });
  };
  root.querySelector('#bu-stream').onchange = (e) => { state.stream_id = e.target.value; };
  root.querySelector('#bu-template').onclick = downloadTemplate;

  let pendingRows = null;
  const previewBtn = root.querySelector('#bu-preview');
  root.querySelector('#bu-file').onchange = async (e) => {
    const file = e.target.files[0];
    pendingRows = null;
    previewBtn.disabled = true;
    if (!file) return;
    try {
      const sheetRows = await readXlsxFile(file);
      pendingRows = rowsFromSheet(sheetRows);
      previewBtn.disabled = pendingRows.length === 0;
      if (!pendingRows.length) toast('No rows found in that spreadsheet.', 'err');
    } catch (err) {
      toast('Could not read that file — please upload the .xlsx template.', 'err');
    }
  };

  previewBtn.onclick = () => {
    if (!root.querySelector('#bu-class').value) { toast('Please choose a class first.', 'err'); return; }
    if (hasStreams && !root.querySelector('#bu-stream').value) { toast('Please choose a stream — this class has streams set up.', 'err'); return; }
    if (!pendingRows || !pendingRows.length) { toast('Upload a filled-in template first.', 'err'); return; }
    renderPreview(root, classes, {
      class_id: root.querySelector('#bu-class').value,
      stream_id: root.querySelector('#bu-stream').value,
      streams: state.streams,
      rows: pendingRows
    });
  };
}

function renderPreview(root, classes, state) {
  const withStatus = state.rows.map((r) => ({ ...r, error: validateRow(r) }));
  const validCount = withStatus.filter((r) => !r.error).length;
  const invalidCount = withStatus.length - validCount;
  const blocked = invalidCount > 0;

  const area = root.querySelector('#bu-preview-area');
  area.innerHTML = `
    <div class="card">
      <div class="card-h"><h3>3. Preview (${state.rows.length} row(s))</h3>
        <div class="spacer"></div>
        <button class="btn" id="bu-import" ${blocked ? 'disabled' : ''}>Import ${validCount} student(s)</button>
      </div>
      ${blocked ? `<div class="card-b" style="padding-bottom:0"><p class="hint" style="color:var(--danger,#c0392b)">
        ${invalidCount} row(s) have an error — fix them in the spreadsheet and re-upload. Nothing will be imported until every row is valid.</p></div>`
        : `<div class="card-b" style="padding-bottom:0"><p class="hint" style="color:var(--ok,#1a7f4b)">All ${validCount} row(s) look good — ready to import.</p></div>`}
      <div class="card-b table-wrap"><table class="data">
        <thead><tr><th class="num">Row</th><th>Admission No.</th><th>Name</th><th>Gender</th><th>Guardian</th><th>Status</th></tr></thead>
        <tbody>${withStatus.map((r, i) => `<tr style="${r.error ? 'background:var(--danger-bg)' : ''}">
          <td class="num">${i + 1}</td><td>${esc(r.admission_no)}</td><td>${esc(r.full_name)}</td><td>${esc(r.gender)}</td>
          <td>${esc(r.guardian_name)}${r.guardian_contact ? ' · ' + esc(r.guardian_contact) : ''}</td>
          <td>${r.error ? `<span class="badge red">${esc(r.error)}</span>` : '<span class="badge green">Ready</span>'}</td>
        </tr>`).join('')}</tbody>
      </table></div>
    </div>
  `;

  const importBtn = area.querySelector('#bu-import');
  if (blocked) return;

  importBtn.onclick = async () => {
    importBtn.disabled = true; importBtn.textContent = 'Importing…';
    const validRows = withStatus.filter((r) => !r.error).map(({ error, ...r }) => r);
    const res = await Db.students.bulkCreate({ class_id: state.class_id, stream_id: state.stream_id || null, rows: validRows });
    if (!res.ok) { toast(res.message, 'err'); importBtn.disabled = false; importBtn.textContent = `Import ${validCount} student(s)`; return; }

    let provisioned = 0;
    for (const row of res.createdRows || []) {
      const prov = await Db.users.provisionStudentLogin({ student_id: row.id, admission_no: row.admission_no, full_name: row.full_name });
      if (prov && prov.ok) provisioned++;
    }

    area.innerHTML = `<div class="card"><div class="card-b">
      <div class="empty">
        <div class="e-ico">✅</div><h3>Import complete</h3>
        <p>${res.created} student(s) created${res.createdRows && res.createdRows.length ? ` and ${provisioned} login(s) provisioned (default password: <b>student-&lt;admission number&gt;</b>)` : ''}.
        ${res.skipped.length ? `${res.skipped.length} row(s) were skipped (duplicate admission numbers).` : ''}</p>
      </div>
      ${res.skipped.length ? `<div class="table-wrap"><table class="data">
        <thead><tr><th class="num">Row</th><th>Admission No.</th><th>Name</th><th>Reason</th></tr></thead>
        <tbody>${res.skipped.map((s) => `<tr><td class="num">${s.line}</td><td>${esc(s.admission_no)}</td><td>${esc(s.full_name)}</td><td>${esc(s.reason)}</td></tr>`).join('')}</tbody>
      </table></div>` : ''}
    </div></div>`;
    toast(`Imported ${res.created} student(s).`, 'ok');
  };
}
