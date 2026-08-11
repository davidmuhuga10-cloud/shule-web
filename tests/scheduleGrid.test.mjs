import { timeToMinutes, minutesToTime, generatePeriods, cascadeTimes } from '../src/lib/timetable/scheduleGrid.mjs';

let passed = 0, failed = 0;
function check(name, cond) { if (cond) passed++; else { failed++; console.error('FAIL:', name); } }

function run() {
  // ---- timeToMinutes / minutesToTime ----------------------------------------------
  check('timeToMinutes parses HH:MM', timeToMinutes('08:40') === 520);
  check('timeToMinutes parses midnight', timeToMinutes('00:00') === 0);
  check('timeToMinutes returns null for empty/garbage input', timeToMinutes('') === null && timeToMinutes('nonsense') === null);
  check('minutesToTime formats back to HH:MM, zero-padded', minutesToTime(520) === '08:40' && minutesToTime(5) === '00:05');
  check('minutesToTime wraps past midnight instead of overflowing', minutesToTime(1440) === '00:00' && minutesToTime(1450) === '00:10');
  check('minutesToTime wraps a negative value too', minutesToTime(-10) === '23:50');

  // ---- generatePeriods: Round 5 §7 "just enter lessons/day + duration" -----------
  const gen = generatePeriods({ startTime: '08:00', lessonsPerDay: 4, lessonDuration: 40 });
  check('generatePeriods creates the requested number of rows', gen.length === 4);
  check('generatePeriods starts at the given start time', gen[0].start_time === '08:00' && gen[0].end_time === '08:40');
  check('generatePeriods rows are contiguous (each starts where the last ended)', gen[1].start_time === '08:40' && gen[2].start_time === '09:20' && gen[3].start_time === '10:00');
  check('generatePeriods labels rows Period 1, 2, 3...', gen[0].label === 'Period 1' && gen[3].label === 'Period 4');
  check('generatePeriods rows are never breaks', gen.every((r) => r.is_break === false));

  check('generatePeriods defaults to 08:00 when no start time is given', generatePeriods({ lessonsPerDay: 1, lessonDuration: 40 })[0].start_time === '08:00');
  check('generatePeriods clamps a zero/blank lesson count up to at least 1', generatePeriods({ startTime: '08:00', lessonsPerDay: '', lessonDuration: 40 }).length === 1);
  check('generatePeriods caps an absurdly large lesson count at 20', generatePeriods({ startTime: '08:00', lessonsPerDay: 500, lessonDuration: 40 }).length === 20);
  check('generatePeriods clamps a zero/blank duration up to at least 1 minute', generatePeriods({ startTime: '08:00', lessonsPerDay: 2, lessonDuration: '' })[0].end_time === '08:01');

  // ---- cascadeTimes: Round 5 §7 "editing a timeslot shifts every following one" --
  const rows = [
    { start_time: '08:00', end_time: '08:40', is_break: false, label: 'Period 1' },
    { start_time: '08:40', end_time: '09:20', is_break: false, label: 'Period 2' },
    { start_time: '10:00', end_time: '10:40', is_break: true, label: 'Break' },
    { start_time: '10:40', end_time: '11:20', is_break: false, label: 'Period 3' }
  ];
  // The brief's own example: a 10:00-10:40 break edited to START at 10:20
  // (its own 40-minute length preserved) should shift Period 3 to start at
  // 11:00 (10:20 + 40) and keep ITS OWN 40-minute length too.
  const editedRows = rows.map((r, i) => i === 2 ? { ...r, start_time: '10:20', end_time: '11:00' } : r);
  const cascaded = cascadeTimes(editedRows, 2);
  check('cascadeTimes leaves rows before the edited one untouched', cascaded[0].start_time === '08:00' && cascaded[1].start_time === '08:40');
  check('cascadeTimes leaves the edited row exactly as given', cascaded[2].start_time === '10:20' && cascaded[2].end_time === '11:00');
  check('cascadeTimes shifts the following row to start where the edited one now ends', cascaded[3].start_time === '11:00');
  check('cascadeTimes preserves the following row\'s OWN original 40-minute duration', cascaded[3].end_time === '11:40');

  // A multi-row cascade: editing row 0 shifts every later row, each keeping its own length.
  const rows2 = [
    { start_time: '08:00', end_time: '08:40', label: 'P1' },
    { start_time: '08:40', end_time: '09:20', label: 'P2' },
    { start_time: '09:20', end_time: '10:00', label: 'P3' }
  ];
  const shifted = rows2.map((r, i) => i === 0 ? { ...r, start_time: '08:15', end_time: '08:55' } : r);
  const cascaded2 = cascadeTimes(shifted, 0);
  check('cascadeTimes propagates through multiple following rows', cascaded2[1].start_time === '08:55' && cascaded2[1].end_time === '09:35');
  check('cascadeTimes propagates all the way to the last row', cascaded2[2].start_time === '09:35' && cascaded2[2].end_time === '10:15');

  check('cascadeTimes does nothing when the edited row is the last one', JSON.stringify(cascadeTimes(rows2, 2)) === JSON.stringify(rows2));
  check('cascadeTimes does not mutate the array it was given', rows2[1].start_time === '08:40');
  check('cascadeTimes handles a row with no parseable original duration by defaulting to 40 minutes', cascadeTimes([{ start_time: '08:00', end_time: '08:30' }, { start_time: '', end_time: '' }], 0)[1].end_time === '09:10');

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

run();
