import { esc, options, renderPrereq, loader } from '../app.js';
import { Db } from '../lib/api/index.mjs';

const TOP_N_CHOICES = [
  { id: '10', name: 'Top 10' }, { id: '20', name: 'Top 20' }, { id: 'all', name: 'All (ranked students only)' }
];

export async function viewMeritList(root) {
  const [examsRes, classesRes] = await Promise.all([Db.results.listExams(), Db.classes.list()]);
  const exams = examsRes.ok ? examsRes.data : [];
  const classes = classesRes.ok ? classesRes.data : [];
  if (!exams.length) { renderPrereq(root, 'No exams found', 'Please create an exam first.', 'exams', 'Go to Exams'); return; }
  if (!classes.length) { renderPrereq(root, 'No classes found', 'Please create a class first.', 'classes', 'Go to Classes'); return; }
  render(root, exams, classes, { top_n: '10' });
}

function render(root, exams, classes, sel) {
  root.innerHTML = `
    <div class="page-head no-print"><div><h2>Merit List</h2><p>A printable ranked list of top performers for an exam.</p></div></div>
    <div class="card no-print" style="margin-bottom:16px">
      <div class="card-b grid3">
        <div class="field"><label>Exam</label><select id="ml-exam">${options(exams, 'id', 'name', sel.exam_id, 'Choose an exam')}</select></div>
        <div class="field"><label>Class</label><select id="ml-class">${options(classes, 'id', 'name', sel.class_id, 'Choose a class')}</select></div>
        <div class="field"><label>Show</label><select id="ml-topn">${options(TOP_N_CHOICES, 'id', 'name', sel.top_n)}</select></div>
      </div>
    </div>
    <div id="ml-sheet"></div>
  `;

  const reload = () => {
    const next = {
      exam_id: root.querySelector('#ml-exam').value, class_id: root.querySelector('#ml-class').value,
      top_n: root.querySelector('#ml-topn').value
    };
    if (next.exam_id && next.class_id) load(root, classes, next); else root.querySelector('#ml-sheet').innerHTML = '';
  };
  root.querySelector('#ml-exam').onchange = reload;
  root.querySelector('#ml-class').onchange = reload;
  root.querySelector('#ml-topn').onchange = reload;

  if (sel.exam_id && sel.class_id) load(root, classes, sel);
}

async function load(root, classes, sel) {
  const sheetEl = root.querySelector('#ml-sheet');
  sheetEl.innerHTML = loader();
  const [res, settingsRes] = await Promise.all([Db.results.getBroadsheet({ exam_id: sel.exam_id, class_id: sel.class_id }), Db.settings.get()]);
  if (!res.ok) { sheetEl.innerHTML = `<div class="card pad">⚠️ ${esc(res.message)}</div>`; return; }
  const settings = settingsRes.ok ? settingsRes.data : {};
  const cls = classes.find((c) => c.id === sel.class_id);

  const ranked = res.students.filter((s) => s.position !== '').sort((a, b) => a.position - b.position);
  const unranked = res.students.filter((s) => s.position === '');
  const shown = sel.top_n === 'all' ? ranked : ranked.slice(0, Number(sel.top_n) || 10);

  if (!res.students.length) {
    sheetEl.innerHTML = `<div class="card"><div class="card-b"><div class="empty"><div class="e-ico">🎒</div><h3>No students found</h3><p>No active students in this class yet.</p></div></div></div>`;
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
          <div style="font-weight:650;margin-top:4px">Merit List — ${esc(res.exam.name)} — ${esc(cls ? cls.name : '')}</div>
        </div>
        <div class="spacer"></div>
        <button class="btn secondary no-print" onclick="window.print()">🖨️ Print</button>
      </div>
      <div class="card-b table-wrap">
        <table class="data">
          <thead><tr><th class="num">Rank</th><th>Admission No.</th><th>Name</th><th>Stream</th><th class="num">Total</th><th class="num">Average</th></tr></thead>
          <tbody>${shown.map((s) => `<tr>
            <td class="num"><b>${s.position}</b></td><td>${esc(s.admission_no)}</td><td>${esc(s.full_name)}</td>
            <td>${esc(s.stream_name || '—')}</td><td class="num">${s.total}</td><td class="num">${s.average}</td>
          </tr>`).join('')}</tbody>
        </table>
        ${unranked.length ? `<p class="hint" style="margin-top:10px">${unranked.length} student(s) not shown — not enough published subjects to rank yet.</p>` : ''}
      </div>
    </div>
  `;
}
