import { generateTimetable, DEFAULT_PERIODS_PER_WEEK } from '../src/lib/timetable/generate.mjs';

let passed = 0, failed = 0;
function check(name, cond) { if (cond) passed++; else { failed++; console.error('FAIL:', name); } }

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

  console.log(`${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

run();
