/**
 * gridLayout.mjs — Round 5 §9 (timetable print aesthetics): the pure
 * grouping/layout logic behind _timetableGrid.mjs's merged-break-column
 * rendering, pulled out into src/lib so it can be unit tested directly
 * (same convention as src/lib/timetable/scheduleGrid.mjs for Item 7 —
 * views stay dependency-light HTML builders, the actual logic they lean
 * on lives here where it doesn't need a DOM/window to import).
 */

/** Groups consecutive is_break periods into single merged column-groups —
 *  a school with e.g. a 2-period lunch block (periods 4 AND 5 both marked
 *  "Break") gets ONE merged column spanning both, instead of two separate
 *  narrow break columns sitting side by side saying the same thing twice.
 *  A normal (non-break) period is always its own group of 1. The period
 *  grid is one shared template repeated across every teaching day (see
 *  0018_timetable.sql), so this grouping is the same for every day's row
 *  — computed once, not per day. */
export function groupPeriods(periods) {
  const groups = [];
  (periods || []).forEach((p) => {
    const last = groups[groups.length - 1];
    const lastPeriod = last && last.periods[last.periods.length - 1];
    if (p.is_break && last && last.isBreak && lastPeriod && Number(lastPeriod.period_index) === Number(p.period_index) - 1) {
      last.periods.push(p);
    } else {
      groups.push({ isBreak: !!p.is_break, periods: [p] });
    }
  });
  return groups;
}

/** Every period in a merged break group is expected to carry the same
 *  label in practice (a school names period 4 AND period 5 of the same
 *  lunch block both "Lunch") — falls back to the first one's label, or a
 *  generic "Break", if they happen to differ. */
export function breakGroupLabel(group) {
  return group.periods[0].label || 'Break';
}

export const DAY_COL_WIDTH = '90px';
export const BREAK_COL_WIDTH = '34px';

/** Builds the <colgroup> markup that makes table-layout:fixed give every
 *  normal period column an equal share of the remaining width, while
 *  break columns get a fixed narrow width. The <col> elements a table's
 *  fixed layout uses must match the table's actual COLUMN count, not its
 *  group count — a merged break group with colspan=2 still occupies 2
 *  real columns in the column model, so it needs 2 narrow <col>s (their
 *  widths sum under the colspan), not 1. */
export function colgroupHtml(groups) {
  const cols = groups.map((g) => g.isBreak
    ? g.periods.map(() => `<col style="width:${BREAK_COL_WIDTH}">`).join('')
    : '<col>'
  ).join('');
  return `<colgroup><col style="width:${DAY_COL_WIDTH}">${cols}</colgroup>`;
}
