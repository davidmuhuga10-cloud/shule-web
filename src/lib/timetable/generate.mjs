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
 *     - Round 2 §7: the school's own configured Constraints (see below) —
 *       relaxed together, as one group, before the pre-existing same-day
 *       rule above is (see the 3-pass loop in generateTimetable) — a school
 *       that hasn't configured any custom constraints sees byte-for-byte
 *       the same placement behaviour as before this round.
 *
 * A requirement that STILL can't be placed after relaxing every soft
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
 *
 * ----------------------------------------------------------------------
 * Round 2 §7 — Constraints module research (brief: "Research real
 * scheduling practices used by schools before finalizing the constraint
 * set"). Sources consulted: the FET timetabling software manual (time
 * constraints: max/min hours daily, max gaps per day/week, MAX HOURS
 * CONTINUOUSLY [taught without a break], min gaps between activities,
 * preferred times, consecutive/grouped/ordered activities) and a published
 * school-timetabling consultancy's hard/soft constraint breakdown (soft:
 * lunch hour, max ~6hr student day, MAX ~4HR CONSECUTIVE STUDENT TEACHING,
 * MAX ~3HR CONSECUTIVE STAFF TEACHING, 4-day staff week cap, room-size
 * matching, max gaps). This grounds the 6 supported constraint types below
 * — the brief's own 4 literal examples, plus 2 more identified directly
 * from that research (max consecutive periods for a class, and for a
 * teacher — both explicitly named as standard soft constraints in both
 * sources, just expressed in hours there rather than periods):
 *
 *   1. subject_pair_not_consecutive    — "prevent certain subject pairs
 *      from following each other" (brief's own example).
 *   2. avoid_consecutive_intensive     — "avoid back-to-back
 *      mentally-intensive subjects" (brief's own example) — config lists
 *      which subjects count as "intensive"; any two of them landing
 *      adjacent for the same stream is avoided where possible.
 *   3. teacher_no_immediate_after_out  — "don't assign a teacher to a
 *      class immediately after they were 'out' of a different one unless
 *      it's a double lesson" (brief's own example) — "out" reuses the
 *      already-existing teacher_unavailability data (Setup → Teacher
 *      Availability); a SINGLE lesson landing right after one of a
 *      teacher's blocked periods is avoided where possible (a double
 *      lesson is exempt, exactly as the brief specifies, since its first
 *      period is the one actually adjacent to the blocked slot and doubles
 *      are themselves a deliberate, planned block of time).
 *   4. pe_before_break                 — "PE preferably before break"
 *      (brief's own example) — config lists which subjects count as
 *      "PE-like"; placing one anywhere OTHER than the period immediately
 *      before a break is avoided where possible.
 *   5. max_consecutive_periods_class   — research-grounded addition: a
 *      class/stream shouldn't sit more than N periods in a row without a
 *      break (FET's "max hours continuously" / the consultancy's "~4hr
 *      max consecutive student teaching").
 *   6. max_consecutive_periods_teacher — research-grounded addition: same
 *      idea for a teacher's own back-to-back load (the consultancy's
 *      "~3hr max consecutive staff teaching").
 *
 * All 6 are SOFT — a school's preference, never allowed to leave a
 * genuinely placeable lesson unresolved just because honoring every
 * preference at once wasn't possible.
 * ----------------------------------------------------------------------
 */

export const DAY_LABELS = { 1: 'Mon', 2: 'Tue', 3: 'Wed', 4: 'Thu', 5: 'Fri', 6: 'Sat', 7: 'Sun' };
export const DAY_NAMES = { 1: 'Monday', 2: 'Tuesday', 3: 'Wednesday', 4: 'Thursday', 5: 'Friday', 6: 'Saturday', 7: 'Sunday' };

// Used when a subject's periods_per_week hasn't been configured yet (see
// 0018_timetable.sql's comment on subject_class_assignments.periods_per_week)
// — lets a school generate a usable first timetable before every single
// subject has been individually configured, rather than blocking on setup.
export const DEFAULT_PERIODS_PER_WEEK = 5;

// Round 2 §7: the 6 constraint types the Constraints module supports —
// exported so the API layer (timetable.mjs) and UI (timetableSetup.mjs)
// share one canonical list instead of duplicating the type names.
export const CONSTRAINT_TYPES = [
  'subject_pair_not_consecutive', 'avoid_consecutive_intensive', 'teacher_no_immediate_after_out',
  'pe_before_break', 'max_consecutive_periods_class', 'max_consecutive_periods_teacher'
];

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
      // How many of this subject's periods should be paired into double
      // lessons — an explicit count (e.g. "Math gets 3 doubles a week"),
      // not just yes/no, so a school can mix doubles and singles for the
      // same subject exactly as they actually timetable it. Clamped to
      // what perWeek can actually hold so a misconfigured value (more
      // doubles requested than there are period-pairs available) never
      // produces more periods than the subject is supposed to have.
      const requestedDoubles = Number.isFinite(sub.double_periods_per_week) && sub.double_periods_per_week > 0 ? Math.floor(sub.double_periods_per_week) : 0;
      const numDoubles = Math.min(requestedDoubles, Math.floor(perWeek / 2));
      const numSingles = perWeek - numDoubles * 2;
      for (let i = 0; i < numDoubles; i++) doubles.push({ ...base, type: 'double' });
      for (let i = 0; i < numSingles; i++) singles.push({ ...base, type: 'single' });
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

/** How many consecutive teachable periods are already busy immediately
 *  BEFORE `period` (exclusive), walking backward until a free/non-teachable
 *  period breaks the run. Used by the two max-consecutive-periods
 *  constraints. */
function runBackward(busySet, key, day, period, teachableIndexSet) {
  let count = 0, idx = period - 1;
  while (teachableIndexSet.has(idx) && busySet.has(slotKey(key, day, idx))) { count++; idx--; }
  return count;
}
/** Same as runBackward, but walking forward (AFTER `period`, exclusive). */
function runForward(busySet, key, day, period, teachableIndexSet) {
  let count = 0, idx = period + 1;
  while (teachableIndexSet.has(idx) && busySet.has(slotKey(key, day, idx))) { count++; idx++; }
  return count;
}

/** Builds one "would this violate a school-configured soft constraint?"
 *  checker function per enabled constraint row, closed over the shared
 *  placement-in-progress state (`ctx`) so each checker can be called
 *  cheaply for every candidate slot. Returns an array of checker functions,
 *  each `(unit, day, period, secondPeriod) -> boolean` (true = violates).
 *  Malformed/incomplete config on a row (e.g. a pair constraint missing one
 *  of its two subjects) is simply skipped rather than thrown on — the same
 *  "never let a school's odd data crash generation" posture the rest of
 *  this engine already has (see e.g. buildUnits' fallback to
 *  DEFAULT_PERIODS_PER_WEEK). */
function buildConstraintCheckers(constraints, ctx) {
  const checkers = [];
  (constraints || []).forEach((c) => {
    if (!c || c.enabled === false) return;
    const config = c.config || {};
    if (c.type === 'subject_pair_not_consecutive') {
      const a = config.subject_a, b = config.subject_b;
      if (!a || !b || a === b) return;
      checkers.push((unit, day, period, secondPeriod) => {
        if (unit.subject_id !== a && unit.subject_id !== b) return false;
        const other = unit.subject_id === a ? b : a;
        const before = ctx.streamSlotSubject.get(slotKey(unit.stream_id, day, period - 1));
        const after = ctx.streamSlotSubject.get(slotKey(unit.stream_id, day, (secondPeriod || period) + 1));
        return before === other || after === other;
      });
    } else if (c.type === 'avoid_consecutive_intensive') {
      const ids = new Set(config.subject_ids || []);
      if (!ids.size) return;
      checkers.push((unit, day, period, secondPeriod) => {
        if (!ids.has(unit.subject_id)) return false;
        const before = ctx.streamSlotSubject.get(slotKey(unit.stream_id, day, period - 1));
        const after = ctx.streamSlotSubject.get(slotKey(unit.stream_id, day, (secondPeriod || period) + 1));
        return (before && ids.has(before)) || (after && ids.has(after));
      });
    } else if (c.type === 'teacher_no_immediate_after_out') {
      checkers.push((unit, day, period) => {
        // Doubles are explicitly exempt per the brief — a double lesson is
        // itself a deliberate block of time, not a lesson dropped
        // immediately after an "out" slot the way a single would be.
        if (!unit.staff_id || unit.type !== 'single') return false;
        return ctx.unavailable.has(slotKey(unit.staff_id, day, period - 1));
      });
    } else if (c.type === 'pe_before_break') {
      const ids = new Set(config.subject_ids || []);
      if (!ids.size || !ctx.beforeBreakIndexes.size) return;
      checkers.push((unit, day, period) => {
        if (!ids.has(unit.subject_id)) return false;
        return !ctx.beforeBreakIndexes.has(period);
      });
    } else if (c.type === 'max_consecutive_periods_class') {
      const max = Math.floor(Number(config.max));
      if (!Number.isFinite(max) || max < 1) return;
      checkers.push((unit, day, period, secondPeriod) => {
        const span = secondPeriod ? 2 : 1;
        const before = runBackward(ctx.streamBusy, unit.stream_id, day, period, ctx.teachableIndexSet);
        const after = runForward(ctx.streamBusy, unit.stream_id, day, secondPeriod || period, ctx.teachableIndexSet);
        return before + span + after > max;
      });
    } else if (c.type === 'max_consecutive_periods_teacher') {
      const max = Math.floor(Number(config.max));
      if (!Number.isFinite(max) || max < 1) return;
      checkers.push((unit, day, period, secondPeriod) => {
        if (!unit.staff_id) return false;
        const span = secondPeriod ? 2 : 1;
        const before = runBackward(ctx.staffBusy, unit.staff_id, day, period, ctx.teachableIndexSet);
        const after = runForward(ctx.staffBusy, unit.staff_id, day, secondPeriod || period, ctx.teachableIndexSet);
        return before + span + after > max;
      });
    }
  });
  return checkers;
}

/** input = {
 *   days: [1..6],                                            active weekdays
 *   periods: [{period_index, is_break}],                     full daily template, in any order
 *   streams: [{ stream_id, class_id, subjects: [{ subject_id, subject_name, periods_per_week, double_periods_per_week, staff_id }] }],
 *   unavailable: Set<"staffId|day|period">                   from teacher_unavailability
 *   constraints: [{ type, enabled, config }]                 Round 2 §7 — school-configured Constraints module rows (optional)
 * }
 * returns { entries: [{day_of_week, period_index, subject_id, class_id, stream_id, staff_id}], unresolved: [{...unit, reason}] }
 */
export function generateTimetable(input) {
  input = input || {};
  const days = (input.days || []).slice().sort((a, b) => a - b);
  const periods = (input.periods || []).slice().sort((a, b) => a.period_index - b.period_index);
  const teachable = periods.filter((p) => !p.is_break);
  const teachableIndexSet = new Set(teachable.map((p) => p.period_index));
  const unavailable = input.unavailable || new Set();
  const units = buildUnits(input.streams || []);

  // Round 2 §7: which teachable period_index values sit immediately before
  // a break — used by the pe_before_break constraint.
  const beforeBreakIndexes = new Set();
  periods.forEach((p, i) => {
    if (p.is_break && i > 0) {
      const prev = periods[i - 1];
      if (!prev.is_break) beforeBreakIndexes.add(prev.period_index);
    }
  });

  const streamBusy = new Set();   // `${stream_id}|${day}|${period}`
  const staffBusy = new Set();    // `${staff_id}|${day}|${period}`
  const subjectOnDay = new Set(); // `${stream_id}|${subject_id}|${day}`
  const streamSlotSubject = new Map(); // `${stream_id}|${day}|${period}` -> subject_id, for adjacency checks

  const customCheckers = buildConstraintCheckers(input.constraints, {
    streamSlotSubject, unavailable, beforeBreakIndexes, teachableIndexSet, streamBusy, staffBusy
  });

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

  const violatesCustom = (unit, day, period, secondPeriod) => customCheckers.some((check) => check(unit, day, period, secondPeriod));

  const place = (unit, day, period, secondPeriod) => {
    streamBusy.add(slotKey(unit.stream_id, day, period));
    if (unit.staff_id) staffBusy.add(slotKey(unit.staff_id, day, period));
    subjectOnDay.add(slotKey(unit.stream_id, unit.subject_id, day));
    streamSlotSubject.set(slotKey(unit.stream_id, day, period), unit.subject_id);
    entries.push({ day_of_week: day, period_index: period, subject_id: unit.subject_id, class_id: unit.class_id, stream_id: unit.stream_id, staff_id: unit.staff_id || null });
    if (secondPeriod !== undefined) {
      streamBusy.add(slotKey(unit.stream_id, day, secondPeriod));
      if (unit.staff_id) staffBusy.add(slotKey(unit.staff_id, day, secondPeriod));
      streamSlotSubject.set(slotKey(unit.stream_id, day, secondPeriod), unit.subject_id);
      entries.push({ day_of_week: day, period_index: secondPeriod, subject_id: unit.subject_id, class_id: unit.class_id, stream_id: unit.stream_id, staff_id: unit.staff_id || null });
    }
  };

  units.forEach((unit, idx) => {
    const dayOrder = rotatedDays(days, idx);
    let placed = false;

    // Three passes, strictest first, each relaxing one more group of SOFT
    // preferences if the previous pass couldn't fit this unit anywhere:
    //   pass 0 — same-day-repeat AND every enabled custom Constraint enforced
    //   pass 1 — same-day-repeat still enforced, custom Constraints relaxed
    //   pass 2 — everything soft relaxed (hard constraints only)
    // A school with no custom Constraints configured sees pass 0 and pass 1
    // behave identically (nothing to relax between them), so this is
    // byte-for-byte the same 2-outcome behaviour as before this round.
    for (let pass = 0; pass < 3 && !placed; pass++) {
      const allowSameDayRepeat = pass === 2;
      const allowCustomViolation = pass >= 1;
      for (const day of dayOrder) {
        if (placed) break;
        for (const p of teachable) {
          if (!allowSameDayRepeat && subjectOnDay.has(slotKey(unit.stream_id, unit.subject_id, day))) continue;
          if (unit.type === 'double') {
            const nextIndex = p.period_index + 1;
            const nextTeachable = teachable.find((t) => t.period_index === nextIndex);
            if (!nextTeachable) continue;
            if (!isFree(unit, day, p.period_index) || !isFree(unit, day, nextIndex)) continue;
            if (!allowCustomViolation && violatesCustom(unit, day, p.period_index, nextIndex)) continue;
            place(unit, day, p.period_index, nextIndex);
            placed = true;
            break;
          } else {
            if (!isFree(unit, day, p.period_index)) continue;
            if (!allowCustomViolation && violatesCustom(unit, day, p.period_index)) continue;
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

/** Round 2 §7: upfront capacity validation — "compare total teachable slots
 *  per stream vs. total periods-per-week requested, fail clearly BEFORE
 *  running the placement engine or clearing existing entries, rather than
 *  only reporting per-unit unresolved failures after the fact." Every
 *  subject a stream is asked to teach shares that ONE stream's week (a
 *  stream can only ever have one lesson per slot), so the meaningful check
 *  is per-stream: sum of that stream's subjects' periods_per_week (falling
 *  back to DEFAULT_PERIODS_PER_WEEK exactly like buildUnits does) against
 *  how many teachable slots the week actually has.
 *
 *  Returns { ok, teachableSlotsPerWeek, overloaded: [{stream_id, class_id, required, available}] }
 *  — never throws, and never itself mutates/clears anything; the caller
 *  (Db.timetable.generate) decides what to do with a not-ok result. */
export function checkCapacity(input) {
  input = input || {};
  const days = input.days || [];
  const periods = input.periods || [];
  const teachableSlotsPerWeek = periods.filter((p) => !p.is_break).length * days.length;
  const overloaded = [];
  (input.streams || []).forEach((stream) => {
    const required = (stream.subjects || []).reduce((sum, sub) => {
      const perWeek = Number.isFinite(sub.periods_per_week) && sub.periods_per_week > 0 ? sub.periods_per_week : DEFAULT_PERIODS_PER_WEEK;
      return sum + perWeek;
    }, 0);
    if (required > teachableSlotsPerWeek) {
      overloaded.push({ stream_id: stream.stream_id, class_id: stream.class_id, required, available: teachableSlotsPerWeek });
    }
  });
  return { ok: overloaded.length === 0, teachableSlotsPerWeek, overloaded };
}
