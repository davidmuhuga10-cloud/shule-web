/**
 * scheduleGrid.mjs — Round 5 §7: pure time-math helpers behind the
 * Timetable Setup "Teaching Days & Periods" screen's simplified schedule
 * creation (views/timetableSetup.mjs). Kept dependency-free and pure (no
 * app.js/Supabase import) so it's directly unit-testable, same convention
 * as every other src/lib/*.mjs pure-logic module.
 *
 * Two things the brief asked for:
 *   1. "just enter the number of lessons per day and a lesson duration...
 *      and periods generate automatically" — generatePeriods() below,
 *      replacing the old start-from-a-single-blank-row manual flow. The
 *      result is a normal, fully-editable row array — nothing about it is
 *      locked in once generated.
 *   2. "time changes should cascade automatically... every following
 *      timeslot should shift... adjusting the whole sequence" —
 *      cascadeTimes() below, called after any one row's own start/end is
 *      hand-edited.
 *
 * Zeraki's own schedule-creation screen was explicitly cited as aesthetic
 * inspiration only ("don't overcomplicate: keep our version as flexible as
 * possible while making it easier to configure") — this intentionally
 * doesn't try to replicate their exact UI, just the two underlying
 * conveniences.
 */

export function timeToMinutes(t) {
  if (!t) return null;
  const m = /^(\d{1,2}):(\d{2})/.exec(String(t));
  if (!m) return null;
  const h = Number(m[1]), min = Number(m[2]);
  if (isNaN(h) || isNaN(min)) return null;
  return h * 60 + min;
}

export function minutesToTime(mins) {
  const wrapped = ((Math.round(mins) % 1440) + 1440) % 1440;
  const h = Math.floor(wrapped / 60), m = wrapped % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** Auto-generates a contiguous run of plain (non-break) period rows,
 *  starting at `startTime`, each `lessonDuration` minutes long. Bounds
 *  lessonsPerDay to a sane 1-20 and lessonDuration to a positive number so
 *  a stray blank/garbage input can't generate zero or thousands of rows.
 *  Every row comes back exactly the same shape renderGrid()'s manual rows
 *  already use (start_time/end_time/is_break/label), so it's a drop-in
 *  replacement for the rows array — add a Break/Lunch row afterward, or
 *  edit any time, exactly as before. */
export function generatePeriods({ startTime, lessonsPerDay, lessonDuration }) {
  const n = Math.max(1, Math.min(20, Math.floor(Number(lessonsPerDay)) || 0));
  const dur = Math.max(1, Math.floor(Number(lessonDuration)) || 0);
  const startMin = timeToMinutes(startTime);
  let cursor = startMin === null ? 8 * 60 : startMin;
  const rows = [];
  for (let i = 0; i < n; i++) {
    rows.push({ start_time: minutesToTime(cursor), end_time: minutesToTime(cursor + dur), is_break: false, label: `Period ${i + 1}` });
    cursor += dur;
  }
  return rows;
}

/** After `rows[index]`'s own start/end has already been updated (by the
 *  caller, e.g. from what the person just typed), shifts every row AFTER
 *  it to start exactly where the row before it now ends — each keeping
 *  its OWN original duration (a 40-minute break edited to start later is
 *  still a 40-minute break once it moves; a double lesson stays
 *  double-length) — so the whole rest of the day's sequence re-flows from
 *  one edit instead of needing every later row retyped by hand. Returns a
 *  NEW array; doesn't mutate the one passed in. */
export function cascadeTimes(rows, index) {
  const out = (rows || []).map((r) => ({ ...r }));
  for (let i = index + 1; i < out.length; i++) {
    const prevEnd = timeToMinutes(out[i - 1].end_time);
    if (prevEnd === null) continue;
    const origStart = timeToMinutes(rows[i].start_time);
    const origEnd = timeToMinutes(rows[i].end_time);
    const duration = (origStart !== null && origEnd !== null && origEnd > origStart) ? (origEnd - origStart) : 40;
    out[i].start_time = minutesToTime(prevEnd);
    out[i].end_time = minutesToTime(prevEnd + duration);
  }
  return out;
}
