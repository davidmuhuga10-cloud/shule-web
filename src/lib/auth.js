/**
 * auth.js
 * ----------------------------------------------------------------------------
 * Session/login/logout, wrapping Supabase Auth. Staff sign in with their real
 * email; students sign in with their admission number, translated to a
 * synthetic internal address via window.ShuleStudentEmail (loaded separately,
 * see index.html) — the exact same rule the admin-provision Netlify function
 * uses to create the login in the first place.
 * ----------------------------------------------------------------------------
 */
import { supabase } from './supabaseClient.js';

function studentEmailHelper() {
  if (!window.ShuleStudentEmail) {
    throw new Error('studentEmail.shared.js did not load — check the <script> tag in index.html.');
  }
  return window.ShuleStudentEmail;
}

export function studentEmailFor(admissionNo) {
  return studentEmailHelper().studentEmailFor(admissionNo);
}

export async function loginStaff(email, password) {
  const { data, error } = await supabase.auth.signInWithPassword({ email: String(email || '').trim(), password });
  if (error) return { ok: false, message: friendlyAuthError(error) };
  return { ok: true, session: data.session };
}

export async function loginStudent(admissionNo, password) {
  const email = studentEmailFor(admissionNo);
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) return { ok: false, message: friendlyAuthError(error) };
  return { ok: true, session: data.session };
}

export async function logout() {
  await supabase.auth.signOut();
}

/** The signed-in user's app profile (role, linked staff/student id), or null. */
export async function getCurrentProfile() {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return null;
  const { data: profile, error } = await supabase
    .from('profiles')
    .select('id, name, email, role, staff_id, student_id, status')
    .eq('id', session.user.id)
    .maybeSingle();
  if (error || !profile) return null;
  if (profile.status !== 'active') return null;
  return profile;
}

export async function getAccessToken() {
  const { data: { session } } = await supabase.auth.getSession();
  return session ? session.access_token : null;
}

export async function changePassword(currentPassword, newPassword) {
  if (String(newPassword || '').length < 6) {
    return { ok: false, message: 'New password must be at least 6 characters.' };
  }
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return { ok: false, message: 'Not signed in.' };

  // Verify the current password by re-authenticating before allowing the change.
  const { error: verifyErr } = await supabase.auth.signInWithPassword({
    email: session.user.email, password: currentPassword
  });
  if (verifyErr) return { ok: false, message: 'Current password is incorrect.' };

  const { error: updateErr } = await supabase.auth.updateUser({ password: newPassword });
  if (updateErr) return { ok: false, message: updateErr.message };
  return { ok: true };
}

function friendlyAuthError(error) {
  const msg = String(error && error.message || error);
  if (/invalid login credentials/i.test(msg)) return 'Incorrect email/admission number or password.';
  return msg;
}
