import { timeToMinutes, computeAttendanceFlags } from '../src/lib/staffAttendance.mjs';

let passed = 0, failed = 0;
function check(name, cond) { if (cond) passed++; else { failed++; console.error('FAIL:', name); } }

function run() {
  // ---- timeToMinutes -----------------------------------------------------------
  check('timeToMinutes parses HH:MM', timeToMinutes('08:15') === 8 * 60 + 15);
  check('timeToMinutes parses HH:MM:SS (Postgres time column format)', timeToMinutes('08:15:00') === 8 * 60 + 15);
  check('timeToMinutes parses a single-digit hour', timeToMinutes('7:05') === 7 * 60 + 5);
  check('timeToMinutes returns null for blank/undefined/null', timeToMinutes('') === null && timeToMinutes(undefined) === null && timeToMinutes(null) === null);
  check('timeToMinutes returns null for garbage input', timeToMinutes('not a time') === null);
  check('timeToMinutes rejects an out-of-range hour', timeToMinutes('25:00') === null);

  // ---- computeAttendanceFlags ----------------------------------------------------
  {
    // Round 3 §19: signed in after the expected arrival time -> late.
    const r = computeAttendanceFlags(
      { sign_in_time: '08:15', sign_out_time: '16:00' },
      { expected_arrival: '08:00', expected_departure: '16:00' }
    );
    check('signing in after the expected arrival time is flagged late', r.isLate === true);
    check('signing out exactly at the expected departure time is not flagged as leaving early', r.leftEarly === false);
  }
  {
    // On time / on time.
    const r = computeAttendanceFlags(
      { sign_in_time: '07:55', sign_out_time: '16:30' },
      { expected_arrival: '08:00', expected_departure: '16:00' }
    );
    check('signing in before the expected arrival time is not late', r.isLate === false);
    check('signing out after the expected departure time is not an early leave', r.leftEarly === false);
  }
  {
    // Left early.
    const r = computeAttendanceFlags(
      { sign_in_time: '08:00', sign_out_time: '15:30' },
      { expected_arrival: '08:00', expected_departure: '16:00' }
    );
    check('signing out before the expected departure time is flagged as leaving early', r.leftEarly === true);
  }
  {
    // Missing data -> "can't say" (null), never guessed.
    const noExpected = computeAttendanceFlags({ sign_in_time: '09:00', sign_out_time: '15:00' }, {});
    check('no expected times configured -> both flags are null, not a guess', noExpected.isLate === null && noExpected.leftEarly === null);

    const noActual = computeAttendanceFlags({}, { expected_arrival: '08:00', expected_departure: '16:00' });
    check('no sign-in/out recorded yet -> both flags are null', noActual.isLate === null && noActual.leftEarly === null);

    const partialActual = computeAttendanceFlags({ sign_in_time: '08:30' }, { expected_arrival: '08:00', expected_departure: '16:00' });
    check('sign-in recorded but not sign-out -> isLate is determined, leftEarly stays null', partialActual.isLate === true && partialActual.leftEarly === null);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

run();
