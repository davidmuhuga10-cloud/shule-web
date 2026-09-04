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
 *   - Round 2 §6: Stream is a column IN the spreadsheet ("Arm"), read per
 *     row, so a single upload can enroll students into several different
 *     arms of the same class at once.
 *   - Round 4 §1 (BUG): Round 2 §6 originally made Arm optional per row —
 *     but that let a whole class of students land with no arm at all if the
 *     uploader just forgot the column, which was never actually desired.
 *     Reversed: Arm is now REQUIRED, same as Admission Number/Name/Gender —
 *     one blank Arm anywhere in the file blocks the entire import (via the
 *     same all-or-nothing validateRow() gate below) with a clear "stream not
 *     filled" reason, rather than silently importing that student arm-less.
 *     This is safe to require unconditionally now: Round 3 §17 already
 *     guarantees every class has at least one arm (a class can no longer
 *     exist with zero arms), so there's always something valid to type in.
 */
import { esc, toast, options, renderPrereq, renderPrereqOrConnectivity, $ } from '../app.js';
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
  { key: 'stream', label: 'Stream (required)' },
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
  admission_no: '101', full_name: 'Amina Otieno', gender: 'Female', stream: 'North',
  guardian_name: 'Jane Otieno', guardian_contact: '0712345678', guardian_relationship: 'Mother',
  guardian_id_number: '', date_of_birth: '', admission_date: '', upi_number: '', assessment_number: '',
  previous_school: '', medical_notes: ''
};

export async function viewBulkUpload(root) {
  // Perf/UX fix: paint the page shell instantly instead of leaving the
  // router's bare spinner up for the full round trip — see examDesk.mjs's
  // viewExamDesk for the fuller explanation of why this matters.
  root.innerHTML = `
    <div class="page-head"><div><h2>Bulk Upload</h2><p>Import many students at once from a spreadsheet — download the template, fill it in, then upload the same file back.</p></div></div>
    <div class="card"><div class="card-b">
      <div class="skeleton" style="width:100%;height:60px;margin-bottom:12px"></div>
      <div class="skeleton" style="width:100%;height:60px"></div>
    </div></div>
  `;
  const classesRes = await Db.classes.list();
  // Round 6 §5 (recurring BUG): see examAnalysis.mjs for the full story.
  if (!classesRes.ok) {
    renderPrereqOrConnectivity(root, { ok: false, onRetry: () => viewBulkUpload(root) });
    return;
  }
  const classes = classesRes.data;
  if (!classes.length) {
    renderPrereq(root, 'No classes found', 'Please create a class before bulk-uploading students.', 'classes', 'Go to Classes');
    return;
  }
  render(root, classes);
}

function downloadTemplate() {
  downloadXlsx('shuletop-student-upload-template.xlsx', [SAMPLE_ROW], TEMPLATE_COLUMNS, 'Students');
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

/** streamNames: lowercased set of the chosen class's real stream names, used
 *  to catch a typo'd stream before import rather than silently dropping it
 *  server-side.
 *  existingAdmissionSet: lowercased set of admission numbers already in use
 *  school-wide (Round 3 §2) — a duplicate now fails clearly AT PREVIEW time,
 *  matching how Add Student already blocks a duplicate immediately, instead
 *  of quietly slipping through to a same-looking-as-success import summary.
 *  seenInBatch: a Set the caller reuses across rows to also catch two rows
 *  in the SAME spreadsheet sharing an admission number. */
function validateRow(row, streamNames, existingAdmissionSet, seenInBatch) {
  if (!row.admission_no || !row.full_name) return 'Missing admission number or name.';
  if (VALID_GENDERS.indexOf(row.gender) === -1) return 'Gender must be exactly "Male" or "Female".';
  // Round 3 §1 root-cause fix: previously this only checked when the class
  // had at least one KNOWN stream (`streamNames.size`), so a class with zero
  // streams let any garbage Stream text sail through preview as "Ready" —
  // then failed server-side in bulkCreate(), which has never had that
  // exemption. Matching the server exactly here means preview never again
  // approves a row that's actually doomed to be skipped.
  const streamText = String(row.stream || '').trim();
  // Round 4 §1 (BUG): blank Arm used to be fine — now it's a hard error like
  // every other required field, so it trips the same "any error blocks the
  // whole Import button" gate this preview already enforces below.
  if (!streamText) return 'Stream not filled — every student must have a Stream.';
  if (!streamNames || !streamNames.has(streamText.toLowerCase())) {
    return `Stream "${streamText}" was not found for this class.`;
  }
  const admissionKey = String(row.admission_no || '').trim().toLowerCase();
  if (admissionKey) {
    if (existingAdmissionSet && existingAdmissionSet.has(admissionKey)) {
      return `A student with admission number "${row.admission_no}" already exists.`;
    }
    if (seenInBatch) {
      if (seenInBatch.has(admissionKey)) {
        return `Admission number "${row.admission_no}" is used by more than one row in this file.`;
      }
      seenInBatch.add(admissionKey);
    }
  }
  return null;
}

function render(root, classes, state) {
  state = state || { class_id: '', streams: [] };
  const streamNames = state.streams.length ? new Set(state.streams.map((s) => String(s.name).trim().toLowerCase())) : null;

  root.innerHTML = `
    <div class="page-head"><div><h2>Bulk Upload</h2><p>Import many students at once from a spreadsheet — download the template, fill it in, then upload the same file back.</p></div></div>
    <div class="card" style="margin-bottom:16px">
      <div class="card-h"><h3>1. Choose class</h3></div>
      <div class="card-b">
        <div class="field"><label>Class</label><select id="bu-class">${options(classes, 'id', 'name', state.class_id, 'Choose a class')}</select></div>
      </div>
      <div class="card-b" style="padding-top:0"><p class="hint">Every row you import will be enrolled into this class — the spreadsheet itself never sets the class.
        ${state.streams.length ? `This class has streams set up (${state.streams.map((s) => esc(s.name)).join(', ')}) — use the "Stream" column in the template to place each student into one. Every row needs one filled in.` : ''}</p></div>
    </div>

    <div class="card" style="margin-bottom:16px">
      <div class="card-h"><h3>2. Download template, fill it in, upload it back</h3></div>
      <div class="card-b">
        <p class="hint" style="margin-top:0">Admission Number, Student Name, Gender and Stream are all required for every row — every other column is optional, but filling them in now means you won't need to go back and edit each student afterward.</p>
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
    render(root, classes, { class_id: cid, streams: sres.ok ? sres.data : [] });
  };
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

  previewBtn.onclick = async () => {
    if (!root.querySelector('#bu-class').value) { toast('Please choose a class first.', 'err'); return; }
    if (!pendingRows || !pendingRows.length) { toast('Upload a filled-in template first.', 'err'); return; }
    previewBtn.disabled = true;
    const previewLabel = previewBtn.textContent;
    previewBtn.textContent = 'Checking…';
    const existingRes = await Db.students.existingAdmissionNumbers();
    previewBtn.disabled = false;
    previewBtn.textContent = previewLabel;
    renderPreview(root, classes, {
      class_id: root.querySelector('#bu-class').value,
      streamNames,
      existingAdmissionSet: new Set(existingRes.ok ? existingRes.data : []),
      rows: pendingRows
    });
  };
}

function renderPreview(root, classes, state) {
  const seenInBatch = new Set();
  const withStatus = state.rows.map((r) => ({ ...r, error: validateRow(r, state.streamNames, state.existingAdmissionSet, seenInBatch) }));
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
        <thead><tr><th class="num">Row</th><th>Admission No.</th><th>Name</th><th>Gender</th><th>Stream</th><th>Guardian</th><th>Status</th></tr></thead>
        <tbody>${withStatus.map((r, i) => `<tr style="${r.error ? 'background:var(--danger-bg)' : ''}">
          <td class="num">${i + 1}</td><td>${esc(r.admission_no)}</td><td>${esc(r.full_name)}</td><td>${esc(r.gender)}</td>
          <td>${esc(r.stream || '—')}</td>
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
    area.insertAdjacentHTML('beforeend', `<div class="card-b" id="bu-progress"><p class="hint">📥 Creating ${validCount} student record(s), please wait…</p></div>`);
    const validRows = withStatus.filter((r) => !r.error).map(({ error, ...r }) => r);
    const res = await Db.students.bulkCreate({ class_id: state.class_id, rows: validRows });
    if (!res.ok) { toast(res.message, 'err'); importBtn.disabled = false; importBtn.textContent = `Import ${validCount} student(s)`; $('#bu-progress', area)?.remove(); return; }

    // Provision logins in CHUNKS (one Netlify function round trip per chunk,
    // not per student — see admin-provision.js's createStudentsBulk) so a
    // 19-, 50-, or 200-student import no longer means 19/50/200 sequential
    // network round trips. Chunking (rather than one call for everything)
    // is what lets us show real incremental progress in between.
    const CHUNK = 15;
    const rows = res.createdRows || [];
    let provisioned = 0;
    const progressEl = $('#bu-progress', area);
    const setProgress = (done) => {
      if (!progressEl || !rows.length) return;
      const pct = Math.round((done / rows.length) * 100);
      progressEl.innerHTML = `<p class="hint">🔑 Setting up logins: ${done}/${rows.length} (${pct}%), please wait…</p>`;
    };
    setProgress(0);
    for (let i = 0; i < rows.length; i += CHUNK) {
      const chunk = rows.slice(i, i + CHUNK).map((r) => ({ student_id: r.id, admission_no: r.admission_no, full_name: r.full_name }));
      const prov = await Db.users.provisionStudentLogins(chunk);
      if (prov && prov.ok) provisioned += prov.provisioned || 0;
      setProgress(Math.min(i + CHUNK, rows.length));
    }

    // Round 3 §1: a green tick only ever appears when at least one student
    // was genuinely created — 0 created (every row skipped, e.g. because
    // every admission number turned out to already exist between preview
    // and import) is a clear red-X failure state instead, never disguised
    // as "Import complete".
    const succeeded = res.created > 0;
    area.innerHTML = `<div class="card"><div class="card-b">
      <div class="empty">
        <div class="e-ico">${succeeded ? '✅' : '❌'}</div><h3>${succeeded ? 'Import complete' : 'Import failed — nothing was created'}</h3>
        <p>${res.created} student(s) created${rows.length ? ` and ${provisioned} login(s) provisioned (default password: <b>student-&lt;admission number&gt;</b>)` : ''}.
        ${res.skipped.length ? `${res.skipped.length} row(s) were skipped — see the reasons below.` : ''}</p>
      </div>
      ${res.skipped.length ? `<div class="table-wrap"><table class="data">
        <thead><tr><th class="num">Row</th><th>Admission No.</th><th>Name</th><th>Reason</th></tr></thead>
        <tbody>${res.skipped.map((s) => `<tr><td class="num">${s.line}</td><td>${esc(s.admission_no)}</td><td>${esc(s.full_name)}</td><td>${esc(s.reason)}</td></tr>`).join('')}</tbody>
      </table></div>` : ''}
    </div></div>`;
    if (succeeded) toast(`Imported ${res.created} student(s).`, 'ok');
    else toast('Import failed — no students were created.', 'err');
  };
}
