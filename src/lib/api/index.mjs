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

const academics = createAcademicsApi(supabase);
const grading = createGradingApi(supabase);

export const Db = {
  academicYears: academics.academicYears,
  terms: academics.terms,
  classes: academics.classes,
  streams: academics.streams,
  subjects: academics.subjects,
  students: createStudentsApi(supabase),
  staff: createStaffApi(supabase),
  assignments: createAssignmentsApi(supabase),
  grading,
  results: createResultsApi(supabase, grading),
  dashboard: createDashboardApi(supabase),
  settings: createSettingsApi(supabase),
  users: createUsersApi(supabase, callAdminFunction)
};
