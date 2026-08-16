/**
 * scoreSheet.mjs — new "Score Sheet" report (feature brief §9.2): a blank,
 * printable per-learning-area assessment sheet — filterable by Grade,
 * Stream, Learning Area (an existing subject), Strand, Sub Strand and
 * Indicator — with Print and Download, using the same header standard as
 * every other report (school name centered, report title below, address
 * block right). Matches the reference sample: an "EXAM NAME" line the
 * teacher fills in by hand, then a roster with a blank SCORE column —
 * there's no existing curriculum data model for strands/sub-strands/
 * indicators, so those are free-text fields here rather than curated
 * dropdowns (avoids inventing and maintaining a whole new data model just
 * for labels that only ever appear on a printed sheet).
 */
import { esc, options, renderPrereq, renderPrereqOrConnectivity, loader, toast, go, printOptionsHtml, wirePrintOptions } from '../app.js';
import { Db } from '../lib/api/index.mjs';
import { downloadXlsxAOA } from '../lib/xlsxUtil.mjs';
import { buildScoreSheetAoa } from '../lib/scoreSheetXlsx.mjs';
import { printHeaderHtml, reportTitleBarHtml, isContactInfoComplete, renderMissingContactInfo } from '../lib/printHeader.mjs';

export async function viewScoreSheet(root) {
  const [classesRes, subjectsRes] = await Promise.all([Db.classes.list(), Db.subjects.list()]);
  // Round 6 §5 (recurring BUG): don't conflate a lost/flaky connection with
  // "genuinely nothing set up yet" — see examAnalysis.mjs for the full story.
  if (!classesRes.ok || !subjectsRes.ok) {
    renderPrereqOrConnectivity(root, { ok: false, onRetry: () => viewScoreSheet(root) });
    return;
  }
  const classes = classesRes.data;
  const subjects = subjectsRes.data;
  if (!classes.length) { renderPrereq(root, 'No classes found', 'Please create a class first.', 'classes', 'Go to Classes'); return; }
  if (!subjects.length) { renderPrereq(root, 'No learning areas found', 'Please add a subject first.', 'classes', 'Go to Classes & Arms'); return; }
  render(root, classes, subjects, {});
}

function render(root, classes, subjects, sel) {
  root.innerHTML = `
    <div class="page-head no-print"><div><h2>Score Sheet</h2><p>A blank, printable scoring sheet for one class and learning area.</p></div></div>
    <div class="card no-print" style="margin-bottom:16px">
      <div class="card-b grid3">
        <div class="field"><label>Grade</label><select id="ss-class">${options(classes, 'id', 'name', sel.class_id, 'Choose a grade')}</select></div>
        <div class="field"><label>Arm (optional)</label><select id="ss-stream" ${sel.class_id ? '' : 'disabled'}><option value="">Select Arm (optional)</option></select></div>
        <div class="field"><label>Learning Area</label><select id="ss-subject">${options(subjects, 'id', 'name', sel.subject_id, 'Choose a learning area')}</select></div>
      </div>
      <div class="card-b grid3" style="padding-top:0">
        <div class="field"><label>Strand</label><input id="ss-strand" placeholder="Optional" value="${esc(sel.strand || '')}"></div>
        <div class="field"><label>Sub Strand</label><input id="ss-substrand" placeholder="Optional" value="${esc(sel.sub_strand || '')}"></div>
        <div class="field"><label>Indicator</label><input id="ss-indicator" placeholder="Optional" value="${esc(sel.indicator || '')}"></div>
      </div>
      <div class="card-b" style="padding-top:0"><button class="btn" id="ss-generate">Get Score Sheet</button></div>
    </div>
    <div id="ss-sheet"></div>
  `;

  const classSel = root.querySelector('#ss-class'), streamSel = root.querySelector('#ss-stream');
  async function refreshStreams(cid, preselect) {
    if (!cid) { streamSel.disabled = true; streamSel.innerHTML = '<option value="">Select Arm (optional)</option>'; return; }
    const sres = await Db.streams.list(cid);
    streamSel.disabled = false;
    streamSel.innerHTML = '<option value="">Select Arm (optional)</option>' + options(sres.ok ? sres.data : [], 'id', 'name', preselect || '');
  }
  if (sel.class_id) refreshStreams(sel.class_id, sel.stream_id);
  classSel.onchange = (e) => refreshStreams(e.target.value);

  root.querySelector('#ss-generate').onclick = () => {
    const next = {
      class_id: root.querySelector('#ss-class').value,
      stream_id: root.querySelector('#ss-stream').value,
      subject_id: root.querySelector('#ss-subject').value,
      strand: root.querySelector('#ss-strand').value.trim(),
      sub_strand: root.querySelector('#ss-substrand').value.trim(),
      indicator: root.querySelector('#ss-indicator').value.trim()
    };
    if (!next.class_id) { toast('Choose a grade.', 'err'); return; }
    if (!next.subject_id) { toast('Choose a learning area.', 'err'); return; }
    load(root, classes, subjects, next);
  };
}

async function load(root, classes, subjects, sel) {
  const sheetEl = root.querySelector('#ss-sheet');
  sheetEl.innerHTML = loader();
  const [studentsRes, settingsRes] = await Promise.all([
    Db.students.list({ class_id: sel.class_id, stream_id: sel.stream_id || undefined, status: 'active' }),
    Db.settings.get()
  ]);
  const students = studentsRes.ok ? studentsRes.data : [];
  const settings = settingsRes.ok ? settingsRes.data : {};
  const cls = classes.find((c) => c.id === sel.class_id);
  const subject = subjects.find((s) => s.id === sel.subject_id);
  const streamSel = root.querySelector('#ss-stream');
  const streamName = streamSel && streamSel.selectedIndex > 0 ? streamSel.options[streamSel.selectedIndex].textContent : '';

  if (!isContactInfoComplete(settings)) { renderMissingContactInfo(sheetEl, () => go('settings')); return; }

  if (!students.length) {
    sheetEl.innerHTML = `<div class="card"><div class="card-b"><div class="empty"><div class="e-ico">🎒</div><h3>No students found</h3><p>No active students match this class/arm yet.</p></div></div></div>`;
    return;
  }

  const titleBand = `${esc((cls ? cls.name : '').toUpperCase())} - ${esc((subject ? subject.name : '').toUpperCase())} - SCORE SHEET`;
  const detailBits = [];
  if (streamName) detailBits.push(`Arm: ${esc(streamName)}`);
  if (sel.strand) detailBits.push(`Strand: ${esc(sel.strand)}`);
  if (sel.sub_strand) detailBits.push(`Sub Strand: ${esc(sel.sub_strand)}`);
  if (sel.indicator) detailBits.push(`Indicator: ${esc(sel.indicator)}`);

  const suggestedName = `${cls ? cls.name : 'Class'} ${subject ? subject.name : ''} Score Sheet`.replace(/[\\/:*?"<>|]+/g, '');

  sheetEl.innerHTML = `
    <div class="report-toolbar no-print">
      <button class="btn secondary" id="ss-download">⬇️ Download</button>
      ${printOptionsHtml('ss', 'portrait')}
    </div>
    <div class="card">
      <!-- Sprint Review bug: dropped the leftover border-bottom — it printed
           as a stray grey line under reportTitleBarHtml's green rectangle
           (see broadsheet.mjs's load() for the full explanation). -->
      <div class="card-b" style="padding-bottom:12px">
        ${printHeaderHtml(settings)}
        ${reportTitleBarHtml('Score Sheet')}
      </div>
      <div class="card-b table-wrap">
        <div class="grid-title-band">${titleBand}</div>
        ${detailBits.length ? `<div style="font-size:12px;color:var(--muted);padding:8px 10px;border:1px solid var(--line);border-top:none">${detailBits.join(' &nbsp;·&nbsp; ')}</div>` : ''}
        <div style="font-size:12.5px;padding:10px 2px 14px">Exam name: <span style="display:inline-block;min-width:320px;border-bottom:1px dotted var(--muted)">&nbsp;</span></div>
        <table class="print-grid">
          <thead><tr><th>Adm No.</th><th>Name</th><th>Arm</th><th class="num" style="width:90px">Score</th></tr></thead>
          <tbody>${students.map((s) => `<tr>
            <td>${esc(s.admission_no)}</td><td>${esc(s.full_name)}</td><td>${esc(s.stream_name || '—')}</td><td class="num">&nbsp;</td>
          </tr>`).join('')}</tbody>
        </table>
      </div>
    </div>
  `;

  wirePrintOptions(sheetEl, 'ss', suggestedName);
  sheetEl.querySelector('#ss-download').onclick = () => {
    const aoa = buildScoreSheetAoa({
      settings, className: cls ? cls.name : '', streamName, learningArea: subject ? subject.name : '',
      strand: sel.strand, subStrand: sel.sub_strand, indicator: sel.indicator, students
    });
    downloadXlsxAOA(suggestedName, aoa, 'Score Sheet');
  };
}
