/**
 * index.mjs — wires every data-access module to the real Supabase client and
 * the real Netlify admin function, and exports one `Db` object the views use.
 * This is the ONLY file in src/lib/api/ that touches the live client — every
 * other module takes it as a parameter, which is what makes them unit
 * testable with a mock (see tests/*.test.mjs).
 */
import { supabase } from '../supabaseClient.js';
import { getAccessToken } from '../auth.js';
import { createAcademicsApi } from './academics.mjs';
import { createStudentsApi } from './students.mjs';
import { createStaffApi } from './staff.mjs';
import { createAssignmentsApi } from './assignments.mjs';
import { createGradingApi } from './grading.mjs';
import { createResultsApi } from './results.mjs';
import { createDashboardApi } from './dashboard.mjs';
import { createSettingsApi } from './settings.mjs';
import { createUsersApi } from './users.mjs';
import { createAttendanceApi } from './attendance.mjs';
import { createMessagingApi } from './messaging.mjs';
import { createParentsApi } from './parents.mjs';
import { createCapabilitiesApi } from './capabilities.mjs';
import { createTimetableApi } from './timetable.mjs';
import { createFinanceApi } from './finance.mjs';
import { createSmsCreditsApi } from './smsCredits.mjs';

async function callAdminFunction(action, payload) {
  const token = await getAccessToken();
  if (!token) return { ok: false, message: 'Not signed in.' };
  const res = await fetch('/.netlify/functions/admin-provision', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ action, ...payload })
  });
  try {
    return await res.json();
  } catch (e) {
    return { ok: false, message: 'Unexpected response from the server (' + res.status + ').' };
  }
}

/** Same shape as callAdminFunction, but for staff-level (admin OR teacher)
 *  Netlify functions — kept separate from callAdminFunction so a caller can
 *  never accidentally hit an admin-only endpoint with a messaging payload.
 *  Shared by send-message.js and resend-message.js (Messaging_Overhaul.docx
 *  item 8's resend action). */
async function callStaffFunction(fnName, payload) {
  const token = await getAccessToken();
  if (!token) return { ok: false, message: 'Not signed in.' };
  const res = await fetch(`/.netlify/functions/${fnName}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(payload)
  });
  try {
    return await res.json();
  } catch (e) {
    return { ok: false, message: 'Unexpected response from the server (' + res.status + ').' };
  }
}
const callSendMessage = (payload) => callStaffFunction('send-message', payload);
const callResendMessage = (payload) => callStaffFunction('resend-message', payload);

const academics = createAcademicsApi(supabase);
const grading = createGradingApi(supabase);
const settings = createSettingsApi(supabase);

export const Db = {
  academicYears: academics.academicYears,
  terms: academics.terms,
  classes: academics.classes,
  streams: academics.streams,
  subjects: academics.subjects,
  subjectPapers: academics.subjectPapers,
  subjectCombinations: academics.subjectCombinations,
  students: createStudentsApi(supabase),
  staff: createStaffApi(supabase),
  assignments: createAssignmentsApi(supabase),
  grading,
  results: createResultsApi(supabase, grading),
  dashboard: createDashboardApi(supabase),
  settings,
  users: createUsersApi(supabase, callAdminFunction),
  attendance: createAttendanceApi(supabase),
  messaging: createMessagingApi(supabase, callSendMessage, callResendMessage),
  parents: createParentsApi(supabase, callAdminFunction),
  capabilities: createCapabilitiesApi(supabase),
  // Round 4 §7: the Timetable module. settings is injected (see
  // timetable.mjs's header comment) so `days` can read/write
  // `settings.timetable_days` through the exact same batched save() every
  // other settings field already uses.
  timetable: createTimetableApi(supabase, settings),
  finance: createFinanceApi(supabase),
  smsCredits: createSmsCreditsApi(supabase)
};
