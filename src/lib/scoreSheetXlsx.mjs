/**
 * scoreSheetXlsx.mjs — pure, testable builder for the new Score Sheet
 * report's "Download Excel" export (feature brief §9.2). A Score Sheet is a
 * blank, printable per-learning-area assessment sheet (matching the
 * reference sample: an "EXAM NAME" line left for the teacher to fill in by
 * hand, then a roster with an empty SCORE column) — it is NOT pulling
 * already-recorded results, so this only ever needs the student roster plus
 * whatever filter values were chosen.
 */
export function buildScoreSheetAoa({ settings, className, streamName, learningArea, strand, subStrand, indicator, students }) {
  settings = settings || {};
  students = students || [];

  const contactBits = [];
  if (settings.po_box) contactBits.push('P.O. Box ' + settings.po_box + (settings.postal_code ? '-' + settings.postal_code : ''));
  if (settings.town) contactBits.push(settings.town);
  if (settings.phone) contactBits.push(settings.phone);
  if (settings.email) contactBits.push(settings.email);

  const aoa = [];
  aoa.push([settings.school_name || 'School']);
  if (contactBits.length) aoa.push([contactBits.join('  |  ')]);
  aoa.push(['Score Sheet']);
  aoa.push([]);

  const titleBits = [className || '', learningArea || ''].filter(Boolean);
  aoa.push([[...titleBits, 'SCORE SHEET'].join(' - ').toUpperCase()]);
  const detailBits = [];
  if (streamName) detailBits.push('Stream: ' + streamName);
  if (strand) detailBits.push('Strand: ' + strand);
  if (subStrand) detailBits.push('Sub Strand: ' + subStrand);
  if (indicator) detailBits.push('Indicator: ' + indicator);
  if (detailBits.length) aoa.push([detailBits.join('   ')]);
  aoa.push(['Exam name: ______________________________']);
  aoa.push([]);

  aoa.push(['Adm No.', 'Name', 'Stream', 'Score']);
  students.forEach((s) => {
    aoa.push([s.admission_no, s.full_name, s.stream_name || '—', '']);
  });

  return aoa;
}
