/**
 * xlsxUtil.mjs — real .xlsx spreadsheet read/write helpers, replacing CSV
 * for anything the school downloads/uploads as "Excel." Per the feature
 * brief: "let's not deal with CSV anywhere — it should be purely a
 * spreadsheet, downloaded and uploaded, not CSV." Wraps the vendored
 * SheetJS bundle (see src/vendor/README.md) so callers never touch the
 * underlying library directly — same split as csvExport.mjs: a pure,
 * testable core plus a thin browser-only download wrapper.
 */
import * as XLSX from '../vendor/xlsx.esm.js';

/** Builds an .xlsx workbook (one sheet) from rows + a [{key,label}] column
 *  spec and returns it as a Uint8Array — pure and testable, no DOM/Blob use. */
export function buildXlsxBuffer(rows, columns, sheetName) {
  const header = columns.map((c) => c.label);
  const data = (rows || []).map((r) => columns.map((c) => {
    const v = r[c.key];
    return v === null || v === undefined ? '' : v;
  }));
  const ws = XLSX.utils.aoa_to_sheet([header, ...data]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetName || 'Sheet1');
  return XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
}

/** Parses an .xlsx file's raw bytes (ArrayBuffer/Uint8Array) into a plain
 *  array-of-arrays (first sheet only), every cell coerced to a trimmed
 *  string — pure and testable, matches how the old CSV parser behaved so
 *  downstream validation code doesn't care whether a cell came from a
 *  number, date, or text cell in the spreadsheet. */
export function parseXlsxBuffer(arrayBuffer) {
  const wb = XLSX.read(arrayBuffer, { type: 'array' });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  if (!sheet) return [];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: '' });
  return rows.map((row) => row.map((cell) => String(cell === null || cell === undefined ? '' : cell).trim()));
}

/** Browser-only: triggers a "Download Template" / "Download Excel" save of
 *  rows+columns as a real .xlsx file (Blob + anchor click, same convention
 *  csvExport.mjs used for CSV). */
export function downloadXlsx(filename, rows, columns, sheetName) {
  const buf = buildXlsxBuffer(rows, columns, sheetName);
  const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename.toLowerCase().endsWith('.xlsx') ? filename : filename + '.xlsx';
  a.click();
  URL.revokeObjectURL(url);
}

/** Builds an .xlsx workbook (one sheet) directly from an array-of-arrays —
 *  for exports whose layout isn't a simple one-header-row table, e.g. a
 *  mark list that needs a few school-details rows above the data grid.
 *  Every cell is coerced the same way buildXlsxBuffer does. Pure and
 *  testable, no DOM/Blob use. */
export function buildXlsxBufferAOA(aoa, sheetName) {
  const data = (aoa || []).map((row) => (row || []).map((v) => (v === null || v === undefined ? '' : v)));
  const ws = XLSX.utils.aoa_to_sheet(data);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetName || 'Sheet1');
  return XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
}

/** Browser-only: triggers a save of an array-of-arrays as a real .xlsx file
 *  via buildXlsxBufferAOA — same Blob + anchor click convention as
 *  downloadXlsx above, for layouts with extra header rows. */
export function downloadXlsxAOA(filename, aoa, sheetName) {
  const buf = buildXlsxBufferAOA(aoa, sheetName);
  const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename.toLowerCase().endsWith('.xlsx') ? filename : filename + '.xlsx';
  a.click();
  URL.revokeObjectURL(url);
}

/** Browser-only: reads a user-uploaded .xlsx File into array-of-arrays rows
 *  via parseXlsxBuffer above. */
export async function readXlsxFile(file) {
  const buf = await file.arrayBuffer();
  return parseXlsxBuffer(buf);
}
