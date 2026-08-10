/**
 * _timetableGrid.mjs — shared, dependency-light partial that renders one
 * printable timetable grid (periods down the side, days across the top),
 * reused by timetable.mjs (admin: by class/arm or by teacher) and
 * myTimetable.mjs (a teacher's own read-only view) — same convention as
 * _reportCard.mjs for Report Forms.
 *
 * Deliberately has no Supabase/app.js import beyond esc()/printHeaderHtml,
 * mirroring _reportCard.mjs — plain, easy to reason about, and reusable
 * from either screen without dragging in unrelated state.
 */
import { esc } from '../app.js';
import { printHeaderHtml } from '../lib/printHeader.mjs';
import { DAY_NAMES } from '../lib/timetable/generate.mjs';

/** entriesBySlot: a Map keyed "day|period" -> entry (already filtered to
 *  whichever single stream or teacher this grid is for by the caller).
 *  mode: 'stream' (cell shows Subject + Teacher) or 'teacher' (cell shows
 *  Subject + Class/Arm) — the one piece of context that differs between the
 *  two callers.
 *  editable: if true, every cell gets data-day/data-period attributes so
 *  the caller can wire click-to-edit (admin Timetable screen); the
 *  teacher-facing My Timetable view leaves this off (read-only). */
export function timetableGridBodyHtml(periods, days, entriesBySlot, mode, editable) {
  const dayCols = days.map((d) => `<th>${esc(DAY_NAMES[d] || d)}</th>`).join('');
  const rows = periods.map((p) => {
    const timeLabel = (p.start_time && p.end_time) ? `<span class="tt-time">${esc(p.start_time)}–${esc(p.end_time)}</span>` : '';
    if (p.is_break) {
      return `<tr class="tt-break-row"><td class="tt-period-col">${timeLabel}</td><td colspan="${days.length}">${esc(p.label || 'Break')}</td></tr>`;
    }
    const periodLabel = esc(p.label || `Period ${p.period_index}`);
    const cells = days.map((d) => {
      const entry = entriesBySlot.get(`${d}|${p.period_index}`);
      const attrs = editable ? ` data-day="${d}" data-period="${p.period_index}" data-entry-id="${entry ? entry.id : ''}"` : '';
      const cls = editable ? 'tt-cell tt-editable' : 'tt-cell';
      if (!entry) return `<td class="${cls}"${attrs}></td>`;
      const line1 = esc(entry.subject_name || '');
      const line2 = mode === 'teacher' ? esc(`${entry.class_name || ''}${entry.stream_name ? ' ' + entry.stream_name : ''}`) : esc(entry.teacher_name || '—');
      const room = entry.room_name ? `<span class="tt-room">${esc(entry.room_name)}</span>` : '';
      return `<td class="${cls}"${attrs}><div class="tt-subject">${line1}</div><div class="tt-sub2">${line2}</div>${room}</td>`;
    }).join('');
    return `<tr><td class="tt-period-col"><b>${periodLabel}</b><br>${timeLabel}</td>${cells}</tr>`;
  }).join('');
  return `<table class="tt-grid"><thead><tr><th class="tt-period-col">Period</th>${dayCols}</tr></thead><tbody>${rows}</tbody></table>`;
}

/** Groups a flat entries array into the Map timetableGridBodyHtml wants. */
export function entriesToSlotMap(entries) {
  const map = new Map();
  (entries || []).forEach((e) => map.set(`${e.day_of_week}|${e.period_index}`, e));
  return map;
}

/** Full printable page: school header + the grid — what both callers wrap
 *  in their own .no-print toolbar and pass to wirePrintOptions(). */
export function timetableGridPageHtml(settings, title, periods, days, entries, mode, editable) {
  const map = entriesToSlotMap(entries);
  return `
    <div class="card">
      <div class="card-b" style="border-bottom:1px solid var(--line);padding-bottom:12px">
        ${printHeaderHtml(settings, title)}
      </div>
      <div class="card-b table-wrap">${timetableGridBodyHtml(periods, days, map, mode, editable)}</div>
    </div>
  `;
}
