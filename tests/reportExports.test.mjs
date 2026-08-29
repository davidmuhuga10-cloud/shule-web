import { buildScoreSheetAoa } from '../src/lib/scoreSheetXlsx.mjs';
import { buildExamAnalysisAoa } from '../src/lib/examAnalysisXlsx.mjs';
import { buildExamAnalysis } from '../src/lib/examAnalysis.mjs';
import { buildXlsxBufferAOA, parseXlsxBuffer } from '../src/lib/xlsxUtil.mjs';

let passed = 0, failed = 0;
function check(name, cond) { if (cond) passed++; else { failed++; console.error('FAIL:', name); } }

function run() {
  // ---- buildScoreSheetAoa (feature brief §9.2) ----
  const ssAoa = buildScoreSheetAoa({
    settings: { school_name: 'Tumaini Junior School', po_box: '245', postal_code: '00100', town: 'Nakuru', phone: '0712345678' },
    className: 'Grade 8', streamName: 'East', learningArea: 'Mathematics', strand: 'Numbers', subStrand: 'Fractions', indicator: 'Adds fractions',
    students: [
      { admission_no: '184', full_name: 'Abigail Chebet', stream_name: 'East' },
      { admission_no: '185', full_name: 'Benson Otieno', stream_name: 'East' }
    ]
  });
  check('buildScoreSheetAoa puts the school name on row 1', ssAoa[0][0] === 'Tumaini Junior School');
  check('buildScoreSheetAoa\'s title band includes class and learning area', ssAoa.some((r) => r[0] === 'GRADE 8 - MATHEMATICS - SCORE SHEET'));
  check('buildScoreSheetAoa includes an exam-name fill-in line', ssAoa.some((r) => typeof r[0] === 'string' && r[0].startsWith('Exam name:')));
  const header = ssAoa.find((r) => r[0] === 'Adm No.');
  check('buildScoreSheetAoa\'s table header has admno/name/stream/score columns (no row-number column)', header && header.join(',') === 'Adm No.,Name,Stream,Score');
  const headerIdx = ssAoa.indexOf(header);
  check('buildScoreSheetAoa\'s first data column is the admission number', ssAoa[headerIdx + 1][0] === '184');
  check('buildScoreSheetAoa leaves the Score column BLANK — this is a printable blank sheet, not recorded marks', ssAoa[headerIdx + 1][3] === '');

  const ssBuf = buildXlsxBufferAOA(ssAoa, 'Score Sheet');
  check('buildScoreSheetAoa\'s output is a valid, non-empty xlsx workbook', ssBuf && ssBuf.byteLength > 0);

  // ---- buildExamAnalysisAoa (feature brief §7) ----
  const BANDS = [
    { min_score: 50, max_score: 100, grade_label: 'A', points: 2, remark: 'Pass' },
    { min_score: 0, max_score: 49, grade_label: 'B', points: 1, remark: 'Fail' }
  ];
  const bs = {
    exam: { name: 'End Term 1' },
    subjects: [{ id: 's1', name: 'Mathematics', code: 'MAT' }],
    students: [
      { student_id: '1', admission_no: '184', full_name: 'Abigail Chebet', gender: 'Female', stream_id: 'e', stream_name: 'E',
        scores: { s1: 90 }, grades: { s1: { grade_label: 'A', points: 2 } }, total: 90, counted: 1, average: 90, overall_grade: 'A', total_points: 2, mean_points: 2, stream_position: 1, position: 1 }
    ],
    class_average: 90
  };
  const analysis = buildExamAnalysis(bs, BANDS);
  const eaAoa = buildExamAnalysisAoa({ settings: { school_name: 'Tumaini Junior School' }, exam: bs.exam, cls: { name: 'Grade 8' }, analysis });

  check('buildExamAnalysisAoa puts the school name on row 1', eaAoa[0][0] === 'Tumaini Junior School');
  check('buildExamAnalysisAoa includes the exam/class title', eaAoa.some((r) => r[0] === 'End Term 1 — Exam Analysis — Grade 8'));
  check('buildExamAnalysisAoa reports students-who-sat as a labelled row', eaAoa.some((r) => r[0] === 'Students who sat' && r[1] === 1));
  check('buildExamAnalysisAoa includes a LEARNING AREA STATISTICS section', eaAoa.some((r) => r[0] === 'LEARNING AREA STATISTICS'));
  check('buildExamAnalysisAoa includes a CLASS GRADE SUMMARY section', eaAoa.some((r) => r[0] === 'CLASS GRADE SUMMARY'));
  check('buildExamAnalysisAoa includes a Top Students - Overall section', eaAoa.some((r) => r[0] === 'Top Students - Overall'));
  check('buildExamAnalysisAoa includes a per-subject section for Mathematics', eaAoa.some((r) => r[0] === 'MATHEMATICS'));

  const eaBuf = buildXlsxBufferAOA(eaAoa, 'Exam Analysis');
  check('buildExamAnalysisAoa\'s output is a valid, non-empty xlsx workbook', eaBuf && eaBuf.byteLength > 0);
  const eaParsed = parseXlsxBuffer(eaBuf);
  check('the exported workbook round-trips through the xlsx reader', eaParsed.length > 5);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

run();
