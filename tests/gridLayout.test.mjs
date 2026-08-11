import { groupPeriods, breakGroupLabel, colgroupHtml, DAY_COL_WIDTH, BREAK_COL_WIDTH } from '../src/lib/timetable/gridLayout.mjs';

let passed = 0, failed = 0;
function check(name, cond) { if (cond) passed++; else { failed++; console.error('FAIL:', name); } }

function run() {
  // ---- groupPeriods: Round 5 §9 "merge consecutive break periods" -------------
  const periods = [
    { period_index: 1, label: 'Period 1', is_break: false },
    { period_index: 2, label: 'Period 2', is_break: false },
    { period_index: 3, label: 'Break', is_break: true },
    { period_index: 4, label: 'Break', is_break: true },
    { period_index: 5, label: 'Period 3', is_break: false },
  ];
  const groups = groupPeriods(periods);
  check('groupPeriods produces one group per normal period, one merged group for consecutive breaks', groups.length === 4);
  check('groupPeriods keeps normal periods as their own group of 1', groups[0].periods.length === 1 && !groups[0].isBreak);
  check('groupPeriods merges the two consecutive break periods into one group', groups[2].isBreak === true && groups[2].periods.length === 2);
  check('groupPeriods merged break group holds both original period rows in order', groups[2].periods[0].period_index === 3 && groups[2].periods[1].period_index === 4);
  check('groupPeriods resumes a fresh normal group after the break', groups[3].periods.length === 1 && groups[3].periods[0].period_index === 5);

  check('groupPeriods handles an empty/undefined input', groupPeriods([]).length === 0 && groupPeriods(undefined).length === 0);

  check('groupPeriods does NOT merge two breaks that are not contiguous by period_index', (() => {
    const gapped = [
      { period_index: 1, is_break: true, label: 'Break' },
      { period_index: 2, is_break: false, label: 'Period 1' },
      { period_index: 3, is_break: true, label: 'Break' },
    ];
    const g = groupPeriods(gapped);
    return g.length === 3 && g[0].periods.length === 1 && g[2].periods.length === 1;
  })());

  check('groupPeriods merges three consecutive breaks (e.g. an extended assembly block) into one group', (() => {
    const triple = [
      { period_index: 1, is_break: true, label: 'Assembly' },
      { period_index: 2, is_break: true, label: 'Assembly' },
      { period_index: 3, is_break: true, label: 'Assembly' },
    ];
    const g = groupPeriods(triple);
    return g.length === 1 && g[0].isBreak && g[0].periods.length === 3;
  })());

  // ---- breakGroupLabel ----------------------------------------------------------
  check('breakGroupLabel uses the first period\'s label', breakGroupLabel({ periods: [{ label: 'Lunch' }, { label: 'Lunch' }] }) === 'Lunch');
  check('breakGroupLabel falls back to "Break" when the period has no label', breakGroupLabel({ periods: [{ label: '' }] }) === 'Break');

  // ---- colgroupHtml: Round 5 §9 "equal-width normal columns, narrow breaks" -----
  const cg = colgroupHtml(groups);
  check('colgroupHtml starts with a fixed-width day column', cg.startsWith(`<colgroup><col style="width:${DAY_COL_WIDTH}">`));
  check('colgroupHtml emits one unspecified-width <col> per normal period group (equal auto-share under table-layout:fixed)', (cg.match(/<col>/g) || []).length === 3);
  check('colgroupHtml emits one narrow fixed-width <col> per individual period inside a merged break group (so widths sum correctly under colspan)', (cg.match(new RegExp(`width:${BREAK_COL_WIDTH}`, 'g')) || []).length === 2);
  check('colgroupHtml total <col> count matches the table\'s real column count (day + 3 normal + 2 break-period cols), not the group count', (cg.match(/<col[ >]/g) || []).length === 6);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

run();
