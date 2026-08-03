/**
 * marksCsv.mjs — pure (no-DOM) helpers for the "Bulk Upload Marks" feature.
 * Same CSV-not-XLSX convention as the existing student bulk upload
 * (src/views/bulkUpload.mjs) — Excel/Sheets both open and save CSV directly,
 * and it avoids pulling in a new spreadsheet-parsing dependency this
 * codebase has never exercised. Kept dependency-free and DOM-free
 * specifically so it's unit-testable like every other api/lib module here.
 */

/** One column per subject (or per subject+paper, for a subject with papers
 *  configured) — `key` must be unique and is what ties an uploaded column
 *  back to the right subject_id/paper_id when saving. */
export function buildMarkColumns(subjects, papersBySubjectId) {
  const columns = [];
  (subjects || []).forEach((sub) => {
    const papers = (papersBySubjectId && papersBySubjectId[sub.id]) || [];
    if (!papers.length) {
      columns.push({ key: `s:${sub.id}`, header: sub.name, subject_id: sub.id, paper_id: null });
    } else {
      papers.forEach((p) => {
        columns.push({ key: `s:${sub.id}:p:${p.id}`, header: `${sub.name} (${p.name})`, subject_id: sub.id, paper_id: p.id });
      });
    }
  });
  return columns;
}

/** existingScores: { [student_id]: { [columnKey]: score } } */
export function buildMarksTemplateCsv(students, columns, existingScores) {
  existingScores = existingScores || {};
  const header = ['Admission No', 'Full Name', ...columns.map((c) => c.header)];
  const lines = [header.join(',')];
  (students || []).forEach((s) => {
    const scores = existingScores[s.student_id] || existingScores[s.id] || {};
    const cells = columns.map((c) => {
      const v = scores[c.key];
      return (v === undefined || v === null || v === '') ? '' : String(v);
    });
    lines.push([csvCell(s.admission_no), csvCell(s.full_name), ...cells].join(','));
  });
  return lines.join('\n') + '\n';
}

function csvCell(v) { return String(v == null ? '' : v).replace(/,/g, ' '); } // same simple convention as bulkUpload.mjs — no quoted-comma support

function looksLikeHeader(line) {
  const l = line.toLowerCase();
  return l.indexOf('admission') !== -1 && l.indexOf('name') !== -1;
}

/** Parses the uploaded file back into one row per student: {admission_no,
 *  full_name, scores: {columnKey: rawString}}. Silently tolerates a
 *  reordered/removed header row (skips ONE leading line if it looks like
 *  the template header) but expects the same column order as the template —
 *  same expectation the student bulk upload already sets. */
export function parseMarksCsv(text, columns) {
  const lines = String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return [];
  const dataLines = looksLikeHeader(lines[0]) ? lines.slice(1) : lines;
  return dataLines.map((line) => {
    const parts = line.split(',').map((p) => p.trim());
    const scores = {};
    columns.forEach((c, i) => { scores[c.key] = parts[2 + i] !== undefined ? parts[2 + i] : ''; });
    return { admission_no: parts[0] || '', full_name: parts[1] || '', scores };
  });
}

/** Matches uploaded rows to the class roster by admission number, and
 *  validates each present score against its column's out_of. Returns
 *  {matched: [{student_id, admission_no, full_name, scores, cellErrors}],
 *   unmatched: [rawRow]} — cellErrors is {columnKey: message} for any score
 *  out of range; matched rows with cellErrors are still returned (so the
 *  preview can flag just the bad cells) but bad cells are excluded when
 *  actually saving. */
export function matchAndValidate(parsedRows, students, columns) {
  const byAdm = {};
  (students || []).forEach((s) => { byAdm[String(s.admission_no).trim().toLowerCase()] = s; });
  const colByKey = {};
  columns.forEach((c) => { colByKey[c.key] = c; });

  const matched = [];
  const unmatched = [];
  parsedRows.forEach((row) => {
    const student = byAdm[String(row.admission_no).trim().toLowerCase()];
    if (!student) { unmatched.push(row); return; }
    const cellErrors = {};
    Object.keys(row.scores).forEach((key) => {
      const raw = String(row.scores[key]).trim();
      if (raw === '') return;
      const n = Number(raw);
      const col = colByKey[key];
      const outOf = col && col.out_of != null ? Number(col.out_of) : 100;
      if (isNaN(n) || n < 0 || n > outOf) cellErrors[key] = `Must be 0–${outOf}`;
    });
    matched.push({
      student_id: student.student_id || student.id, admission_no: row.admission_no, full_name: row.full_name,
      scores: row.scores, cellErrors
    });
  });
  return { matched, unmatched };
}

/** Groups matched rows by column (subject/paper) into the shape
 *  Db.results.saveResultsEntry() already accepts — one call per column,
 *  skipping any cell that failed validation. */
export function scoresByColumn(matched, columns) {
  const byColumn = {};
  columns.forEach((c) => { byColumn[c.key] = []; });
  matched.forEach((row) => {
    columns.forEach((c) => {
      if (row.cellErrors[c.key]) return;
      const raw = row.scores[c.key];
      if (raw === undefined || String(raw).trim() === '') return;
      byColumn[c.key].push({ student_id: row.student_id, score: raw });
    });
  });
  return byColumn;
}
