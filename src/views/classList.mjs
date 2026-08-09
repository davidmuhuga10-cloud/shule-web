import { esc, options, renderPrereq, loader, toast, go, printOptionsHtml, wirePrintOptions } from '../app.js';
import { Db } from '../lib/api/index.mjs';
import { downloadXlsx } from '../lib/xlsxUtil.mjs';
import { takeNavIntent } from '../lib/navIntent.mjs';
import { printHeaderHtml, isContactInfoComplete, renderMissingContactInfo } from '../lib/printHeader.mjs';

const CL_COLS = [
  { key: 'admission_no', label: 'Admission No.', on: true },
  { key: 'full_name', label: 'Name', on: true },
  { key: 'gender', label: 'Gender', on: true },
  { key: 'stream_name', label: 'Stream', on: true },
  { key: 'guardian_name', label: 'Guardian', on: false },
  { key: 'guardian_contact', label: 'Guardian Contact', on: false }
];

export async function viewClassList(root) {
  const classesRes = await Db.classes.list();
  const classes = classesRes.ok ? classesRes.data : [];
  if (!classes.length) { renderPrereq(root, 'No classes found', 'Please create a class first.', 'classes', 'Go to Classes'); return; }
  // A "🖨️ Print" click from the Students module hands off the class/stream
  // currently filtered there — see navIntent.mjs.
  const intent = takeNavIntent('class-list') || {};
  render(root, classes, { class_id: intent.class_id || '', stream_id: intent.stream_id || '' });
}

function render(root, classes, sel) {
  root.innerHTML = `
    <div class="page-head no-print"><div><h2>Class List</h2><p>A printable class register.</p></div></div>
    <div class="card no-print" style="margin-bottom:16px">
      <div class="card-b grid2">
        <div class="field"><label>Class</label><select id="cl-class">${options(classes, 'id', 'name', sel.class_id, 'Choose a class')}</select></div>
        <div class="field"><label>Stream (optional)</label><select id="cl-stream" ${sel.class_id ? '' : 'disabled'}><option value="">Whole class</option></select></div>
      </div>
      <div class="card-b" style="padding-top:0">
        <label style="font-weight:600;font-size:12.5px;margin-bottom:6px;display:block">Columns to print</label>
        <div class="chk-row">${CL_COLS.map((c) => `<label class="chk"><input type="checkbox" data-col="${c.key}" ${c.on ? 'checked' : ''}> ${esc(c.label)}</label>`).join('')}</div>
      </div>
    </div>
    <div id="cl-list"></div>
  `;

  const classSel = root.querySelector('#cl-class'), streamSel = root.querySelector('#cl-stream');
  async function refreshStreams(cid, preselect) {
    if (!cid) { streamSel.disabled = true; streamSel.innerHTML = '<option value="">Whole class</option>'; return; }
    const sres = await Db.streams.list(cid);
    streamSel.disabled = false;
    streamSel.innerHTML = '<option value="">Whole class</option>' + options(sres.ok ? sres.data : [], 'id', 'name', preselect || '');
  }
  if (sel.class_id) refreshStreams(sel.class_id, sel.stream_id);

  const reload = () => {
    const next = { class_id: classSel.value, stream_id: streamSel.value };
    if (next.class_id) load(root, classes, next); else root.querySelector('#cl-list').innerHTML = '';
  };
  classSel.onchange = async (e) => { await refreshStreams(e.target.value); reload(); };
  streamSel.onchange = reload;
  // Bug fix (feature brief §2): unticking a column (e.g. Guardian) only took
  // effect visually via this 'change' listener — but load() rebuilds
  // #cl-list's markup from scratch on every class/stream change, which reset
  // every column back to CL_COLS' hardcoded default and silently dropped
  // whatever the checkboxes actually said. applyColVisibility() is now also
  // called right after that rebuild (see load() below), so the print/
  // download output always matches what's currently ticked, not just
  // whatever was ticked on the very first render.
  root.querySelectorAll('[data-col]').forEach((cb) => cb.onchange = () => applyColVisibility(root));

  if (sel.class_id) load(root, classes, sel);
}

function applyColVisibility(root) {
  CL_COLS.forEach((c) => {
    const cb = root.querySelector(`[data-col="${c.key}"]`);
    const on = cb ? cb.checked : true;
    root.querySelectorAll(`.col-${c.key}`).forEach((el) => el.classList.toggle('print-hide', !on));
  });
}

async function load(root, classes, sel) {
  const listEl = root.querySelector('#cl-list');
  listEl.innerHTML = loader();
  const [studentsRes, settingsRes] = await Promise.all([Db.students.list(sel), Db.settings.get()]);
  const students = studentsRes.ok ? studentsRes.data : [];
  const settings = settingsRes.ok ? settingsRes.data : {};
  const cls = classes.find((c) => c.id === sel.class_id);

  // Feature brief §3: block printing/downloading until the school's
  // structured contact/address details are set — the logo stays optional.
  if (!isContactInfoComplete(settings)) { renderMissingContactInfo(listEl, () => go('settings')); return; }

  const streamName = root.querySelector('#cl-stream') && root.querySelector('#cl-stream').selectedIndex > 0
    ? root.querySelector('#cl-stream').options[root.querySelector('#cl-stream').selectedIndex].textContent : '';
  const titleBand = `${esc((cls ? cls.name : '').toUpperCase())}${streamName ? ' - ' + esc(streamName.toUpperCase()) : ''} - CLASS LIST`;

  listEl.innerHTML = `
    <div class="report-toolbar no-print">
      <button class="btn secondary" id="cl-download">⬇️ Download Excel</button>
      ${printOptionsHtml('cl', 'portrait')}
    </div>
    <div class="card">
      <div class="card-b" style="border-bottom:1px solid var(--line);padding-bottom:12px">
        ${printHeaderHtml(settings, `Class List — ${cls ? cls.name : ''}${streamName ? ' (' + streamName + ')' : ''}`)}
      </div>
      <div class="card-b table-wrap">
        ${students.length ? `
        <div class="grid-title-band">${titleBand}</div>
        <table class="print-grid">
          <thead><tr>
            <th class="col-admission_no">Admission No.</th><th class="col-full_name">Name</th>
            <th class="col-gender">Gender</th><th class="col-stream_name">Stream</th>
            <th class="col-guardian_name print-hide">Guardian</th><th class="col-guardian_contact print-hide">Guardian Contact</th>
          </tr></thead>
          <tbody>${students.map((s) => `<tr>
            <td class="col-admission_no">${esc(s.admission_no)}</td><td class="col-full_name">${esc(s.full_name)}</td>
            <td class="col-gender">${esc(s.gender)}</td><td class="col-stream_name">${esc(s.stream_name || '—')}</td>
            <td class="col-guardian_name print-hide">${esc(s.guardian_name || '—')}</td><td class="col-guardian_contact print-hide">${esc(s.guardian_contact || '—')}</td>
          </tr>`).join('')}</tbody>
        </table>` : `<div class="empty"><div class="e-ico">🎒</div><h3>No students found</h3><p>No active students in this class/stream yet.</p></div>`}
      </div>
    </div>
  `;

  // Re-apply whatever the "Columns to print" checkboxes actually say right
  // now, every time this markup is (re)built — see the note on the
  // checkbox wiring in render() above.
  applyColVisibility(root);

  // "Download Excel" respects exactly whichever columns are currently ticked
  // in the "Columns to print" picker above — one field-picker drives both
  // print and export (brief §5: "let the admin choose which fields to
  // include, rather than forcing every field into the export").
  const downloadBtn = root.querySelector('#cl-download');
  const suggestedName = `${cls ? cls.name : 'Class'}${streamName ? ' ' + streamName : ''} Classlist`;
  if (downloadBtn) downloadBtn.onclick = () => {
    if (!students.length) { toast('No students to export.', 'warn'); return; }
    const activeCols = CL_COLS.filter((c) => {
      const cb = root.querySelector(`[data-col="${c.key}"]`);
      return cb ? cb.checked : true;
    });
    downloadXlsx(suggestedName.replace(/[\\/:*?"<>|]+/g, ''), students, activeCols, 'Class List');
  };
  wirePrintOptions(listEl, 'cl', suggestedName.replace(/[\\/:*?"<>|]+/g, ''));
}
