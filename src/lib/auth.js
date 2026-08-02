/**
 * auth.js
 * ----------------------------------------------------------------------------
 * Session/login/logout, wrapping Supabase Auth. Staff sign in with their real
 * email; students sign in with their admission number, translated to a
 * synthetic internal address via window.ShuleStudentEmail (loaded separately,
 * see index.html) — the exact same rule the admin-provision Netlify function
 * uses to create the login in the first place.
 *
 * MULTI-TENANCY: one Supabase project now serves every school, so a School
 * Code (see resolveSchoolByCode()) is required up front — both to translate
 * a student's admission number into the right synthetic email (two schools
 * can each have a student "23") and, after sign-in, to double-check the
 * account that just logged in actually belongs to the school the person
 * typed (a defence-in-depth guard on top of RLS, not a replacement for it).
 * ----------------------------------------------------------------------------
 */
import { supabase } from './supabaseClient.js';

function studentEmailHelper() {
  if (!window.ShuleStudentEmail) {
    throw new Error('studentEmail.shared.js did not load — check the <script> tag in index.html.');
  }
  return window.ShuleStudentEmail;
}

export function studentEmailFor(admissionNo, schoolCode) {
  return studentEmailHelper().studentEmailFor(admissionNo, schoolCode);
}

/** Public, pre-auth lookup: does this School Code exist, and what's its name/logo/settings? */
export async function resolveSchoolByCode(code) {
  const trimmed = String(code || '').trim();
  if (!trimmed) return { ok: false, message: 'Enter your School Code.' };
  const { data, error } = await supabase.rpc('get_school_public_info', { p_code: trimmed });
  if (error) return { ok: false, message: error.message };
  if (!data || data.found !== true) return { ok: false, message: 'We could not find a school with that code.' };
  return { ok: true, school: data };
}

export async function loginStaff(email, password, schoolCode) {
  const { data, error } = await supabase.auth.signInWithPassword({ email: String(email || '').trim(), password });
  if (error) return { ok: false, message: friendlyAuthError(error) };
  const guard = await verifySchoolMatch(schoolCode);
  if (!guard.ok) { await supabase.auth.signOut(); return guard; }
  return { ok: true, session: data.session };
}

export async function loginStudent(admissionNo, password, schoolCode) {
  if (!String(schoolCode || '').trim()) return { ok: false, message: 'Enter your School Code.' };
  const email = studentEmailFor(admissionNo, schoolCode);
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) return { ok: false, message: friendlyAuthError(error) };
  const guard = await verifySchoolMatch(schoolCode);
  if (!guard.ok) { await supabase.auth.signOut(); return guard; }
  return { ok: true, session: data.session };
}

/** Defence-in-depth: confirm the just-authenticated profile really belongs to
 *  the School Code that was typed at the login screen. RLS already makes it
 *  impossible to see another school's data regardless — this only prevents
 *  the confusing UX of one person's account silently rendering under a
 *  different school's branding if they mistype/reuse an old bookmark. */
async function verifySchoolMatch(schoolCode) {
  if (!String(schoolCode || '').trim()) return { ok: true }; // not asked to check (e.g. tests)
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return { ok: false, message: 'Sign-in did not complete. Please try again.' };
  const { data: profile } = await supabase
    .from('profiles')
    .select('school_id, schools ( code )')
    .eq('id', session.user.id)
    .maybeSingle();
  const actualCode = profile && profile.schools ? profile.schools.code : null;
  if (actualCode && actualCode !== String(schoolCode).trim().toLowerCase()) {
    return { ok: false, message: 'That School Code does not match this account. Double-check it with your school admin.' };
  }
  return { ok: true };
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
    .select('id, name, email, role, staff_id, student_id, status, school_id, schools ( code, name )')
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
