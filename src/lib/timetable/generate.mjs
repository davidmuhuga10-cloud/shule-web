/**
 * generate.mjs — the Timetable module's constructive placement engine
 * (Round 4 §7, Phase 3 of Timetable_Module_Research_and_Design_Proposal.docx
 * §6). Pure, dependency-free, unit-testable JS — no Supabase, no DOM, same
 * convention as broadsheetSummary.mjs/xlsxUtil.mjs. The caller (timetable.mjs's
 * API layer) is responsible for fetching input data and writing the result.
 *
 * Approach, following the research doc's §2/§4 conclusions: a deterministic
 * constructive pass (not FET's code, not an embedded external solver — see
 * the doc's licensing section for why) with a weighted hard/soft constraint
 * split, styled on how FET's own algorithm works conceptually:
 *
 *   HARD (never violated):
 *     - a stream has at most one lesson per slot
 *     - a teacher has at most one lesson per slot (across every stream)
 *     - a teacher is never placed in a slot marked unavailable
 *     - a double lesson only lands on two genuinely consecutive, non-break
 *       periods on the same day
 *
 *   SOFT (tried first, relaxed only if the hard constraints leave no choice):
 *     - a subject shouldn't repeat on the same day for the same stream
 *
 * A requirement that STILL can't be placed after relaxing the soft
 * constraint is reported by name in `unresolved`, never silently dropped
 * and never double-booked — same "no silent caps" principle the rest of
 * this codebase follows (see e.g. reportForms.mjs's "No exams found" gate).
 *
 * Deliberately out of scope for this v1 (documented, not silently skipped —
 * see the design doc §3.2's last bullet and §6's Phase 3 note): Senior
 * School pathway subjects that need to run in PARALLEL across multiple
 * streams (a student attending their chosen pathway regardless of their
 * home stream). This engine schedules each stream independently; pathway
 * parallel-scheduling needs a student-level elective data model that
 * doesn't exist yet and is called out as a follow-up, not attempted here.
 */

export const DAY_LABELS = { 1: 'Mon', 2: 'Tue', 3: 'Wed', 4: 'Thu', 5: 'Fri', 6: 'Sat' };
export const DAY_NAMES = { 1: 'Monday', 2: 'Tuesday', 3: 'Wednesday', 4: 'Thursday', 5: 'Friday', 6: 'Saturday' };

// Used when a subject's periods_per_week hasn't been configured yet (see
// 0018_timetable.sql's comment on subject_class_assignments.periods_per_week)
// — lets a school generate a usable first timetable before every single
// subject has been individually configured, rather than blocking on setup.
export const DEFAULT_PERIODS_PER_WEEK = 5;

function slotKey(a, b, c) { return `${a}|${b}|${c}`; }

/** Expands each stream's effective subjects into individual "lesson units"
 *  to place — double lessons become their own two-period units, singles
 *  become one-period units. Doubles are ordered first (harder to place, so
 *  they get first pick of good slots — a standard CSP "most constrained
 *  first" heuristic). */
function buildUnits(streams) {
  const doubles = [];
  const singles = [];
  streams.forEach((stream) => {
    (stream.subjects || []).forEach((sub) => {
      const perWeek = Number.isFinite(sub.periods_per_week) && sub.periods_per_week > 0 ? sub.periods_per_week : DEFAULT_PERIODS_PER_WEEK;
      const base = {
        stream_id: stream.stream_id, class_id: stream.class_id, subject_id: sub.subject_id,
        subject_name: sub.subject_name, staff_id: sub.staff_id || null
      };
      if (sub.is_double) {
        const numDoubles = Math.floor(perWeek / 2);
        const numSingles = perWeek % 2;
        for (let i = 0; i < numDoubles; i++) doubles.push({ ...base, type: 'double' });
        for (let i = 0; i < numSingles; i++) singles.push({ ...base, type: 'single' });
      } else {
        for (let i = 0; i < perWeek; i++) singles.push({ ...base, type: 'single' });
      }
    });
  });
  return [...doubles, ...singles];
}

/** Rotates the day order per-unit (start day = unit index mod day count) so
 *  early units don't all pile into Monday-period-1-first, without needing
 *  Math.random() — keeps the whole engine deterministic, which matters both
 *  for testability and so a school can understand why a given lesson landed
 *  where it did (the same reasoning the design doc's §2.2 favors CP-SAT's
 *  systematic search over an opaque metaheuristic for). */
function rotatedDays(days, offset) {
  const n = days.length;
  if (!n) return [];
  const start = offset % n;
  return days.slice(start).concat(days.slice(0, start));
}

/** input = {
 *   days: [1..6],                                            active weekdays
 *   periods: [{period_index, is_break}],                     full daily template, in any order
 *   streams: [{ stream_id, class_id, subjects: [{ subject_id, subject_name, periods_per_week, is_double, staff_id }] }],
 *   unavailable: Set<"staffId|day|period">                   from teacher_unavailability
 * }
 * returns { entries: [{day_of_week, period_index, subject_id, class_id, stream_id, staff_id}], unresolved: [{...unit, reason}] }
 */
export function generateTimetable(input) {
  input = input || {};
  const days = (input.days || []).slice().sort((a, b) => a - b);
  const periods = (input.periods || []).slice().sort((a, b) => a.period_index - b.period_index);
  const teachable = periods.filter((p) => !p.is_break);
  const unavailable = input.unavailable || new Set();
  const units = buildUnits(input.streams || []);

  const streamBusy = new Set();   // `${stream_id}|${day}|${period}`
  const staffBusy = new Set();    // `${staff_id}|${day}|${period}`
  const subjectOnDay = new Set(); // `${stream_id}|${subject_id}|${day}`

  const entries = [];
  const unresolved = [];

  const isFree = (unit, day, period) => {
    if (streamBusy.has(slotKey(unit.stream_id, day, period))) return false;
    if (unit.staff_id) {
      if (staffBusy.has(slotKey(unit.staff_id, day, period))) return false;
      if (unavailable.has(slotKey(unit.staff_id, day, period))) return false;
    }
    return true;
  };

  const place = (unit, day, period, secondPeriod) => {
    streamBusy.add(slotKey(unit.stream_id, day, period));
    if (unit.staff_id) staffBusy.add(slotKey(unit.staff_id, day, period));
    subjectOnDay.add(slotKey(unit.stream_id, unit.subject_id, day));
    entries.push({ day_of_week: day, period_index: period, subject_id: unit.subject_id, class_id: unit.class_id, stream_id: unit.stream_id, staff_id: unit.staff_id || null });
    if (secondPeriod !== undefined) {
      streamBusy.add(slotKey(unit.stream_id, day, secondPeriod));
      if (unit.staff_id) staffBusy.add(slotKey(unit.staff_id, day, secondPeriod));
      entries.push({ day_of_week: day, period_index: secondPeriod, subject_id: unit.subject_id, class_id: unit.class_id, stream_id: unit.stream_id, staff_id: unit.staff_id || null });
    }
  };

  units.forEach((unit, idx) => {
    const dayOrder = rotatedDays(days, idx);
    let placed = false;

    // Two passes: first respecting the soft "no same subject twice a day"
    // constraint, then allowing it if that's the only way to fit everything
    // in — exactly FET's weighted-constraint-relaxation idea (see the
    // design doc §2.1), just with one soft constraint instead of many.
    for (let pass = 0; pass < 2 && !placed; pass++) {
      const allowSameDayRepeat = pass === 1;
      for (const day of dayOrder) {
        if (placed) break;
        for (const p of teachable) {
          if (!allowSameDayRepeat && subjectOnDay.has(slotKey(unit.stream_id, unit.subject_id, day))) continue;
          if (unit.type === 'double') {
            const nextIndex = p.period_index + 1;
            const nextTeachable = teachable.find((t) => t.period_index === nextIndex);
            if (!nextTeachable) continue;
            if (!isFree(unit, day, p.period_index) || !isFree(unit, day, nextIndex)) continue;
            place(unit, day, p.period_index, nextIndex);
            placed = true;
            break;
          } else {
            if (!isFree(unit, day, p.period_index)) continue;
            place(unit, day, p.period_index);
            placed = true;
            break;
          }
        }
      }
    }

    if (!placed) {
      unresolved.push({
        stream_id: unit.stream_id, class_id: unit.class_id, subject_id: unit.subject_id,
        subject_name: unit.subject_name, staff_id: unit.staff_id, type: unit.type,
        reason: unit.type === 'double'
          ? 'No two consecutive free periods left for this stream/teacher.'
          : 'No free period left for this stream/teacher.'
      });
    }
  });

  return { entries, unresolved };
}
