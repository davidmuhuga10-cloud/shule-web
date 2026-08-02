/**
 * users.mjs — Supabase equivalent of Dashboard.gs's listUsers/resetUserPassword,
 * plus student/staff login provisioning.
 *
 * Reading the user list is a plain Supabase query (admin RLS already grants
 * admins full read on `profiles`). Anything that touches Supabase Auth itself
 * (creating a login, resetting a password, disabling one) requires the
 * service_role key, so those calls are delegated to the `admin-provision`
 * Netlify function via the injected `callAdminFunction(action, payload)` —
 * see netlify/functions/admin-provision.js for the contract. Injecting it
 * (rather than importing `fetch` directly) keeps this module unit-testable
 * without a live Netlify function.
 */
import { ok, err } from './_util.mjs';

export function createUsersApi(supabase, callAdminFunction) {
  return {
    async list() {
      const { data, error } = await supabase
        .from('profiles')
        .select('id, name, email, role, status, staff_id, student_id')
        .order('name', { ascending: true });
      if (error) return err(error.message);
      return ok(data || []);
    },

    async provisionStudentLogin({ student_id, admission_no, full_name }) {
      if (!student_id || !admission_no || !full_name) return err('Missing student details for login provisioning.');
      return callAdminFunction('create_student', { student_id, admission_no, full_name });
    },

    async provisionStaffLogin({ staff_id, email, full_name, role }) {
      if (!staff_id || !email || !full_name) return err('Missing staff details for login provisioning.');
      return callAdminFunction('create_staff', { staff_id, email, full_name, role });
    },

    async resetPassword(profileId, newPassword) {
      if (!profileId) return err('Missing profile.');
      return callAdminFunction('reset_password', { profile_id: profileId, new_password: newPassword });
    },

    async setLoginStatus(profileId, status) {
      if (!profileId || (status !== 'active' && status !== 'inactive')) return err('Missing profile or invalid status.');
      return callAdminFunction('set_login_status', { profile_id: profileId, status });
    }
  };
}
