import { esc, go } from '../app.js';
import { Db } from '../lib/api/index.mjs';

export async function viewDashboard(root) {
  const res = await Db.dashboard.get();
  if (!res.ok) { root.innerHTML = `<div class="card pad">⚠️ ${esc(res.message)}</div>`; return; }
  const { counts, gender, perClass, checklist, setupComplete } = res;

  const tiles = [
    ['🎒', counts.students, 'Students', 't-blue'],
    ['👨‍🏫', counts.staff, 'Staff', 't-green'],
    ['🏫', counts.classes, 'Classes', 't-amber'],
    ['🔀', counts.streams, 'Streams', 't-purple'],
    ['📚', counts.subjects, 'Subjects', 't-teal'],
    ['📝', counts.exams, 'Exams', 't-rose']
  ].map(([ico, val, lab, cls]) => `<div class="stat">
    <div class="s-ico ${cls}">${ico}</div>
    <div><div class="s-val">${val}</div><div class="s-lab">${lab}</div></div>
  </div>`).join('');

  const totalStudents = (gender.M || 0) + (gender.F || 0);
  const genderBlock = totalStudents
    ? `<div class="card-b">
        <div style="display:flex;gap:18px;align-items:center">
          <div><div class="s-val" style="color:#2563eb">${gender.M}</div><div class="s-lab">Male</div></div>
          <div><div class="s-val" style="color:#db2777">${gender.F}</div><div class="s-lab">Female</div></div>
        </div>
      </div>`
    : `<div class="card-b"><p class="muted" style="margin:0">No active students yet.</p></div>`;

  const perClassRows = perClass.length
    ? perClass.map((c) => `<tr><td>${esc(c.name)}</td><td class="num">${c.count}</td></tr>`).join('')
    : `<tr><td colspan="2" class="muted center">No classes yet.</td></tr>`;

  const checklistHtml = checklist.map((c) => `
    <li class="${c.done ? 'done' : ''}" data-route="${c.route.replace('#/', '')}">
      <div class="ck ${c.done ? 'done' : 'todo'}">${c.done ? '✓' : ''}</div>
      <div class="lab">${esc(c.label)}</div>
    </li>`).join('');

  root.innerHTML = `
    <div class="page-head"><div><h2>Dashboard</h2><p>An overview of your school's setup.</p></div></div>
    <div class="stats">${tiles}</div>
    <div class="grid2">
      <div class="card">
        <div class="card-h"><h3>Students by gender</h3></div>
        ${genderBlock}
      </div>
      <div class="card">
        <div class="card-h"><h3>Students per class</h3></div>
        <div class="card-b table-wrap">
          <table class="data"><thead><tr><th>Class</th><th class="num">Students</th></tr></thead>
          <tbody>${perClassRows}</tbody></table>
        </div>
      </div>
    </div>
    ${!setupComplete ? `<div class="card" style="margin-top:20px">
      <div class="card-h"><h3>Getting set up</h3></div>
      <div class="card-b"><ul class="checklist" id="setup-checklist">${checklistHtml}</ul></div>
    </div>` : ''}
  `;

  const list = root.querySelector('#setup-checklist');
  if (list) list.querySelectorAll('li[data-route]').forEach((li) => {
    li.onclick = () => go(li.getAttribute('data-route'));
  });
}
