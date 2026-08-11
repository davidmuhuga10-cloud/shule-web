/**
 * _timetableGrid.mjs — shared, dependency-light partial that renders one
 * printable timetable grid, reused by timetableView.mjs (admin: by
 * class/arm or by teacher) and myTimetable.mjs (a teacher's own read-only
 * view) — same convention as _reportCard.mjs for Report Forms.
 *
 * Round 2 §7 (Timetable redesign): TRANSPOSED from the original layout —
 * periods now run across the top as COLUMNS and days run down the side as
 * ROWS ("days as rows, periods as columns" per the brief), the opposite of
 * how this grid used to be laid out. A break still occupies its own period
 * slot, but since periods are columns now, a break is a whole COLUMN
 * (every day's cell in that column shows the break label, muted) rather
 * than a whole row spanning every day.
 *
 * Round 5 §9 (print aesthetics): bigger font/cell sizing throughout;
 * subject names wrap onto two lines instead of truncating or growing the
 * column (table-layout:fixed + an explicit colgroup makes every normal
 * period column the same width, no matter what's in it); consecutive
 * break-type periods (Break, Lunch, Assembly, Games...) MERGE into one
 * clean block — with no internal border and the full session name
 * centered — rather than Zeraki's reference of splitting the name
 * letter-by-letter across separate cells (explicitly NOT copied here).
 * Break columns stay deliberately narrow to save space, with the label
 * rotated to read top-to-bottom instead of forcing a wide column. The
 * grouping/layout math itself lives in ../lib/timetable/gridLayout.mjs
 * (a pure module, unit tested directly in tests/gridLayout.test.mjs) —
 * this file only turns that grouping into markup.
 *
 * Deliberately has no Supabase import beyond esc()/printHeaderHtml,
 * mirroring _reportCard.mjs — plain, easy to reason about, and reusable
 * from either screen without dragging in unrelated state.
 */
import { esc } from '../app.js';
import { printHeaderHtml, reportTitleBarHtml } from '../lib/printHeader.mjs';
import { DAY_NAMES } from '../lib/timetable/generate.mjs';
import { groupPeriods, breakGroupLabel, colgroupHtml } from '../lib/timetable/gridLayout.mjs';

export { groupPeriods };

/** entriesBySlot: a Map keyed "day|period" -> entry (already filtered to
 *  whichever single stream or teacher this grid is for by the caller).
 *  mode: 'stream' (cell shows Subject + Teacher) or 'teacher' (cell shows
 *  Subject + Class/Arm) — the one piece of context that differs between the
 *  two callers.
 *  editable: if true, every non-break cell gets data-day/data-period
 *  attributes so the caller can wire click-to-edit (admin Timetable
 *  screen); the teacher-facing My Timetable view leaves this off
 *  (read-only). */
export function timetableGridBodyHtml(periods, days, entriesBySlot, mode, editable) {
  const groups = groupPeriods(periods);

  const periodCols = groups.map((g) => {
    if (g.isBreak) {
      const span = g.periods.length > 1 ? ` colspan="${g.periods.length}"` : '';
      return `<th class="tt-period-col tt-break-col"${span}><span class="tt-break-label-v">${esc(breakGroupLabel(g))}</span></th>`;
    }
    const p = g.periods[0];
    const timeLabel = (p.start_time && p.end_time) ? `<span class="tt-time">${esc(p.start_time)}–${esc(p.end_time)}</span>` : '';
    const label = esc(p.label || `Period ${p.period_index}`);
    return `<th class="tt-period-col"><b>${label}</b><br>${timeLabel}</th>`;
  }).join('');

  const rows = days.map((d) => {
    const cells = groups.map((g) => {
      if (g.isBreak) {
        const span = g.periods.length > 1 ? ` colspan="${g.periods.length}"` : '';
        return `<td class="tt-break-cell tt-break-merged"${span}><span class="tt-break-label-v">${esc(breakGroupLabel(g))}</span></td>`;
      }
      const p = g.periods[0];
      const entry = entriesBySlot.get(`${d}|${p.period_index}`);
      const attrs = editable ? ` data-day="${d}" data-period="${p.period_index}" data-entry-id="${entry ? entry.id : ''}"` : '';
      const cls = editable ? 'tt-cell tt-editable' : 'tt-cell';
      if (!entry) return `<td class="${cls}"${attrs}></td>`;
      const line1 = esc(entry.subject_name || '');
      const line2 = mode === 'teacher' ? esc(`${entry.class_name || ''}${entry.stream_name ? ' ' + entry.stream_name : ''}`) : esc(entry.teacher_name || '—');
      const room = entry.room_name ? `<span class="tt-room">${esc(entry.room_name)}</span>` : '';
      return `<td class="${cls}"${attrs}><div class="tt-subject">${line1}</div><div class="tt-sub2">${line2}</div>${room}</td>`;
    }).join('');
    return `<tr><td class="tt-day-col"><b>${esc(DAY_NAMES[d] || d)}</b></td>${cells}</tr>`;
  }).join('');

  return `<table class="tt-grid">${colgroupHtml(groups)}<thead><tr><th class="tt-day-col">Day</th>${periodCols}</tr></thead><tbody>${rows}</tbody></table>`;
}

/** Groups a flat entries array into the Map timetableGridBodyHtml wants. */
export function entriesToSlotMap(entries) {
  const map = new Map();
  (entries || []).forEach((e) => map.set(`${e.day_of_week}|${e.period_index}`, e));
  return map;
}

/** Full printable page: school header + the grid — what both callers wrap
 *  in their own .no-print toolbar and pass to wirePrintOptions().
 *
 *  Round 2 §7 visual cleanup: dropped the line that used to run under the
 *  printed header (no border-bottom here anymore), given the whole card
 *  now carries its own themed border instead (see .tt-page/.tt-page-head
 *  in main.css — a muted var(--bg) header band and a var(--primary)
 *  border around the printed page, rather than a stray rule under the
 *  header). */
export function timetableGridPageHtml(settings, title, periods, days, entries, mode, editable) {
  const map = entriesToSlotMap(entries);
  return `
    <div class="card tt-page">
      <div class="card-b tt-page-head">
        ${printHeaderHtml(settings)}
        ${reportTitleBarHtml(title)}
      </div>
      <div class="card-b table-wrap">${timetableGridBodyHtml(periods, days, map, mode, editable)}</div>
    </div>
  `;
}
