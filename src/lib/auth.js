/**
 * auth.js
 * ----------------------------------------------------------------------------
 * Session/login/logout, wrapping Supabase Auth. Students sign in with their
 * admission number, translated to a synthetic internal address via
 * window.ShuleStudentEmail (loaded separately, see index.html) — the exact
 * same rule the admin-provision Netlify function uses to create the login in
 * the first place. Admins/teachers sign in with a username (their first
 * name) or their phone number; parents sign in with their phone number —
 * both also folded into a synthetic address, but since the actual address is
 * server-assigned (not directly derivable from what the person types, unlike
 * a student's admission number), staff logins are resolved via the
 * resolve_staff_login_email RPC rather than a pure client-side formula.
 *
 * MULTI-TENANCY: one Supabase project now serves every school, so a School
 * Code is required up front — both to translate an identifier into the right
 * synthetic email/RPC lookup (two schools can each have a student "23", or a
 * teacher named "Mercy") and, after sign-in, to double-check the account
 * that just logged in actually belongs to the school the person typed (a
 * defence-in-depth guard on top of RLS, not a replacement for it).
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

export function parentEmailFor(phone, schoolCode) {
  return studentEmailHelper().parentEmailFor(phone, schoolCode);
}

/** Splits a combined "identifier@schoolcode" login field — see
 *  studentEmail.shared.js's splitLoginUsername() for the full reasoning. */
export function splitLoginUsername(combined) {
  return studentEmailHelper().splitLoginUsername(combined);
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

/**
 * Smart login (landing redesign brief B1): given ONLY a phone number, find
 * every active admin/teacher/parent account it belongs to, across every
 * school — no School Code required up front. See find_login_accounts_by_phone
 * in schema.sql for exactly what this does and doesn't expose (never a
 * password, just enough to build a picker and then sign in normally).
 * Returns `accounts: [{school_code, school_name, role, display_name}, ...]`.
 */
export async function findLoginAccountsByPhone(phone) {
  const trimmed = String(phone || '').trim();
  if (!trimmed) return { ok: false, message: 'Enter your phone number.' };
  const { data, error } = await supabase.rpc('find_login_accounts_by_phone', { p_phone: trimmed });
  if (error) return { ok: false, message: error.message };
  return { ok: true, accounts: data || [] };
}

/**
 * identifier is a username ("mercy") OR a phone number ("0712345678") — the
 * caller doesn't need to know which, since both are resolved the same way.
 * Unlike students/parents, the actual Supabase Auth email can't be derived
 * client-side (it's a server-assigned username, not necessarily what was
 * just typed), so it has to be looked up via the resolve_staff_login_email
 * RPC first — see schema.sql for why that's still anonymous-safe.
 */
export async function loginStaff(identifier, password, schoolCode) {
  if (!String(schoolCode || '').trim()) return { ok: false, message: 'Enter your School Code.' };
  const trimmedId = String(identifier || '').trim();
  if (!trimmedId) return { ok: false, message: 'Enter your username or phone number.' };

  const { data: email, error: resolveErr } = await supabase.rpc('resolve_staff_login_email', {
    p_school_code: schoolCode, p_identifier: trimmedId
  });
  if (resolveErr || !email) return { ok: false, message: 'Incorrect username/phone or password.' };

  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) return { ok: false, message: friendlyAuthError(error) };
  if (!isGenuineSession(data, email)) { await supabase.auth.signOut(); return { ok: false, message: 'Incorrect username/phone or password.' }; }
  const guard = await verifySchoolMatch(schoolCode);
  if (!guard.ok) { await supabase.auth.signOut(); return guard; }
  return { ok: true, session: data.session };
}

/** Used right after self-serve school signup, where the frontend already
 *  knows the freshly-created username directly from the signup response —
 *  no need to round-trip through the RPC lookup for an account that was
 *  just created a second ago. */
export async function loginStaffByUsername(username, password, schoolCode) {
  const email = staffEmailFor(username, schoolCode);
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) return { ok: false, message: friendlyAuthError(error) };
  if (!isGenuineSession(data, email)) { await supabase.auth.signOut(); return { ok: false, message: 'Incorrect username/phone or password.' }; }
  const guard = await verifySchoolMatch(schoolCode);
  if (!guard.ok) { await supabase.auth.signOut(); return guard; }
  return { ok: true, session: data.session };
}

function staffEmailFor(username, schoolCode) {
  return studentEmailHelper().staffEmailFor(username, schoolCode);
}

export async function loginStudent(admissionNo, password, schoolCode) {
  if (!String(schoolCode || '').trim()) return { ok: false, message: 'Enter your School Code.' };
  const email = studentEmailFor(admissionNo, schoolCode);
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) return { ok: false, message: friendlyAuthError(error) };
  if (!isGenuineSession(data, email)) { await supabase.auth.signOut(); return { ok: false, message: 'Incorrect admission number or password.' }; }
  const guard = await verifySchoolMatch(schoolCode);
  if (!guard.ok) { await supabase.auth.signOut(); return guard; }
  return { ok: true, session: data.session };
}

/** Parents sign in with the phone number their school registered them with —
 *  same synthetic-address pattern as loginStudent, folding in the School
 *  Code so the same phone number at two different schools doesn't collide. */
export async function loginParent(phone, password, schoolCode) {
  if (!String(schoolCode || '').trim()) return { ok: false, message: 'Enter your School Code.' };
  const email = parentEmailFor(phone, schoolCode);
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) return { ok: false, message: friendlyAuthError(error) };
  if (!isGenuineSession(data, email)) { await supabase.auth.signOut(); return { ok: false, message: 'Incorrect phone number or password.' }; }
  const guard = await verifySchoolMatch(schoolCode);
  if (!guard.ok) { await supabase.auth.signOut(); return guard; }
  return { ok: true, session: data.session };
}

/**
 * Belt-and-braces guard on top of Supabase's own password check (Next Sprint
 * 2 §5 — "as long as the phone number entered is correct, any password is
 * accepted"). Reading the vendored supabase-js client confirms
 * signInWithPassword() really does POST to Supabase's own
 * /token?grant_type=password endpoint and only returns a session when THAT
 * call succeeds — the real password check happens server-side, not
 * something this app's code can silently skip. Since that couldn't be
 * reproduced from the code alone, this closes every edge case this app COULD
 * control instead of guessing: reject a "success" response that isn't
 * actually backed by a real session/token, and reject a session whose
 * authenticated email doesn't exactly match the email we asked to sign in
 * as. Either would previously have been treated as a successful login.
 */
function isGenuineSession(data, expectedEmail) {
  if (!data || !data.session || !data.session.access_token || !data.user) return false;
  if (expectedEmail && String(data.user.email || '').toLowerCase() !== String(expectedEmail).toLowerCase()) return false;
  return true;
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
