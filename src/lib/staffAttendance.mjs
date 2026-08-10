/**
 * staffAttendance.mjs — Round 3 §19: "Add a new feature under the
 * Attendance module for staff sign-in and sign-out, capturing the actual
 * time of each... The system should automatically flag staff who signed in
 * late or left early, based on [admin-]set [expected] times."
 *
 * Pure computation only (no DOM, no Supabase) — same convention as
 * broadsheetSummary.mjs/marksCsv.mjs — so it's unit-testable without a
 * browser and reusable anywhere the flag needs showing (the Sign In/Out
 * screen today; a future report could reuse it unchanged).
 *
 * Deliberately NOT stored on the staff_attendance row (see schema.sql's
 * comment on that table): computed here, at read time, against whatever the
 * school's expected arrival/departure times currently are — so changing
 * those expected times later reclassifies every already-recorded day
 * consistently, rather than leaving old rows stamped against a
 * since-changed cutoff.
 */

/** Parses 'HH:MM' or 'HH:MM:SS' (what a Postgres `time` column and an
 *  <input type="time"> both produce) into minutes-since-midnight, or null
 *  for anything blank/unparseable — never throws. */
export function timeToMinutes(value) {
  const s = String(value === undefined || value === null ? '' : value).trim();
  const m = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(s);
  if (!m) return null;
  const h = Number(m[1]), min = Number(m[2]);
  if (isNaN(h) || isNaN(min) || h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h * 60 + min;
}

/** `{ sign_in_time, sign_out_time }` — one staff member's recorded times
 *  for a day. `{ expected_arrival, expected_departure }` — the school-wide
 *  settings (Settings.staff_expected_arrival_time/
 *  staff_expected_departure_time). Every field is optional; a flag is only
 *  ever `true`/`false` when BOTH the actual time and the matching expected
 *  time are present — otherwise it's `null` ("can't say"), never guessed. */
export function computeAttendanceFlags(record, expected) {
  record = record || {}; expected = expected || {};
  const signIn = timeToMinutes(record.sign_in_time);
  const signOut = timeToMinutes(record.sign_out_time);
  const expectedArrival = timeToMinutes(expected.expected_arrival);
  const expectedDeparture = timeToMinutes(expected.expected_departure);

  const isLate = signIn !== null && expectedArrival !== null ? signIn > expectedArrival : null;
  const leftEarly = signOut !== null && expectedDeparture !== null ? signOut < expectedDeparture : null;

  return { isLate, leftEarly };
}
