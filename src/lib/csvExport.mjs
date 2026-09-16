/**
 * csvExport.mjs — tiny, dependency-free "download as Excel" helper (brief
 * §5/§8: "Download to Excel" everywhere it's mentioned). Produces a real
 * .csv file (opens directly in Excel/Sheets/Numbers) rather than a true
 * .xlsx — same convention already used by the student/marks bulk-upload
 * templates (see marksCsv.mjs) — so there's no new binary-format dependency
 * to add just for an export button.
 */

function csvCell(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

/** columns: [{ key, label }]; rows: array of plain objects. */
export function toCsv(rows, columns) {
  const header = columns.map((c) => csvCell(c.label)).join(',');
  const body = (rows || []).map((r) => columns.map((c) => csvCell(r[c.key])).join(',')).join('\n');
  return header + '\n' + body;
}
