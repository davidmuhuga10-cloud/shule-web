import { esc, toast, options, renderPrereq } from '../app.js';
import { Db } from '../lib/api/index.mjs';

const VALID_GENDERS = ['Male', 'Female'];
const TEMPLATE_HEADER = 'Admission Number,Student Name,Gender,Guardian Name,Guardian Contact';
const TEMPLATE_SAMPLE = '101,Amina Otieno,Female,Jane Otieno,0712345678';

export async function viewBulkUpload(root) {
  const classesRes = await Db.classes.list();
  const classes = classesRes.ok ? classesRes.data : [];
  if (!classes.length) {
    renderPrereq(root, 'No classes found', 'Please create a class before bulk-uploading students.', 'classes', 'Go to Classes');
    return;
  }
  render(root, classes);
}

function stripCsvHeader(lines) {
  if (!lines.length) return lines;
  const first = lines[0].toLowerCase();
  if (first.indexOf('admission') !== -1 && first.indexOf('name') !== -1) return lines.slice(1);
  return lines;
}

function parseRows(text) {
  const lines = String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const rows = stripCsvHeader(lines);
  return rows.map((line) => {
    const parts = line.split(',').map((p) => p.trim());
    return {
      admission_no: parts[0] || '', full_name: parts[1] || '', gender: parts[2] || '',
      guardian_name: parts[3] || '', guardian_contact: parts[4] || ''
    };
  });
}

function validateRow(row) {
  if (!row.admission_no || !row.full_name) return 'Missing admission number or name.';
  if (VALID_GENDERS.indexOf(row.gender) === -1) return 'Gender must be exactly "Male" or "Female".';
  return null;
}

function downloadTemplate() {
  const blob = new Blob([TEMPLATE_HEADER + '\n' + TEMPLATE_SAMPLE + '\n'], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'shule-student-upload-template.csv'; a.click();
  URL.revokeObjectURL(url);
}

function render(root, classes, state) {
  state = state || { class_id: '', stream_id: '', rows: null, streams: [] };

  root.innerHTML = `
    <div class="page-head"><div><h2>Bulk Upload</h2><p>Import many students at once from a spreadsheet/CSV.</p></div></div>
    <div class="card" style="margin-bottom:16px">
      <div class="card-h"><h3>1. Choose class &amp; stream</h3></div>
      <div class="card-b grid2">
        <div class="field"><label>Class</label><select id="bu-class">${options(classes, 'id', 'name', state.class_id, 'Choose a class')}</select></div>
        <div class="field"><label>Stream (optional)</label><select id="bu-stream" ${state.class_id ? '' : 'disabled'}><option value="">No stream</option>${options(state.streams, 'id', 'name', state.stream_id)}</select></div>
      </div>
      <div class="card-b" style="padding-top:0"><p class="hint">Every row you import will be enrolled into this class/stream — the file itself never sets the class.</p></div>
    </div>

    <div class="card" style="margin-bottom:16px">
      <div class="card-h"><h3>2. Paste or load rows</h3><div class="spacer"></div><button class="btn secondary sm" id="bu-template">⬇ Download template</button></div>
      <div class="card-b">
        <p class="hint" style="margin-top:0">Columns: ${esc(TEMPLATE_HEADER)}. Gender must be exactly "Male" or "Female".</p>
        <textarea id="bu-text" rows="8" placeholder="${esc(TEMPLATE_SAMPLE)}"></textarea>
        <div class="field" style="margin-top:10px"><label>...or load a .csv file</label><input id="bu-file" type="file" accept=".csv,text/csv"></div>
        <button class="btn" id="bu-preview" style="margin-top:10px">Preview</button>
      </div>
    </div>

    <div id="bu-preview-area"></div>
  `;

  root.querySelector('#bu-class').onchange = async (e) => {
    const cid = e.target.value;
    const sres = cid ? await Db.streams.list(cid) : { ok: true, data: [] };
    render(root, classes, { ...state, class_id: cid, stream_id: '', streams: sres.ok ? sres.data : [] });
  };
  root.querySelector('#bu-stream').onchange = (e) => { state.stream_id = e.target.value; };
  root.querySelector('#bu-template').onclick = downloadTemplate;
  root.querySelector('#bu-file').onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const text = await file.text();
    root.querySelector('#bu-text').value = text;
  };
  root.querySelector('#bu-preview').onclick = () => {
    if (!root.querySelector('#bu-class').value) { toast('Please choose a class first.', 'err'); return; }
    const rows = parseRows(root.querySelector('#bu-text').value);
    if (!rows.length) { toast('No rows found — paste some data or load a file first.', 'err'); return; }
    renderPreview(root, classes, {
      class_id: root.querySelector('#bu-class').value,
      stream_id: root.querySelector('#bu-stream').value,
      streams: state.streams,
      rows
    });
  };
}

function renderPreview(root, classes, state) {
  const withStatus = state.rows.map((r) => ({ ...r, error: validateRow(r) }));
  const validCount = withStatus.filter((r) => !r.error).length;
  const invalidCount = withStatus.length - validCount;

  const area = root.querySelector('#bu-preview-area');
  area.innerHTML = `
    <div class="card">
      <div class="card-h"><h3>3. Preview (${validCount} ready, ${invalidCount} flagged)</h3>
        <div class="spacer"></div>
        <button class="btn" id="bu-import" ${validCount ? '' : 'disabled'}>Import ${validCount} student(s)</button>
      </div>
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

  area.querySelector('#bu-import').onclick = async () => {
    const btn = area.querySelector('#bu-import');
    btn.disabled = true; btn.textContent = 'Importing…';
    const validRows = withStatus.filter((r) => !r.error).map(({ error, ...r }) => r);
    const res = await Db.students.bulkCreate({ class_id: state.class_id, stream_id: state.stream_id || null, rows: validRows });
    if (!res.ok) { toast(res.message, 'err'); btn.disabled = false; btn.textContent = `Import ${validCount} student(s)`; return; }

    let provisioned = 0;
    for (const row of res.createdRows || []) {
      const prov = await Db.users.provisionStudentLogin({ student_id: row.id, admission_no: row.admission_no, full_name: row.full_name });
      if (prov && prov.ok) provisioned++;
    }

    area.innerHTML = `<div class="card"><div class="card-b">
      <div class="empty">
        <div class="e-ico">✅</div><h3>Import complete</h3>
        <p>${res.created} student(s) created${res.createdRows && res.createdRows.length ? ` and ${provisioned} login(s) provisioned (default password: <b>student-&lt;admission number&gt;</b>)` : ''}.
        ${res.skipped.length ? `${res.skipped.length} row(s) were skipped.` : ''}</p>
      </div>
      ${res.skipped.length ? `<div class="table-wrap"><table class="data">
        <thead><tr><th class="num">Row</th><th>Admission No.</th><th>Name</th><th>Reason</th></tr></thead>
        <tbody>${res.skipped.map((s) => `<tr><td class="num">${s.line}</td><td>${esc(s.admission_no)}</td><td>${esc(s.full_name)}</td><td>${esc(s.reason)}</td></tr>`).join('')}</tbody>
      </table></div>` : ''}
    </div></div>`;
    toast(`Imported ${res.created} student(s).`, 'ok');
  };
}
