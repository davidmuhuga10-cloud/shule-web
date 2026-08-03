/**
 * broadsheet.mjs — "Mark List", redesigned to match the Zeraki-style
 * condensed, gridded class sheet (feature brief "Merit List Design" — what
 * Zeraki's manual calls a Merit List is this exact per-class, per-subject
 * grid, just under a different name; Shule's own separate, thinner "Merit
 * List" module — a bare top-N ranking with no per-subject detail — is gone,
 * folded into this richer view instead of kept as a second, redundant
 * screen). Every cell has a visible border (a real grid, not just
 * bottom-rule table rows), each subject cell shows the score AND its grade
 * together, and the row of summary columns matches Zeraki's: SBJ (subject
 * count), TT MKS/MN MKS (total/mean marks), PL (performance level — the
 * student's overall grade), TT PTS/MN PTS (total/mean points), DEV
 * (deviation from the class average), STR POS and OVR POS (position within
 * the student's own stream vs. within the whole class).
 */
import { esc, options, renderPrereq, loader, printLandscape } from '../app.js';
import { Db } from '../lib/api/index.mjs';

const STATUS_BADGE_CLASS = { draft: 'grey', submitted: 'blue', approved: 'blue', published: 'green' };
const STATUS_SHORT = { draft: 'Draft', submitted: 'Subm.', approved: 'Appr.', published: 'Publ.' };

export async function viewBroadsheet(root) {
  const [examsRes, classesRes] = await Promise.all([Db.results.listExams(), Db.classes.list()]);
  const exams = examsRes.ok ? examsRes.data : [];
  const classes = classesRes.ok ? classesRes.data : [];
  if (!exams.length) { renderPrereq(root, 'No exams found', 'Please create an exam first.', 'exams', 'Go to Exams'); return; }
  if (!classes.length) { renderPrereq(root, 'No classes found', 'Please create a class first.', 'classes', 'Go to Classes'); return; }
  render(root, exams, classes, {});
}

function render(root, exams, classes, sel) {
  root.innerHTML = `
    <div class="page-head no-print"><div><h2>Mark List</h2><p>Students &times; subjects, with grades, points and position — stream and overall.</p></div></div>
    <div class="card no-print" style="margin-bottom:16px">
      <div class="card-b grid3">
        <div class="field"><label>Exam</label><select id="bs-exam">${options(exams, 'id', 'name', sel.exam_id, 'Choose an exam')}</select></div>
        <div class="field"><label>Class</label><select id="bs-class">${options(classes, 'id', 'name', sel.class_id, 'Choose a class')}</select></div>
        <div class="field"><label>Stream (optional)</label><select id="bs-stream" ${sel.class_id ? '' : 'disabled'}><option value="">Whole class</option></select></div>
      </div>
    </div>
    <div id="bs-sheet"></div>
  `;

  const classSel = root.querySelector('#bs-class'), streamSel = root.querySelector('#bs-stream');
  async function refreshStreams(cid) {
    if (!cid) { streamSel.disabled = true; streamSel.innerHTML = '<option value="">Whole class</option>'; return; }
    const sres = await Db.streams.list(cid);
    streamSel.disabled = false;
    streamSel.innerHTML = '<option value="">Whole class</option>' + options(sres.ok ? sres.data : [], 'id', 'name', '');
  }
  if (sel.class_id) refreshStreams(sel.class_id);

  const reload = () => {
    const next = { exam_id: root.querySelector('#bs-exam').value, class_id: root.querySelector('#bs-class').value, stream_id: root.querySelector('#bs-stream').value };
    if (next.exam_id && next.class_id) load(root, classes, next); else root.querySelector('#bs-sheet').innerHTML = '';
  };
  classSel.onchange = async (e) => { await refreshStreams(e.target.value); reload(); };
  streamSel.onchange = reload;
  root.querySelector('#bs-exam').onchange = reload;

  if (sel.exam_id && sel.class_id) load(root, classes, sel);
}

function cell(score, gr) {
  if (score === null || score === undefined) return '<td class="num">—</td>';
  return `<td class="num mark-cell"><b>${score}</b>${gr && gr.grade_label ? ` <span class="mark-grade">${esc(gr.grade_label)}</span>` : ''}</td>`;
}

async function load(root, classes, sel) {
  const sheetEl = root.querySelector('#bs-sheet');
  sheetEl.innerHTML = loader();
  const [res, settingsRes] = await Promise.all([Db.results.getBroadsheet(sel), Db.settings.get()]);
  if (!res.ok) { sheetEl.innerHTML = `<div class="card pad">⚠️ ${esc(res.message)}</div>`; return; }
  const settings = settingsRes.ok ? settingsRes.data : {};
  const cls = classes.find((c) => c.id === sel.class_id);

  if (!res.students.length) {
    sheetEl.innerHTML = `<div class="card"><div class="card-b"><div class="empty"><div class="e-ico">🎒</div><h3>No students found</h3><p>No active students match this class/stream yet.</p></div></div></div>`;
    return;
  }
  if (!res.subjects.length) {
    sheetEl.innerHTML = `<div class="card"><div class="card-b"><div class="empty warn"><div class="e-ico">⚠️</div><h3>No subjects with marks yet</h3><p>Assign subjects to this class, or enter some marks, then come back.</p></div></div></div>`;
    return;
  }

  const logoHtml = settings.logo ? `<img class="logo-thumb" src="${settings.logo}">` : `<div class="logo-placeholder">🏫</div>`;

  sheetEl.innerHTML = `
    <div class="card">
      <div class="card-b" style="display:flex;gap:16px;align-items:center;border-bottom:1px solid var(--line);padding-bottom:16px">
        ${logoHtml}
        <div>
          <h3 style="font-size:18px">${esc(settings.school_name || 'School')}</h3>
          <div class="muted" style="font-size:12.5px">
            ${settings.po_box ? 'P.O. Box ' + esc(settings.po_box) + ' · ' : ''}${settings.phone ? esc(settings.phone) + ' · ' : ''}${esc(settings.email || '')}
          </div>
          <div style="font-weight:650;margin-top:4px">${esc(res.exam.name)} — Mark List — ${esc(cls ? cls.name : '')}</div>
        </div>
        <div class="spacer"></div>
        <button class="btn secondary no-print" id="bs-print">🖨️ Print</button>
      </div>
      <div class="card-b table-wrap"><table class="data mark-list-grid">
        <thead><tr><th>Adm. No.</th><th>Name</th><th>Str</th>
          ${res.subjects.map((s) => `<th class="num">${esc(s.code || s.name)}<br><span class="badge ${STATUS_BADGE_CLASS[s.submission_status] || 'grey'}" style="font-size:9.5px">${esc(STATUS_SHORT[s.submission_status] || s.submission_status)}</span></th>`).join('')}
          <th class="num">SBJ</th><th class="num">TT MKS</th><th class="num">MN MKS</th><th class="num">PL</th>
          <th class="num">TT PTS</th><th class="num">MN PTS</th><th class="num">DEV</th><th class="num">STR POS</th><th class="num">OVR POS</th></tr></thead>
        <tbody>${res.students.map((s) => `<tr>
          <td>${esc(s.admission_no)}</td><td>${esc(s.full_name)}</td><td>${esc(s.stream_name || '—')}</td>
          ${res.subjects.map((sub) => cell(s.scores[sub.id], s.grades[sub.id])).join('')}
          <td class="num">${s.subject_count}</td>
          <td class="num"><b>${s.total}</b></td><td class="num">${s.average}</td>
          <td class="num"><span class="badge blue">${esc(s.overall_grade || '—')}</span></td>
          <td class="num">${s.total_points === null ? '—' : s.total_points}</td><td class="num">${s.mean_points === null ? '—' : s.mean_points}</td>
          <td class="num">${s.deviation > 0 ? '+' : ''}${s.deviation}</td>
          <td class="num">${s.stream_position || '—'}</td><td class="num"><b>${s.position || '—'}</b></td>
        </tr>`).join('')}</tbody>
      </table></div>
      <div class="card-b" style="border-top:1px solid var(--line)">Class average: <b>${res.class_average}</b></div>
    </div>
  `;
  sheetEl.querySelector('#bs-print').onclick = printLandscape;
}
