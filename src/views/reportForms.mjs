import { esc, options, renderPrereq, renderPrereqOrConnectivity, loader, toast, go, printOptionsHtml, wirePrintOptions, withBusy } from '../app.js';
import { Db } from '../lib/api/index.mjs';
import { renderReportCard } from './_reportCard.mjs';
import { takeNavIntent } from '../lib/navIntent.mjs';
import { isContactInfoComplete, renderMissingContactInfo } from '../lib/printHeader.mjs';

const BATCH_VALUE = '__all__';

// Live feedback: "enforce report forms should always be one page no matter
// what — sometimes when printing it's giving 2 pages, fix and enforce
// that." Report Forms already has several height-reducing measures further
// down the render chain (_reportCard.mjs's transposed Grade Descriptors
// table, optional sections that only render when actually configured), but
// none of that is a HARD guarantee — a school with a long custom motto, a
// grading scale with many bands, or (now) the new fee-balance box added on
// top can still tip a report over one page's worth of height. This is the
// backstop: measured against the REAL printable height for whichever
// orientation/paper/margin is about to be used (same approach as app.js's
// autoFitPrintWidth() — column-width fitting for Mark List — mirrored here
// for vertical height instead), every rendered `.report` block that's
// taller than one page gets scaled down just enough to fit, right before
// window.print() actually runs, and restored immediately after. Kept local
// to this file (not folded into the shared autoFitPrintWidth/
// printWithOptions in app.js) since it's the only screen where "the whole
// page must never exceed one sheet" applies — Mark List/Class List/etc want
// the opposite (never lose a column, page count is not the constraint).
const PAPER_DIMENSIONS_MM = { A4: [210, 297], A5: [148, 210], Letter: [215.9, 279.4] };
const PX_PER_MM = 96 / 25.4;
function autoFitReportsToOnePage(container, orientation, paperSize, marginMm) {
  if (!container) return () => {};
  const [shortMm, longMm] = PAPER_DIMENSIONS_MM[paperSize] || PAPER_DIMENSIONS_MM.A4;
  const pageHeightMm = orientation === 'landscape' ? shortMm : longMm;
  const printableHeightPx = (pageHeightMm - 2 * (marginMm || 10)) * PX_PER_MM;
  const cleanups = [];
  container.querySelectorAll('.report').forEach((el) => {
    const naturalHeight = el.scrollHeight;
    const scale = naturalHeight > printableHeightPx ? printableHeightPx / naturalHeight : 1;
    if (scale >= 1) return;
    const wrap = el.parentElement;
    const prevTransform = el.style.transform;
    const prevOrigin = el.style.transformOrigin;
    const prevWrapHeight = wrap ? wrap.style.height : '';
    const prevWrapOverflow = wrap ? wrap.style.overflow : '';
    el.style.transformOrigin = 'top center';
    el.style.transform = `scale(${scale})`;
    // Same reasoning as autoFitPrintWidth(): the transform shrinks the
    // report VISUALLY but its layout box stays full size unless the
    // wrapping element's reserved height is explicitly shrunk to match —
    // otherwise a near-blank trailing page prints below the shrunk content.
    if (wrap) {
      wrap.style.height = (naturalHeight * scale) + 'px';
      wrap.style.overflow = 'hidden';
    }
    cleanups.push(() => {
      el.style.transform = prevTransform;
      el.style.transformOrigin = prevOrigin;
      if (wrap) { wrap.style.height = prevWrapHeight; wrap.style.overflow = prevWrapOverflow; }
    });
  });
  return () => cleanups.forEach((fn) => fn());
}

export async function viewReports(root) {
  // Perf/UX fix: paint the page shell instantly instead of leaving the
  // router's bare spinner up for the full round trip — see examDesk.mjs's
  // viewExamDesk for the fuller explanation of why this matters.
  root.innerHTML = `
    <div class="page-head no-print"><div><h2>Report Forms</h2></div></div>
    <div class="card"><div class="card-b">
      <div class="skeleton" style="width:100%;height:60px;margin-bottom:12px"></div>
      <div class="skeleton" style="width:100%;height:60px"></div>
    </div></div>
  `;
  const [examsRes, classesRes, settingsRes] = await Promise.all([Db.results.listExams(), Db.classes.list(), Db.settings.get()]);
  // Round 6 §5 (recurring BUG, same class as Round 4 §5's Mark List fix,
  // now also applied to examAnalysis.mjs): a lost/flaky connection used to
  // be silently treated as "genuinely no classes exist yet" here too.
  if (!examsRes.ok || !classesRes.ok) {
    renderPrereqOrConnectivity(root, { ok: false, onRetry: () => viewReports(root) });
    return;
  }
  const exams = examsRes.data;
  const classes = classesRes.data;
  if (!exams.length) { renderPrereq(root, 'No exams found', 'Please create an exam first.', 'exams', 'Go to Exams'); return; }
  if (!classes.length) { renderPrereq(root, 'No classes found', 'Please create a class first.', 'classes', 'Go to Classes'); return; }
  // A "Go to Report Forms" click straight after a full publish hands off
  // exactly which exam+class to pre-select — see navIntent.mjs. Defaults to
  // batch-printing the whole class, since that's almost always the point of
  // that handoff.
  const intent = takeNavIntent('report-forms') || {};
  render(root, exams, classes, intent, settingsRes.ok ? settingsRes.data : {});
}

/** Round 3 §4: "Remove 'School Closed On' / 'Next Term Begins On' from
 *  Settings entirely. They belong inside the Report Forms module itself,
 *  inline with report generation." Still the exact same `settings` rows
 *  underneath (school_closed_on/next_term_begins_on — see
 *  _reportCard.mjs's termDatesHtml(), which is unchanged), saved through
 *  the same Db.settings.save() every other settings field uses; the DB's
 *  own admin-only write policy on `settings` (schema.sql) is what actually
 *  restricts who can change these, exactly as it already does for School
 *  Settings — no separate permission check is added here. */
function termDatesCardHtml(settings) {
  return `
    <div class="card no-print" style="margin-bottom:16px">
      <div class="card-b">
        <div class="grid2">
          <div class="field"><label>School closed on</label><input id="rf-closed-on" type="date" value="${esc(String(settings.school_closed_on || '').slice(0, 10))}"></div>
          <div class="field"><label>Next term begins on</label><input id="rf-next-term" type="date" value="${esc(String(settings.next_term_begins_on || '').slice(0, 10))}"></div>
        </div>
      </div>
      <div class="modal-f" style="border-top:1px solid var(--line)"><button class="btn secondary sm" id="rf-dates-save">Save dates</button></div>
    </div>
  `;
}

function render(root, exams, classes, intent, settings) {
  intent = intent || {};
  settings = settings || {};
  // Round 4 §4: "change the flow to ask for Class first, then Exam" — Class
  // now leads (was Exam, Class, Arm, Student); the Exam field starts
  // disabled/empty exactly like Arm and Student already did, and only fills
  // in once a class is chosen (see refreshExams below), scoped to just the
  // exams that class was actually assigned to.
  root.innerHTML = `
    <div class="page-head no-print"><div><h2>Report Forms</h2></div></div>
    <div class="card no-print" style="margin-bottom:16px">
      <div class="card-b grid4">
        <div class="field"><label>Class</label><select id="rf-class">${options(classes, 'id', 'name', intent.class_id || '', 'Choose a class')}</select></div>
        <div class="field"><label>Exam</label><select id="rf-exam" disabled><option value="">Choose a class first</option></select></div>
        <div class="field"><label>Stream (optional)</label><select id="rf-stream" ${intent.class_id ? '' : 'disabled'}><option value="">Whole class</option></select></div>
        <div class="field"><label>Student</label><select id="rf-student" disabled><option value="">Choose a class first</option></select></div>
      </div>
    </div>
    ${termDatesCardHtml(settings)}
    <div id="rf-card"></div>
  `;

  // One-page enforcement (see autoFitReportsToOnePage() above): hooked to
  // window's beforeprint/afterprint rather than threaded through
  // printWithOptions/wirePrintOptions, so it works identically whether
  // Print is triggered from the toolbar button, the browser's own Ctrl+P,
  // or the OS print menu — anything that ends up calling window.print().
  // render() can run more than once per page load (re-navigating back to
  // Report Forms), so any previous pair is removed first rather than
  // stacking duplicate listeners across visits.
  if (root._rfRemovePrintFit) { root._rfRemovePrintFit(); root._rfRemovePrintFit = null; }
  let rfRestoreFit = null;
  const rfBeforePrint = () => {
    const orientEl = root.querySelector('#rf-orient'), sizeEl = root.querySelector('#rf-size');
    const orient = orientEl ? orientEl.value : 'portrait';
    const size = sizeEl ? sizeEl.value : 'A4';
    rfRestoreFit = autoFitReportsToOnePage(root.querySelector('#rf-card'), orient, size, 10);
    // Same safety net as app.js's printWithOptions()'s own @page-override
    // cleanup: 'afterprint' doesn't fire in every browser/print-preview flow
    // (e.g. cancelling before the dialog fully engages), so this scale-down
    // must never be allowed to linger and affect the on-screen view.
    setTimeout(rfAfterPrint, 5000);
  };
  const rfAfterPrint = () => { if (rfRestoreFit) { rfRestoreFit(); rfRestoreFit = null; } };
  window.addEventListener('beforeprint', rfBeforePrint);
  window.addEventListener('afterprint', rfAfterPrint);
  root._rfRemovePrintFit = () => {
    window.removeEventListener('beforeprint', rfBeforePrint);
    window.removeEventListener('afterprint', rfAfterPrint);
  };

  root.querySelector('#rf-dates-save').onclick = (e) => withBusy(e.currentTarget, async () => {
    const payload = {
      school_closed_on: root.querySelector('#rf-closed-on').value,
      next_term_begins_on: root.querySelector('#rf-next-term').value
    };
    const res = await Db.settings.save(payload);
    if (!res.ok) { toast(res.message, 'err'); return; }
    toast('Dates saved.', 'ok');
    // A report already on screen should reflect the new dates immediately
    // — not just the next time one's generated. Round 6 §6 made tryLoad()
    // reuse a cached loadExtra() (which is where `settings` comes from)
    // across student switches within the same exam/class/stream, so that
    // cache has to be explicitly dropped here or this save would appear
    // to do nothing until a different exam/class/stream was picked.
    extraCacheKey = '';
    if (root.querySelector('#rf-student') && root.querySelector('#rf-student').value) tryLoad();
  }, 'Saving…');

  const refreshStreams = async (cid, preselect) => {
    const streamSel = root.querySelector('#rf-stream');
    if (!cid) { streamSel.disabled = true; streamSel.innerHTML = '<option value="">Whole class</option>'; return; }
    const sres = await Db.streams.list(cid);
    streamSel.disabled = false;
    streamSel.innerHTML = '<option value="">Whole class</option>' + options(sres.ok ? sres.data : [], 'id', 'name', preselect || '');
  };

  // Round 4 §4: "change the flow to ask for Class first, then Exam — if the
  // selected class has no exams, show 'no exams found' and disable the
  // print button entirely, nothing should generate." Scoped to
  // exam_classes (Db.results.listExamsForClass) — the same "this class was
  // actually assigned to sit this exam" source of truth getBroadsheet()/
  // listSubmissions() already use — instead of offering every exam in the
  // school regardless of whether this class was ever assigned to it.
  // Returns true when the class has zero exams, so the caller can freeze
  // the rest of the form right away (no card, nothing to print) instead of
  // only discovering this later once Exam+Student are both picked.
  const refreshExams = async (cid, preselect) => {
    const examSel = root.querySelector('#rf-exam');
    const cardEl = root.querySelector('#rf-card');
    if (!cid) {
      examSel.disabled = true;
      examSel.innerHTML = '<option value="">Choose a class first</option>';
      cardEl.innerHTML = '';
      return true;
    }
    const eres = await Db.results.listExamsForClass(cid);
    const classExams = eres.ok ? eres.data : [];
    if (!classExams.length) {
      examSel.disabled = true;
      examSel.innerHTML = '<option value="">No exams found</option>';
      cardEl.innerHTML = `<div class="card"><div class="card-b"><div class="empty warn"><div class="e-ico">⚠️</div><h3>No exams found</h3><p>This class hasn't been assigned to sit any exam yet, so there's nothing to print. Assign an exam to this class under Exams first.</p></div></div></div>`;
      return true;
    }
    examSel.disabled = false;
    examSel.innerHTML = options(classExams, 'id', 'name', preselect || '', 'Choose an exam');
    cardEl.innerHTML = '';
    return false;
  };

  // Round 3 §12: "Add a Stream filter option under Report Forms as well" —
  // same optional narrowing the Mark List/Class List already offer. Only
  // affects the batch "Print all" path (a single named student is already
  // as narrow as it gets); passed straight through to Db.students.list().
  const refreshStudents = async (cid, preselect, streamId) => {
    const studentSel = root.querySelector('#rf-student');
    if (!cid) { studentSel.disabled = true; studentSel.innerHTML = '<option value="">Choose a class first</option>'; return; }
    const sres = await Db.students.list({ class_id: cid, stream_id: streamId || '' });
    const students = sres.ok ? sres.data : [];
    studentSel.disabled = false;
    const choices = students.length
      ? [{ id: BATCH_VALUE, name: '🖨️ Print all students in this class' }, ...students.map((s) => ({ id: s.id, name: `${s.admission_no} — ${s.full_name}` }))]
      : [];
    studentSel.innerHTML = options(choices, 'id', 'name', preselect || '', 'Choose a student');
  };

  // Report-form extras (feature brief "Report Forms and Merit List
  // Design"): school header, per-subject teacher name and class average are
  // all staff-only, cheap lookups — fetched ONCE per class/exam (not per
  // student) and reused across the whole batch. Neither requires a new RPC:
  // teacher names already come back from listSubmissions(), and per-subject
  // class averages are derived client-side from getBroadsheet()'s
  // already-computed per-student per-subject scores.
  // Round 3 §12: getBroadsheet() is the one place that already knows
  // whether this class was ever actually assigned to sit this exam
  // (exam_classes) — loadExtra() was already calling it for the
  // per-subject class averages, so its ok/message is threaded straight
  // through here rather than adding a second lookup just for the check.
  // Round 3 §13: getBroadsheet()'s own `students` rows are already ranked
  // best-to-worst (see results.mjs's rankByTotal()+final sort) — exposed
  // here as `rankedStudents` so the batch "Print all" path can reuse that
  // exact order instead of the admission-number order Db.students.list()
  // returns, rather than re-deriving position from scratch client-side.
  const loadExtra = async (examId, classId, streamId) => {
    const [settingsRes, subsRes, bsRes, bands] = await Promise.all([
      Db.settings.get(), Db.results.listSubmissions(examId, classId), Db.results.getBroadsheet({ exam_id: examId, class_id: classId, stream_id: streamId || '' }), Db.grading.defaultScaleBands()
    ]);
    const teacherBySubject = {};
    (subsRes.ok ? subsRes.data : []).forEach((r) => { if (r.teacher_name) teacherBySubject[r.subject_id] = r.teacher_name; });
    const classAvgBySubject = {};
    if (bsRes.ok) {
      bsRes.subjects.forEach((sub) => {
        const scored = bsRes.students.map((s) => s.scores[sub.id]).filter((v) => v !== null && v !== undefined);
        classAvgBySubject[sub.id] = scored.length ? Math.round((scored.reduce((a, v) => a + v, 0) / scored.length) * 100) / 100 : null;
      });
    }
    return {
      settings: settingsRes.ok ? settingsRes.data : {}, teacherBySubject, classAvgBySubject, bands: bands || [],
      examOk: bsRes.ok, examMessage: bsRes.message, rankedStudents: bsRes.ok ? bsRes.students : []
    };
  };

  // Permissions > Report Forms > "Show fee balance on Report Forms": fetched
  // per-student (a balance isn't something loadExtra()'s once-per-class
  // context can share), only when the toggle is on, and never allowed to
  // block the report itself — a Finance hiccup here shouldn't stop the
  // whole report card from printing, so a failed lookup just omits the box.
  const loadFeeBalance = async (settings, studentId) => {
    if (String(settings.show_fee_balance_on_report) !== 'true') return null;
    const res = await Db.finance.students.reportCardBalance(studentId);
    return res.ok ? res.data : null;
  };

  // Round 6 §6 (performance): loadExtra() does 4 round trips including
  // getBroadsheet() — a whole-class, every-subject query — to build the
  // teacher-names/class-averages/settings/bands context every report card
  // needs. None of that depends on WHICH student is selected, only on
  // (exam, class, stream) — but tryLoad() used to call loadExtra() fresh
  // on every single call, including just picking the next student off the
  // same class+exam one at a time (the normal "check this student, then
  // the next" workflow), re-running that whole-class query for a single
  // student's report every time. Cached here so switching students within
  // the same exam/class/stream reuses the last fetch — the actual
  // per-student generate (Db.results.getReportCard) is still always live.
  let extraCache = null, extraCacheKey = '';
  const tryLoad = async () => {
    const examId = root.querySelector('#rf-exam').value, studentId = root.querySelector('#rf-student').value;
    const classId = root.querySelector('#rf-class').value;
    const streamId = root.querySelector('#rf-stream') ? root.querySelector('#rf-stream').value : '';
    if (!examId || !studentId) return;
    const cardEl = root.querySelector('#rf-card');
    cardEl.innerHTML = loader();
    const cacheKey = `${examId}|${classId}|${streamId}`;
    if (extraCacheKey !== cacheKey) { extraCache = await loadExtra(examId, classId, streamId); extraCacheKey = cacheKey; }
    const extra = extraCache;
    // Round 4 §3: "the rule that blocks printing until a school's
    // header/contact details are set already works correctly elsewhere...
    // but not under Report Forms specifically." Same gate Mark List/Class
    // List/Score Sheet/Exam Analysis already enforce (printHeader.mjs),
    // applied here too — before anything (single student or a whole batch)
    // gets generated.
    if (!isContactInfoComplete(extra.settings)) { renderMissingContactInfo(cardEl, () => go('settings')); return; }
    // Round 3 §12: a class/exam combo that was never actually paired (this
    // class didn't sit this exam) used to fall through into an empty,
    // marks-less report instead of saying so plainly.
    if (!extra.examOk) {
      cardEl.innerHTML = `<div class="card"><div class="card-b"><div class="empty warn"><div class="e-ico">⚠️</div><h3>No exams found</h3><p>${esc(extra.examMessage || 'This class was not selected to sit this exam.')}</p></div></div></div>`;
      return;
    }

    if (studentId === BATCH_VALUE) {
      // Round 3 §13: "output should be ordered from the first-position
      // student to the last" — extra.rankedStudents (from getBroadsheet,
      // already scoped to this stream if one's selected) IS that order;
      // reused directly instead of Db.students.list()'s admission-number
      // ordering.
      const students = extra.rankedStudents;
      if (!students.length) { cardEl.innerHTML = `<div class="card pad">No students found in this class.</div>`; return; }
      cardEl.innerHTML = '';
      // Print bar goes at the TOP, above every report form — not appended
      // after the fact, which is what put it below the content before.
      // Brief §11: same shared portrait/landscape + A4/A5/Letter print
      // controls every other report (Mark List/Class List/Score Sheet) uses,
      // instead of a bare print button with no size/orientation choice.
      const printBar = document.createElement('div');
      printBar.className = 'report-toolbar no-print'; printBar.style.marginBottom = '16px';
      printBar.innerHTML = printOptionsHtml('rf', 'portrait');
      cardEl.appendChild(printBar);
      // Brief §12: this used to be N sequential get_report_card() RPC round
      // trips, one per student, awaited one at a time in a for-loop — for a
      // class of 40+ students that's 40 round trips back to back, the
      // highest-value cause identified for "report forms... take too long to
      // generate." Firing every request at once and awaiting the whole batch
      // turns "N round trips in series" into "1 round trip's worth of wait."
      const showBalance = String(extra.settings.show_fee_balance_on_report) === 'true';
      const [results, balances] = await Promise.all([
        Promise.all(students.map((s) => Db.results.getReportCard(examId, s.student_id))),
        showBalance ? Promise.all(students.map((s) => loadFeeBalance(extra.settings, s.student_id))) : Promise.resolve(students.map(() => null))
      ]);
      let printed = 0;
      students.forEach((s, i) => {
        const res = results[i];
        if (!res.ok) return;
        const page = document.createElement('div');
        page.className = 'batch-page';
        cardEl.appendChild(page);
        renderReportCard(page, res.data, { ...extra, feeBalance: balances[i] });
        printed++;
      });
      if (!printed) { cardEl.innerHTML = `<div class="card pad">⚠️ No accessible report cards for this class/exam yet.</div>`; return; }
      wirePrintOptions(printBar, 'rf', `Report Forms — ${classes.find((c) => c.id === classId) ? classes.find((c) => c.id === classId).name : ''}`);
      return;
    }

    const [res, feeBalance] = await Promise.all([Db.results.getReportCard(examId, studentId), loadFeeBalance(extra.settings, studentId)]);
    if (!res.ok) { cardEl.innerHTML = `<div class="card pad">⚠️ ${esc(res.message)}</div>`; return; }
    cardEl.innerHTML = '';
    // Same top-of-page placement + shared print controls for the
    // single-student case.
    const printBar = document.createElement('div');
    printBar.className = 'report-toolbar no-print'; printBar.style.marginBottom = '16px';
    printBar.innerHTML = printOptionsHtml('rf', 'portrait');
    cardEl.appendChild(printBar);
    const cardBody = document.createElement('div');
    cardEl.appendChild(cardBody);
    renderReportCard(cardBody, res.data, { ...extra, feeBalance });
    wirePrintOptions(printBar, 'rf', `Report Form — ${res.data.student ? res.data.student.full_name : ''}`);
  };

  // Round 6 §6 (performance/perceived-freeze): the class/arm selects used
  // to stay fully interactive (not disabled, no visual change at all)
  // while their onchange handler's fetches were still in flight — clicking
  // around during that window did nothing visible, which read as the
  // screen having frozen rather than as "still loading". Disabling the
  // select that was just changed for the duration of its own refresh gives
  // the same "please wait" feedback every other button in the app now has
  // (see Timetable's Round 6 §8), and incidentally also stops a second
  // change firing a second overlapping refresh mid-flight.
  root.querySelector('#rf-class').onchange = async (e) => {
    const cid = e.target.value;
    e.target.disabled = true;
    try {
      // Round 4 §4: Exam is now scoped to the chosen class — refreshed
      // alongside Arm/Student on every class change, not just once up front.
      // Round 6 §6 (performance): these three don't actually depend on one
      // another (all three only need `cid`) — firing them together turns 2
      // round trips in sequence into 1 round trip's worth of wait, same
      // "why serialize independent fetches" fix Round 3 §12 already applied
      // to the batch report-card generation below.
      const [, noExams] = await Promise.all([refreshStreams(cid), refreshExams(cid), refreshStudents(cid, '', '')]);
      if (noExams) root.querySelector('#rf-student').disabled = true;
      wireStudentSelect();
    } finally {
      e.target.disabled = false;
    }
  };
  root.querySelector('#rf-stream').onchange = async (e) => {
    e.target.disabled = true;
    try {
      await refreshStudents(root.querySelector('#rf-class').value, '', e.target.value);
      wireStudentSelect();
    } finally {
      e.target.disabled = false;
    }
  };
  root.querySelector('#rf-exam').onchange = tryLoad;
  function wireStudentSelect() {
    const s = root.querySelector('#rf-student');
    if (s) s.onchange = tryLoad;
  }
  wireStudentSelect();

  // Prefill straight from a "Go to Report Forms" handoff (see navIntent.mjs
  // at the top of this file) — defaults to batch-printing the whole class,
  // unless a specific student_id was handed off too (e.g. from a student's
  // profile page — brief §5's "view results" action), in which case that
  // one student is preselected instead. Exam is now class-scoped (§4), so
  // it's refreshed here too before the handed-off exam_id is selected.
  if (intent.class_id && intent.exam_id) {
    Promise.all([refreshStreams(intent.class_id, intent.stream_id), refreshExams(intent.class_id, intent.exam_id)]).then(() => {
      refreshStudents(intent.class_id, intent.student_id || BATCH_VALUE, intent.stream_id).then(() => { wireStudentSelect(); tryLoad(); }).catch((e) => console.error('reportForms: refreshStudents failed', e));
    }).catch((e) => console.error('reportForms: prefill from nav intent failed', e));
  }
}
