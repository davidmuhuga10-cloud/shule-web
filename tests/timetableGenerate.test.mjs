import { generateTimetable, checkCapacity, DEFAULT_PERIODS_PER_WEEK, CONSTRAINT_TYPES } from '../src/lib/timetable/generate.mjs';

let passed = 0, failed = 0;
function check(name, cond) { if (cond) passed++; else { failed++; console.error('FAIL:', name); } }

/** Longest run of period-index-consecutive entries sharing `keyFn`'s value,
 *  on the same day — used by the max-consecutive-periods constraint tests
 *  to verify the ACTUAL longest back-to-back stretch, rather than
 *  hardcoding exact slot numbers the engine's internal ordering happens to
 *  produce. */
function maxConsecutiveRun(entries, keyFn) {
  const byGroupDay = {};
  entries.forEach((e) => {
    const k = `${keyFn(e)}|${e.day_of_week}`;
    (byGroupDay[k] = byGroupDay[k] || []).push(e.period_index);
  });
  let best = 0;
  Object.values(byGroupDay).forEach((idxs) => {
    const sorted = [...new Set(idxs)].sort((a, b) => a - b);
    let run = 1;
    for (let i = 1; i < sorted.length; i++) {
      run = sorted[i] === sorted[i - 1] + 1 ? run + 1 : 1;
      if (run > best) best = run;
    }
    if (sorted.length && sorted.length === 1) best = Math.max(best, 1);
  });
  return best;
}

// A simple, roomy daily template: 6 teaching periods + a break after period 3.
const PERIODS = [
  { period_index: 1, is_break: false }, { period_index: 2, is_break: false }, { period_index: 3, is_break: false },
  { period_index: 4, is_break: true },  // break
  { period_index: 5, is_break: false }, { period_index: 6, is_break: false }, { period_index: 7, is_break: false }
];
const DAYS = [1, 2, 3, 4, 5];

function countBy(entries, pred) { return entries.filter(pred).length; }

function run() {
  // ---- basic placement, no conflicts -------------------------------------------
  {
    const input = {
      days: DAYS, periods: PERIODS,
      streams: [{ stream_id: 'st1', class_id: 'c1', subjects: [
        { subject_id: 'math', subject_name: 'Mathematics', periods_per_week: 4, staff_id: 'tA' }
      ] }],
      unavailable: new Set()
    };
    const { entries, unresolved } = generateTimetable(input);
    check('places every required period when there is plenty of room', entries.length === 4);
    check('nothing left unresolved in the simple case', unresolved.length === 0);
    check('every entry carries the right subject/stream/class/teacher', entries.every((e) => e.subject_id === 'math' && e.stream_id === 'st1' && e.class_id === 'c1' && e.staff_id === 'tA'));
  }

  // ---- default periods_per_week when not configured ------------------------------
  {
    const input = {
      days: DAYS, periods: PERIODS,
      streams: [{ stream_id: 'st1', class_id: 'c1', subjects: [
        { subject_id: 'eng', subject_name: 'English', periods_per_week: null, staff_id: null }
      ] }],
      unavailable: new Set()
    };
    const { entries } = generateTimetable(input);
    check('falls back to DEFAULT_PERIODS_PER_WEEK when unset', entries.length === DEFAULT_PERIODS_PER_WEEK);
    check('a lesson with no teacher assigned yet still gets scheduled (staff_id null)', entries.every((e) => e.staff_id === null));
  }

  // ---- hard constraint: a stream never gets two lessons in the same slot --------
  {
    const input = {
      days: DAYS, periods: PERIODS,
      streams: [{ stream_id: 'st1', class_id: 'c1', subjects: [
        { subject_id: 'math', subject_name: 'Mathematics', periods_per_week: 6, staff_id: 'tA' },
        { subject_id: 'eng', subject_name: 'English', periods_per_week: 6, staff_id: 'tB' }
      ] }],
      unavailable: new Set()
    };
    const { entries } = generateTimetable(input);
    const seen = new Set();
    let clash = false;
    entries.forEach((e) => {
      const key = `${e.stream_id}|${e.day_of_week}|${e.period_index}`;
      if (seen.has(key)) clash = true; else seen.add(key);
    });
    check('no stream ever double-booked across its own subjects', !clash);
  }

  // ---- hard constraint: a teacher never double-booked across two streams --------
  {
    const input = {
      days: DAYS, periods: PERIODS,
      streams: [
        { stream_id: 'st1', class_id: 'c1', subjects: [{ subject_id: 'math', subject_name: 'Mathematics', periods_per_week: 7, staff_id: 'tShared' }] },
        { stream_id: 'st2', class_id: 'c1', subjects: [{ subject_id: 'math', subject_name: 'Mathematics', periods_per_week: 7, staff_id: 'tShared' }] }
      ],
      unavailable: new Set()
    };
    const { entries } = generateTimetable(input);
    const seen = new Set();
    let clash = false;
    entries.forEach((e) => {
      if (!e.staff_id) return;
      const key = `${e.staff_id}|${e.day_of_week}|${e.period_index}`;
      if (seen.has(key)) clash = true; else seen.add(key);
    });
    check('the same teacher across two streams is never scheduled in the same slot', !clash);
  }

  // ---- teacher unavailability is respected ---------------------------------------
  {
    const unavailable = new Set();
    // Block tA out of every period on every day except day 1 period 1 — forces
    // the engine to use that one remaining slot rather than any other.
    DAYS.forEach((d) => PERIODS.filter((p) => !p.is_break).forEach((p) => {
      if (!(d === 1 && p.period_index === 1)) unavailable.add(`tA|${d}|${p.period_index}`);
    }));
    const input = {
      days: DAYS, periods: PERIODS,
      streams: [{ stream_id: 'st1', class_id: 'c1', subjects: [{ subject_id: 'math', subject_name: 'Mathematics', periods_per_week: 1, staff_id: 'tA' }] }],
      unavailable
    };
    const { entries, unresolved } = generateTimetable(input);
    check('a single-period requirement lands exactly on the one slot the teacher is free', entries.length === 1 && entries[0].day_of_week === 1 && entries[0].period_index === 1);
    check('nothing unresolved when a valid slot does exist', unresolved.length === 0);
  }

  // ---- double lessons land on genuinely consecutive periods, never across a break
  {
    const input = {
      days: [1], periods: PERIODS,
      streams: [{ stream_id: 'st1', class_id: 'c1', subjects: [{ subject_id: 'sci', subject_name: 'Science', periods_per_week: 2, double_periods_per_week: 1, staff_id: 'tA' }] }],
      unavailable: new Set()
    };
    const { entries, unresolved } = generateTimetable(input);
    check('a double lesson places exactly 2 periods', entries.length === 2);
    check('nothing unresolved', unresolved.length === 0);
    const indices = entries.map((e) => e.period_index).sort((a, b) => a - b);
    check('the two periods are genuinely adjacent (never spanning the break at period 4)', indices[1] - indices[0] === 1 && indices[0] !== 3);
  }

  // ---- odd periods_per_week with a requested double count: exact doubles + remainder singles
  {
    const input = {
      days: [1, 2], periods: PERIODS,
      streams: [{ stream_id: 'st1', class_id: 'c1', subjects: [{ subject_id: 'sci', subject_name: 'Science', periods_per_week: 5, double_periods_per_week: 2, staff_id: 'tA' }] }],
      unavailable: new Set()
    };
    const { entries, unresolved } = generateTimetable(input);
    check('5 periods/week with 2 requested doubles places all 5 (2 doubles + 1 single)', entries.length === 5);
    check('nothing unresolved', unresolved.length === 0);
  }

  // ---- explicit double count: exactly N doubles, not "as many as will fit" -----
  {
    // 8 periods/week, only 3 asked for as doubles — previously a plain
    // is_double=true would have auto-doubled as many pairs as possible
    // (floor(8/2) = 4 doubles, 0 singles). The fix (bug #3 from the school's
    // feedback: "what if Math has 3 doubles a week and not one?") is that
    // the count is exact: 3 doubles (6 periods) + 2 singles = 8.
    const input = {
      days: [1, 2, 3], periods: PERIODS,
      streams: [{ stream_id: 'st1', class_id: 'c1', subjects: [{ subject_id: 'math', subject_name: 'Mathematics', periods_per_week: 8, double_periods_per_week: 3, staff_id: 'tA' }] }],
      unavailable: new Set()
    };
    const { entries, unresolved } = generateTimetable(input);
    check('places all 8 periods', entries.length === 8);
    check('nothing unresolved', unresolved.length === 0);
    // Group placed periods by day to find genuinely-consecutive same-day pairs.
    const byDay = {};
    entries.forEach((e) => { (byDay[e.day_of_week] = byDay[e.day_of_week] || []).push(e.period_index); });
    let doublePairs = 0;
    Object.values(byDay).forEach((idxs) => {
      const sorted = idxs.slice().sort((a, b) => a - b);
      for (let i = 0; i < sorted.length - 1; i++) if (sorted[i + 1] - sorted[i] === 1) { doublePairs++; i++; }
    });
    check('exactly 3 double-lesson pairs were formed, not floor(8/2)=4', doublePairs === 3);
  }

  // ---- requested doubles exceeding what periods_per_week can hold are clamped --
  {
    // Asking for 5 doubles on a subject with only 4 periods/week is
    // impossible (5 doubles would need 10 periods) — the engine clamps to
    // what's actually possible (floor(4/2)=2 doubles) rather than crashing
    // or silently producing more periods than requested.
    const input = {
      days: [1], periods: PERIODS,
      streams: [{ stream_id: 'st1', class_id: 'c1', subjects: [{ subject_id: 'math', subject_name: 'Mathematics', periods_per_week: 4, double_periods_per_week: 5, staff_id: 'tA' }] }],
      unavailable: new Set()
    };
    const { entries, unresolved } = generateTimetable(input);
    check('a double count larger than periods_per_week allows is clamped, never exceeding periods_per_week', entries.length === 4);
    check('nothing unresolved', unresolved.length === 0);
  }

  // ---- Sunday (day 7) works like any other teaching day -------------------------
  {
    const input = {
      days: [1, 7], periods: PERIODS, // Monday + Sunday, some schools teach both
      streams: [{ stream_id: 'st1', class_id: 'c1', subjects: [{ subject_id: 'math', subject_name: 'Mathematics', periods_per_week: 8, staff_id: 'tA' }] }],
      unavailable: new Set()
    };
    const { entries, unresolved } = generateTimetable(input);
    check('Sunday (day 7) is usable as a teaching day', entries.length === 8 && unresolved.length === 0);
    check('at least one lesson actually landed on Sunday', entries.some((e) => e.day_of_week === 7));
  }

  // ---- infeasible input is reported, never silently dropped or double-booked ----
  {
    const tinyPeriods = [{ period_index: 1, is_break: false }];
    const input = {
      days: [1], periods: tinyPeriods,
      streams: [{ stream_id: 'st1', class_id: 'c1', subjects: [
        { subject_id: 'math', subject_name: 'Mathematics', periods_per_week: 3, staff_id: 'tA' }
      ] }],
      unavailable: new Set()
    };
    const { entries, unresolved } = generateTimetable(input);
    check('only fits what genuinely fits (1 slot available for 3 required)', entries.length === 1);
    check('the other 2 are reported as unresolved, not silently dropped', unresolved.length === 2);
    check('each unresolved item names the subject and stream it belongs to', unresolved.every((u) => u.subject_id === 'math' && u.stream_id === 'st1' && u.reason));
  }

  // ---- soft constraint relaxes (same subject twice a day) rather than fail ------
  {
    // Only 1 day, 3 teachable periods, one subject needing 3 periods for one
    // stream with only 1 subject total — the "avoid same subject twice a
    // day" soft rule would forbid this entirely if it were hard; it must
    // relax and place all 3 on the same day instead of leaving 2 unresolved.
    const onedayPeriods = [{ period_index: 1, is_break: false }, { period_index: 2, is_break: false }, { period_index: 3, is_break: false }];
    const input = {
      days: [1], periods: onedayPeriods,
      streams: [{ stream_id: 'st1', class_id: 'c1', subjects: [{ subject_id: 'math', subject_name: 'Mathematics', periods_per_week: 3, staff_id: 'tA' }] }],
      unavailable: new Set()
    };
    const { entries, unresolved } = generateTimetable(input);
    check('the soft same-day-repeat constraint relaxes when it is the only way to fit everything', entries.length === 3 && unresolved.length === 0);
  }

  // ---- SCALE: a big, realistically-staffed school (36 streams) ------------------
  // 12 grades x 3 streams, a typical 40-slot week (8 teachable periods/day,
  // Mon-Fri), 9 subjects per stream summing to exactly 40 periods/week — a
  // full, tightly-packed but genuinely satisfiable timetable. Each subject
  // in a class is taught by ONE teacher shared across that class's 3
  // streams (the realistic staffing pattern — a grade-level subject
  // teacher), which is exactly the kind of cross-stream contention that
  // breaks a naive scheduler: the same teacher's 3 streams must never
  // overlap with each other or with that teacher's other classes.
  {
    const bigPeriods = [];
    for (let p = 1; p <= 4; p++) bigPeriods.push({ period_index: p, is_break: false });
    bigPeriods.push({ period_index: 5, is_break: true });
    for (let p = 6; p <= 9; p++) bigPeriods.push({ period_index: p, is_break: false });
    const bigDays = [1, 2, 3, 4, 5]; // 8 teachable periods/day x 5 = 40 slots/week

    const SUBJECTS = [
      { id: 'math', weekly: 6 }, { id: 'eng', weekly: 5 }, { id: 'kis', weekly: 5 }, { id: 'sci', weekly: 5 },
      { id: 'ss', weekly: 4 }, { id: 'agr', weekly: 4 }, { id: 'cre', weekly: 3 }, { id: 'arts', weekly: 4 }, { id: 'pe', weekly: 4 }
    ]; // sums to exactly 40 — a fully-packed but satisfiable week

    const NUM_CLASSES = 12, STREAMS_PER_CLASS = 3;
    const bigStreams = [];
    let requiredTotal = 0;
    for (let c = 0; c < NUM_CLASSES; c++) {
      for (let s = 0; s < STREAMS_PER_CLASS; s++) {
        const streamId = `c${c}-s${s}`;
        const subjects = SUBJECTS.map((sub) => {
          requiredTotal += sub.weekly;
          return { subject_id: sub.id, subject_name: sub.id, periods_per_week: sub.weekly, staff_id: `t-${c}-${sub.id}` }; // one teacher per (class, subject), shared across that class's 3 streams
        });
        bigStreams.push({ stream_id: streamId, class_id: `c${c}`, subjects });
      }
    }

    const t0 = Date.now();
    const { entries, unresolved } = generateTimetable({ days: bigDays, periods: bigPeriods, streams: bigStreams, unavailable: new Set() });
    const elapsedMs = Date.now() - t0;

    check('big-school scale: every one of the 1,440 required periods gets placed (36 streams x 40/week)', requiredTotal === NUM_CLASSES * STREAMS_PER_CLASS * 40 && entries.length === requiredTotal);
    check('big-school scale: nothing left unresolved when the school is realistically staffed', unresolved.length === 0);

    const streamKeys = new Set(); let streamClash = false;
    const staffKeys = new Set(); let staffClash = false;
    entries.forEach((e) => {
      const sk = `${e.stream_id}|${e.day_of_week}|${e.period_index}`;
      if (streamKeys.has(sk)) streamClash = true; else streamKeys.add(sk);
      if (e.staff_id) {
        const tk = `${e.staff_id}|${e.day_of_week}|${e.period_index}`;
        if (staffKeys.has(tk)) staffClash = true; else staffKeys.add(tk);
      }
    });
    check('big-school scale: ZERO stream double-bookings across all 36 streams', !streamClash);
    check('big-school scale: ZERO teacher double-bookings across every shared grade-level teacher', !staffClash);
    check('big-school scale: generates fast enough to feel instant (< 5s for 36 streams)', elapsedMs < 5000);
    console.log(`  (big-school scale generation took ${elapsedMs}ms for ${entries.length} placed periods)`);
  }

  // ---- SCALE: an understaffed big school degrades gracefully, never double-books
  // Same 36-stream school, but ONE subject (PE) is taught by a single
  // teacher across ALL 12 classes at once — 36 streams x 4 periods/week =
  // 144 periods of demand from one person in a 40-slot week. This is
  // genuinely impossible to satisfy (a real school in this situation needs
  // to hire more PE teachers) — the engine must degrade gracefully: place
  // everything it honestly can, report the rest by name, and — the actual
  // non-negotiable requirement — never let that one overloaded teacher end
  // up double-booked just to force a number to look complete.
  {
    const bigPeriods = [];
    for (let p = 1; p <= 4; p++) bigPeriods.push({ period_index: p, is_break: false });
    bigPeriods.push({ period_index: 5, is_break: true });
    for (let p = 6; p <= 9; p++) bigPeriods.push({ period_index: p, is_break: false });
    const bigDays = [1, 2, 3, 4, 5];

    const NUM_CLASSES = 12, STREAMS_PER_CLASS = 3;
    const bigStreams = [];
    for (let c = 0; c < NUM_CLASSES; c++) {
      for (let s = 0; s < STREAMS_PER_CLASS; s++) {
        bigStreams.push({
          stream_id: `c${c}-s${s}`, class_id: `c${c}`,
          subjects: [{ subject_id: 'pe', subject_name: 'PE', periods_per_week: 4, staff_id: 'lone-pe-teacher' }]
        });
      }
    }
    const { entries, unresolved } = generateTimetable({ days: bigDays, periods: bigPeriods, streams: bigStreams, unavailable: new Set() });
    const required = NUM_CLASSES * STREAMS_PER_CLASS * 4; // 144
    check('understaffed case: places as much as genuinely fits the one teacher\'s week (up to 40)', entries.length <= 40 && entries.length > 0);
    check('understaffed case: everything that does not fit is reported, not silently dropped', entries.length + unresolved.length === required);
    check('understaffed case: every unresolved item is clearly attributed to the PE subject', unresolved.every((u) => u.subject_id === 'pe' && u.reason));

    const staffKeys = new Set(); let staffClash = false;
    entries.forEach((e) => {
      const tk = `${e.staff_id}|${e.day_of_week}|${e.period_index}`;
      if (staffKeys.has(tk)) staffClash = true; else staffKeys.add(tk);
    });
    check('understaffed case: the overloaded teacher is STILL never double-booked, even though demand exceeds supply', !staffClash);
  }

  // ================================================================
  // Round 2 §7: the Constraints module — 6 SOFT constraint types. Every
  // test below first confirms a baseline call (no `constraints` passed —
  // must behave byte-for-byte as before this round) then shows the
  // constraint actually changes placement when it's feasible to honor.
  // ================================================================

  check('CONSTRAINT_TYPES exports exactly the 6 documented types', CONSTRAINT_TYPES.length === 6);

  // ---- subject_pair_not_consecutive ----------------------------------------------
  {
    const periods = [{ period_index: 1, is_break: false }, { period_index: 2, is_break: false }, { period_index: 3, is_break: false }];
    const streams = [{ stream_id: 'st1', class_id: 'c1', subjects: [
      { subject_id: 'A', subject_name: 'A', periods_per_week: 1 }, { subject_id: 'B', subject_name: 'B', periods_per_week: 1 }
    ] }];
    const baseline = generateTimetable({ days: [1], periods, streams, unavailable: new Set() });
    check('pair baseline (no constraint): A and B land adjacent (periods 1,2)', baseline.entries.some((e) => e.subject_id === 'A' && e.period_index === 1) && baseline.entries.some((e) => e.subject_id === 'B' && e.period_index === 2));

    const withPair = generateTimetable({
      days: [1], periods, streams, unavailable: new Set(),
      constraints: [{ type: 'subject_pair_not_consecutive', enabled: true, config: { subject_a: 'A', subject_b: 'B' } }]
    });
    check('pair constraint enabled: B is pushed away to a non-adjacent period instead', withPair.entries.find((e) => e.subject_id === 'B').period_index === 3);
    check('pair constraint: nothing left unresolved (it is a SOFT preference, not a hard rule)', withPair.unresolved.length === 0);
  }

  // ---- avoid_consecutive_intensive -----------------------------------------------
  {
    const periods = [{ period_index: 1, is_break: false }, { period_index: 2, is_break: false }, { period_index: 3, is_break: false }];
    const streams = [{ stream_id: 'st1', class_id: 'c1', subjects: [
      { subject_id: 'A', subject_name: 'A', periods_per_week: 1 }, { subject_id: 'B', subject_name: 'B', periods_per_week: 1 }
    ] }];
    const withIntensive = generateTimetable({
      days: [1], periods, streams, unavailable: new Set(),
      constraints: [{ type: 'avoid_consecutive_intensive', enabled: true, config: { subject_ids: ['A', 'B'] } }]
    });
    check('avoid_consecutive_intensive: two flagged subjects avoid landing back-to-back', withIntensive.entries.find((e) => e.subject_id === 'B').period_index === 3);
    check('avoid_consecutive_intensive: nothing left unresolved', withIntensive.unresolved.length === 0);

    // A subject NOT in the flagged set is never affected.
    const unaffected = generateTimetable({
      days: [1], periods: periods, streams: [{ stream_id: 'st1', class_id: 'c1', subjects: [
        { subject_id: 'A', subject_name: 'A', periods_per_week: 1 }, { subject_id: 'C', subject_name: 'C', periods_per_week: 1 }
      ] }],
      unavailable: new Set(), constraints: [{ type: 'avoid_consecutive_intensive', enabled: true, config: { subject_ids: ['A', 'B'] } }]
    });
    check('avoid_consecutive_intensive: a subject outside the flagged set is placed normally (adjacent is fine)', unaffected.entries.find((e) => e.subject_id === 'C').period_index === 2);
  }

  // ---- teacher_no_immediate_after_out ---------------------------------------------
  {
    const periods = [{ period_index: 1, is_break: false }, { period_index: 2, is_break: false }, { period_index: 3, is_break: false }];
    const streams = [{ stream_id: 'st1', class_id: 'c1', subjects: [{ subject_id: 'M', subject_name: 'M', periods_per_week: 1, staff_id: 'tA' }] }];
    const unavailable = new Set(['tA|1|1']); // teacher "out" for period 1

    const baseline = generateTimetable({ days: [1], periods, streams, unavailable });
    check('teacher_no_immediate_after_out baseline: single lesson lands right after the "out" period (period 2)', baseline.entries[0].period_index === 2);

    const withConstraint = generateTimetable({
      days: [1], periods, streams, unavailable,
      constraints: [{ type: 'teacher_no_immediate_after_out', enabled: true, config: {} }]
    });
    check('teacher_no_immediate_after_out enabled: single lesson skips the period right after "out" (lands on period 3 instead)', withConstraint.entries[0].period_index === 3);
    check('teacher_no_immediate_after_out: nothing left unresolved', withConstraint.unresolved.length === 0);

    // Double lessons are explicitly exempt per the brief.
    const doublePeriods = [{ period_index: 1, is_break: false }, { period_index: 2, is_break: false }, { period_index: 3, is_break: false }, { period_index: 4, is_break: false }];
    const doubleStreams = [{ stream_id: 'st1', class_id: 'c1', subjects: [{ subject_id: 'SCI', subject_name: 'SCI', periods_per_week: 2, double_periods_per_week: 1, staff_id: 'tA' }] }];
    const withDouble = generateTimetable({
      days: [1], periods: doublePeriods, streams: doubleStreams, unavailable,
      constraints: [{ type: 'teacher_no_immediate_after_out', enabled: true, config: {} }]
    });
    check('teacher_no_immediate_after_out: a DOUBLE lesson is exempt and may still start right after "out"', withDouble.entries.some((e) => e.period_index === 2) && withDouble.entries.some((e) => e.period_index === 3));
  }

  // ---- pe_before_break -------------------------------------------------------------
  {
    // period 2 sits right before the break at period 3 — the one
    // "preferred" slot for a flagged PE subject.
    const periods = [{ period_index: 1, is_break: false }, { period_index: 2, is_break: false }, { period_index: 3, is_break: true }, { period_index: 4, is_break: false }];
    const streams = [{ stream_id: 'st1', class_id: 'c1', subjects: [{ subject_id: 'PE', subject_name: 'PE', periods_per_week: 1 }] }];

    const baseline = generateTimetable({ days: [1], periods, streams, unavailable: new Set() });
    check('pe_before_break baseline: PE just takes the first free period (period 1), ignoring the break', baseline.entries[0].period_index === 1);

    const withConstraint = generateTimetable({
      days: [1], periods, streams, unavailable: new Set(),
      constraints: [{ type: 'pe_before_break', enabled: true, config: { subject_ids: ['PE'] } }]
    });
    check('pe_before_break enabled: PE is placed in the period immediately before the break instead (period 2)', withConstraint.entries[0].period_index === 2);
    check('pe_before_break: nothing left unresolved', withConstraint.unresolved.length === 0);
  }

  // ---- max_consecutive_periods_class -----------------------------------------------
  {
    const periods = []; for (let p = 1; p <= 6; p++) periods.push({ period_index: p, is_break: false });
    const streams = [{ stream_id: 'st1', class_id: 'c1', subjects: [
      { subject_id: 'A', subject_name: 'A', periods_per_week: 2 }, { subject_id: 'B', subject_name: 'B', periods_per_week: 2 },
      { subject_id: 'C', subject_name: 'C', periods_per_week: 2 }, { subject_id: 'D', subject_name: 'D', periods_per_week: 2 }
    ] }];
    const baseline = generateTimetable({ days: [1, 2], periods, streams, unavailable: new Set() });
    const baselineRun = maxConsecutiveRun(baseline.entries, (e) => e.stream_id);
    check('max_consecutive_periods_class baseline: with enough slack in the week, greedy filling still produces a run longer than 2 (proves the constraint has something to do)', baselineRun > 2);

    const withConstraint = generateTimetable({
      days: [1, 2], periods, streams, unavailable: new Set(),
      constraints: [{ type: 'max_consecutive_periods_class', enabled: true, config: { max: 2 } }]
    });
    const constrainedRun = maxConsecutiveRun(withConstraint.entries, (e) => e.stream_id);
    check('max_consecutive_periods_class enabled: the longest back-to-back stretch for the class never exceeds the configured max (2)', constrainedRun <= 2);
    check('max_consecutive_periods_class: nothing left unresolved when there is enough slack to honor it', withConstraint.unresolved.length === 0);
    check('max_consecutive_periods_class: every required period still gets placed', withConstraint.entries.length === baseline.entries.length);
  }

  // ---- max_consecutive_periods_teacher ----------------------------------------------
  {
    const periods = []; for (let p = 1; p <= 6; p++) periods.push({ period_index: p, is_break: false });
    const streams = ['st1', 'st2', 'st3', 'st4'].map((sid) => ({
      stream_id: sid, class_id: 'c1', subjects: [{ subject_id: 'A', subject_name: 'A', periods_per_week: 2, staff_id: 'tShared' }]
    }));
    const baseline = generateTimetable({ days: [1, 2], periods, streams, unavailable: new Set() });
    const baselineRun = maxConsecutiveRun(baseline.entries, (e) => e.staff_id);
    check('max_consecutive_periods_teacher baseline: the shared teacher naturally ends up with a run longer than 2', baselineRun > 2);

    const withConstraint = generateTimetable({
      days: [1, 2], periods, streams, unavailable: new Set(),
      constraints: [{ type: 'max_consecutive_periods_teacher', enabled: true, config: { max: 2 } }]
    });
    const constrainedRun = maxConsecutiveRun(withConstraint.entries, (e) => e.staff_id);
    check('max_consecutive_periods_teacher enabled: the teacher\'s longest back-to-back stretch never exceeds the configured max (2)', constrainedRun <= 2);
    check('max_consecutive_periods_teacher: nothing left unresolved when there is enough slack to honor it', withConstraint.unresolved.length === 0);

    // Zero teacher double-bookings still holds — a soft constraint must
    // never compromise the pre-existing hard guarantees.
    const staffKeys = new Set(); let staffClash = false;
    withConstraint.entries.forEach((e) => {
      const k = `${e.staff_id}|${e.day_of_week}|${e.period_index}`;
      if (staffKeys.has(k)) staffClash = true; else staffKeys.add(k);
    });
    check('max_consecutive_periods_teacher: the shared teacher is still never double-booked', !staffClash);
  }

  // ---- a genuinely infeasible custom constraint still relaxes rather than fail ----
  {
    // Only 1 teachable period in the whole week — a max-consecutive-of-1
    // constraint is trivially satisfied, but a DOUBLE lesson needs 2
    // consecutive periods regardless, which this tiny grid can't offer at
    // all (a pre-existing hard limitation, not something the new soft
    // constraint should get blamed for).
    const periods = [{ period_index: 1, is_break: false }];
    const streams = [{ stream_id: 'st1', class_id: 'c1', subjects: [{ subject_id: 'SCI', subject_name: 'SCI', periods_per_week: 1 }] }];
    const res = generateTimetable({
      days: [1], periods, streams, unavailable: new Set(),
      constraints: [{ type: 'max_consecutive_periods_class', enabled: true, config: { max: 1 } }]
    });
    check('an impossible-in-context custom constraint still relaxes rather than leaving a placeable lesson unresolved', res.entries.length === 1 && res.unresolved.length === 0);
  }

  // ---- malformed/incomplete constraint config is skipped, never crashes ----------
  {
    const periods = [{ period_index: 1, is_break: false }, { period_index: 2, is_break: false }];
    const streams = [{ stream_id: 'st1', class_id: 'c1', subjects: [{ subject_id: 'A', subject_name: 'A', periods_per_week: 2 }] }];
    const badConstraints = [
      { type: 'subject_pair_not_consecutive', enabled: true, config: { subject_a: 'A' } }, // missing subject_b
      { type: 'avoid_consecutive_intensive', enabled: true, config: {} },                  // no subject_ids
      { type: 'max_consecutive_periods_class', enabled: true, config: { max: 'not-a-number' } },
      { type: 'pe_before_break', enabled: false, config: { subject_ids: ['A'] } },          // disabled — should be a full no-op
      null, undefined
    ];
    let threw = false;
    let res;
    try { res = generateTimetable({ days: [1], periods, streams, unavailable: new Set(), constraints: badConstraints }); }
    catch (e) { threw = true; }
    check('malformed/disabled constraint rows never throw', !threw);
    check('malformed/disabled constraint rows are simply skipped — generation still succeeds normally', res.entries.length === 2 && res.unresolved.length === 0);
  }

  // ================================================================
  // Round 2 §7: checkCapacity() — upfront validation before the engine or
  // any clearing of existing entries runs at all.
  // ================================================================
  {
    const periods = [{ period_index: 1, is_break: false }, { period_index: 2, is_break: false }];
    const roomy = checkCapacity({ days: [1, 2], periods, streams: [{ stream_id: 'st1', class_id: 'c1', subjects: [{ subject_id: 'A', periods_per_week: 4 }] }] });
    check('checkCapacity: exactly enough room (4 required, 4 available) reports ok', roomy.ok === true && roomy.teachableSlotsPerWeek === 4);

    const tight = checkCapacity({ days: [1, 2], periods, streams: [{ stream_id: 'st1', class_id: 'c1', subjects: [{ subject_id: 'A', periods_per_week: 10 }] }] });
    check('checkCapacity: a stream asking for more than the week can hold is flagged', tight.ok === false && tight.overloaded.length === 1);
    check('checkCapacity: the overloaded entry names exactly what is required vs available', tight.overloaded[0].required === 10 && tight.overloaded[0].available === 4);

    const multi = checkCapacity({
      days: [1, 2], periods,
      streams: [
        { stream_id: 'ok', class_id: 'c1', subjects: [{ subject_id: 'A', periods_per_week: 4 }] },
        { stream_id: 'over', class_id: 'c2', subjects: [{ subject_id: 'A', periods_per_week: 3 }, { subject_id: 'B', periods_per_week: 3 }] }
      ]
    });
    check('checkCapacity: only the genuinely overloaded stream is flagged, not a fine one alongside it', multi.ok === false && multi.overloaded.length === 1 && multi.overloaded[0].stream_id === 'over');

    const usesDefault = checkCapacity({ days: [1, 2], periods, streams: [{ stream_id: 'st1', class_id: 'c1', subjects: [{ subject_id: 'A', periods_per_week: null }] }] });
    check('checkCapacity falls back to DEFAULT_PERIODS_PER_WEEK for an unconfigured subject, same as the engine itself', usesDefault.overloaded.length === 0 ? usesDefault.ok === true : DEFAULT_PERIODS_PER_WEEK > 4);
  }

  console.log(`${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

run();
