import { esc } from '../app.js';

/** Renders a Report Form (report card) into `container` from a get_report_card() RPC payload. */
export function renderReportCard(container, data) {
  const s = data.student, exam = data.exam;
  container.innerHTML = `
    <div class="report">
      <div class="r-head">
        <h2>${esc(exam.name)} — Report Form</h2>
        <div class="muted">${esc(data.session_name)} · ${esc(data.term_name)}</div>
      </div>
      <div class="r-meta">
        <div><span>Name</span><b>${esc(s.full_name)}</b></div>
        <div><span>Admission No.</span><b>${esc(s.admission_no)}</b></div>
        <div><span>Class</span><b>${esc(s.class_name)}</b></div>
        <div><span>Stream</span><b>${esc(s.stream_name || '—')}</b></div>
        <div><span>Gender</span><b>${esc(s.gender)}</b></div>
        <div><span>Position</span><b>${data.position ? `${data.position} of ${data.class_size}` : '—'}</b></div>
      </div>
      <div class="table-wrap"><table class="data">
        <thead><tr><th>Subject</th><th class="num">Score</th><th class="num">Grade</th><th>Remark</th></tr></thead>
        <tbody>${(data.subjects || []).map((sub) => `<tr>
          <td>${esc(sub.subject_name)}</td><td class="num">${sub.score}</td>
          <td class="num"><span class="badge blue">${esc(sub.grade_label || '—')}</span></td><td>${esc(sub.remark || '—')}</td>
        </tr>`).join('') || '<tr><td colspan="4" class="muted center">No marks recorded for this exam.</td></tr>'}</tbody>
      </table></div>
      <div class="r-summary">
        <div class="box"><div class="v">${data.total}</div><div class="l">Total (out of ${exam.out_of * (data.subjects || []).length})</div></div>
        <div class="box"><div class="v">${data.average}</div><div class="l">Average</div></div>
        <div class="box"><div class="v">${esc(data.overall_grade || '—')}</div><div class="l">Overall grade</div></div>
        <div class="box"><div class="v">${data.position ? `<span class="pos-pill">#${data.position}</span>` : '—'}</div><div class="l">Class position (of ${data.class_size})</div></div>
      </div>
    </div>
  `;
}
