/**
 * staffBulkUpload.mjs — Bulk Upload Teachers & Staff (Round 2 §5: "Add bulk
 * upload for Teachers/Staff, matching the bulk upload capability that
 * already exists for Students"). Mirrors bulkUpload.mjs's exact structure —
 * download template, fill it in, upload the same file back, preview with a
 * Ready/error badge per row, all-or-nothing validation (any bad row blocks
 * the whole import until fixed) — just for the `staff` table instead of
 * `students`, and with no class/stream step (staff aren't enrolled in one).
 */
import { esc, toast, $ } from '../app.js';
import { Db } from '../lib/api/index.mjs';
import { downloadXlsx, readXlsxFile } from '../lib/xlsxUtil.mjs';
import { JOB_TITLES } from './staff.mjs';

const VALID_GENDERS = ['Male', 'Female'];
const VALID_YES_NO = ['Yes', 'No'];

/** Column order is the contract between the template and the parser — kept
 *  simple/positional, same convention as bulkUpload.mjs's TEMPLATE_COLUMNS. */
const TEMPLATE_COLUMNS = [
  { key: 'full_name', label: 'Full Name' },
  { key: 'phone', label: 'Phone (used to sign in, along with a username)' },
  { key: 'email', label: 'Email (optional, contact only)' },
  { key: 'role', label: `Job Title (${JOB_TITLES.join('/')})` },
  { key: 'gender', label: 'Gender (Male/Female)' },
  { key: 'qualifications', label: 'Qualifications' },
  { key: 'is_admin', label: 'Admin Access (Yes/No)' }
];
const SAMPLE_ROW = {
  full_name: 'Mercy Njeri', phone: '0712345678', email: '', role: 'Teacher',
  gender: 'Female', qualifications: '', is_admin: 'No'
};

export async function viewStaffBulkUpload(root) {
  render(root);
}

function downloadTemplate() {
  downloadXlsx('shule-staff-upload-template.xlsx', [SAMPLE_ROW], TEMPLATE_COLUMNS, 'Staff');
}

function looksLikeHeaderRow(row) {
  const first = String(row[0] || '').toLowerCase();
  const second = String(row[1] || '').toLowerCase();
  return first.indexOf('name') !== -1 && second.indexOf('phone') !== -1;
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
  if (!row.full_name) return 'Missing full name.';
  if (row.role && JOB_TITLES.indexOf(row.role) === -1) return `Job Title must be one of: ${JOB_TITLES.join(', ')}.`;
  if (row.gender && VALID_GENDERS.indexOf(row.gender) === -1) return 'Gender must be exactly "Male" or "Female" (or left blank).';
  if (row.is_admin && VALID_YES_NO.indexOf(row.is_admin) === -1) return 'Admin Access must be exactly "Yes" or "No" (or left blank).';
  return null;
}

function render(root) {
  root.innerHTML = `
    <div class="page-head"><div><h2>Bulk Upload — Teachers &amp; Staff</h2><p>Import many teachers or staff members at once from a spreadsheet — download the template, fill it in, then upload the same file back.</p></div></div>

    <div class="card" style="margin-bottom:16px">
      <div class="card-h"><h3>1. Download template, fill it in, upload it back</h3></div>
      <div class="card-b">
        <p class="hint" style="margin-top:0">Only Full Name is required — every other column is optional. Job Title defaults to "Teacher" when left blank; Admin Access defaults to "No".</p>
        <button class="btn secondary" id="su-template">⬇ Download template (.xlsx)</button>
        <div class="field" style="margin-top:14px"><label>Upload the filled-in spreadsheet</label><input id="su-file" type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"></div>
        <button class="btn" id="su-preview" style="margin-top:6px" disabled>Preview</button>
      </div>
    </div>

    <div id="su-preview-area"></div>
  `;

  root.querySelector('#su-template').onclick = downloadTemplate;

  let pendingRows = null;
  const previewBtn = root.querySelector('#su-preview');
  root.querySelector('#su-file').onchange = async (e) => {
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
    if (!pendingRows || !pendingRows.length) { toast('Upload a filled-in template first.', 'err'); return; }
    renderPreview(root, { rows: pendingRows });
  };
}

function renderPreview(root, state) {
  const withStatus = state.rows.map((r) => ({ ...r, error: validateRow(r) }));
  const validCount = withStatus.filter((r) => !r.error).length;
  const invalidCount = withStatus.length - validCount;
  const blocked = invalidCount > 0;

  const area = root.querySelector('#su-preview-area');
  area.innerHTML = `
    <div class="card">
      <div class="card-h"><h3>2. Preview (${state.rows.length} row(s))</h3>
        <div class="spacer"></div>
        <button class="btn" id="su-import" ${blocked ? 'disabled' : ''}>Import ${validCount} staff member(s)</button>
      </div>
      ${blocked ? `<div class="card-b" style="padding-bottom:0"><p class="hint" style="color:var(--danger,#c0392b)">
        ${invalidCount} row(s) have an error — fix them in the spreadsheet and re-upload. Nothing will be imported until every row is valid.</p></div>`
        : `<div class="card-b" style="padding-bottom:0"><p class="hint" style="color:var(--ok,#1a7f4b)">All ${validCount} row(s) look good — ready to import.</p></div>`}
      <div class="card-b table-wrap"><table class="data">
        <thead><tr><th class="num">Row</th><th>Name</th><th>Phone</th><th>Job Title</th><th>Admin?</th><th>Status</th></tr></thead>
        <tbody>${withStatus.map((r, i) => `<tr style="${r.error ? 'background:var(--danger-bg)' : ''}">
          <td class="num">${i + 1}</td><td>${esc(r.full_name)}</td><td>${esc(r.phone || '—')}</td>
          <td>${esc(r.role || 'Teacher')}</td><td>${esc(r.is_admin || 'No')}</td>
          <td>${r.error ? `<span class="badge red">${esc(r.error)}</span>` : '<span class="badge green">Ready</span>'}</td>
        </tr>`).join('')}</tbody>
      </table></div>
    </div>
  `;

  const importBtn = area.querySelector('#su-import');
  if (blocked) return;

  importBtn.onclick = async () => {
    importBtn.disabled = true; importBtn.textContent = 'Importing…';
    area.insertAdjacentHTML('beforeend', `<div class="card-b" id="su-progress"><p class="hint">📥 Creating ${validCount} staff record(s), please wait…</p></div>`);
    const validRows = withStatus.filter((r) => !r.error).map(({ error, ...r }) => ({
      full_name: r.full_name,
      phone: r.phone,
      email: r.email,
      role: r.role || 'Teacher',
      gender: r.gender || null,
      qualifications: r.qualifications,
      is_admin: r.is_admin === 'Yes'
    }));
    const res = await Db.staff.bulkCreate({ rows: validRows });
    if (!res.ok) { toast(res.message, 'err'); importBtn.disabled = false; importBtn.textContent = `Import ${validCount} staff member(s)`; $('#su-progress', area)?.remove(); return; }

    // Provision logins in CHUNKS, same rationale as bulkUpload.mjs's student
    // import — one Netlify function round trip per chunk, not per staff
    // member, with live incremental progress in between.
    const CHUNK = 15;
    const rows = res.createdRows || [];
    let provisioned = 0;
    const progressEl = $('#su-progress', area);
    const setProgress = (done) => {
      if (!progressEl || !rows.length) return;
      const pct = Math.round((done / rows.length) * 100);
      progressEl.innerHTML = `<p class="hint">🔑 Setting up logins: ${done}/${rows.length} (${pct}%), please wait…</p>`;
    };
    setProgress(0);
    for (let i = 0; i < rows.length; i += CHUNK) {
      const chunk = rows.slice(i, i + CHUNK).map((r) => ({
        staff_id: r.id, full_name: r.full_name, role: r.is_admin ? 'admin' : 'teacher', phone: r.phone
      }));
      const prov = await Db.users.provisionStaffLogins(chunk);
      if (prov && prov.ok) provisioned += prov.provisioned || 0;
      setProgress(Math.min(i + CHUNK, rows.length));
    }

    // Round 3 §1 (same fix applied to Staff bulk upload for consistency):
    // only show the green success tick when at least one staff member was
    // genuinely created.
    const succeeded = res.created > 0;
    area.innerHTML = `<div class="card"><div class="card-b">
      <div class="empty">
        <div class="e-ico">${succeeded ? '✅' : '❌'}</div><h3>${succeeded ? 'Import complete' : 'Import failed — nothing was created'}</h3>
        <p>${res.created} staff member(s) created${rows.length ? ` and ${provisioned} login(s) provisioned (default password: <b>teacher123</b>, username is their first name)` : ''}.
        ${res.skipped.length ? `${res.skipped.length} row(s) were skipped.` : ''}</p>
      </div>
      ${res.skipped.length ? `<div class="table-wrap"><table class="data">
        <thead><tr><th class="num">Row</th><th>Name</th><th>Reason</th></tr></thead>
        <tbody>${res.skipped.map((s) => `<tr><td class="num">${s.line}</td><td>${esc(s.full_name)}</td><td>${esc(s.reason)}</td></tr>`).join('')}</tbody>
      </table></div>` : ''}
    </div></div>`;
    if (succeeded) toast(`Imported ${res.created} staff member(s).`, 'ok');
    else toast('Import failed — no staff were created.', 'err');
  };
}
