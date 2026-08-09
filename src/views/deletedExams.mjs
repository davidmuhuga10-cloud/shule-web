/**
 * deletedExams.mjs — System Fixes brief §8: "New: Deleted Exams submodule."
 *
 * A simple list of soft-deleted exams (Db.results.listDeletedExams —
 * exams.deleted_at set), each showing how many days remain before it's
 * permanently purged, with a "Restore" action that puts it straight back
 * into Exam Desk exactly as it was (Db.results.restoreExam). The 30-day
 * cutoff and the actual purge are enforced server-side (results.mjs's
 * purgeExpired, swept lazily on every listDeletedExams call) — this screen
 * only ever shows exams still inside that window.
 */
import { esc, toast, loader, confirmAction, withBusy } from '../app.js';
import { Db } from '../lib/api/index.mjs';

export async function viewDeletedExams(root) {
  await render(root);
}

async function render(root) {
  root.innerHTML = `
    <div class="page-head"><div><h2>Deleted Exams</h2><p>Deleted exams are kept here for 30 days before being permanently removed — restore one to put it back in Exam Desk.</p></div></div>
    <div class="card"><div id="del-exams-list">${loader()}</div></div>
  `;

  const listEl = root.querySelector('#del-exams-list');
  const res = await Db.results.listDeletedExams();
  if (!res.ok) { listEl.innerHTML = `<div class="card-b">⚠️ ${esc(res.message)}</div>`; return; }
  const rows = res.data || [];

  if (!rows.length) {
    listEl.innerHTML = `<div class="card-b"><div class="empty"><div class="e-ico">🗑️</div><h3>No deleted exams</h3><p>Exams you delete from Exam Desk will show up here for 30 days before being permanently removed.</p></div></div>`;
    return;
  }

  listEl.innerHTML = `<div class="table-wrap"><table class="data">
    <thead><tr><th>Exam</th><th>Academic year</th><th>Term</th><th>Deleted</th><th>Days remaining</th><th></th></tr></thead>
    <tbody>${rows.map((r) => `<tr data-row="${r.id}">
      <td>${esc(r.name)}</td>
      <td>${esc(r.academic_year_name || '—')}</td>
      <td>${esc(r.term_name || '—')}</td>
      <td class="muted" style="font-size:12px">${fmtDate(r.deleted_at)}</td>
      <td><span class="badge ${r.days_remaining <= 5 ? 'red' : r.days_remaining <= 14 ? 'amber' : 'grey'}">${r.days_remaining} day${r.days_remaining === 1 ? '' : 's'}</span></td>
      <td class="row-actions"><button class="btn sm secondary" data-restore="${r.id}">↩️ Restore</button></td>
    </tr>`).join('')}</tbody>
  </table></div>`;

  rows.forEach((r) => {
    const btn = listEl.querySelector(`[data-restore="${r.id}"]`);
    if (!btn) return;
    btn.onclick = () => confirmAction(`Restore "${r.name}" back to Exam Desk?`, () => withBusy(btn, async () => {
      const res2 = await Db.results.restoreExam(r.id);
      if (!res2.ok) { toast(res2.message, 'err'); return; }
      toast('Exam restored.', 'ok');
      render(root);
    }, 'Restoring…'));
  });
}

function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}
