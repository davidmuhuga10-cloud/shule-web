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
        .select('id, name, email, username, phone, role, status, staff_id, student_id')
        .order('name', { ascending: true });
      if (error) return err(error.message);
      return ok(data || []);
    },

    async provisionStudentLogin({ student_id, admission_no, full_name }) {
      if (!student_id || !admission_no || !full_name) return err('Missing student details for login provisioning.');
      return callAdminFunction('create_student', { student_id, admission_no, full_name });
    },

    /** Provisions a whole batch of student logins in ONE Netlify function
     *  call (bulk-upload's follow-up step) instead of one round trip per
     *  student — see admin-provision.js's createStudentsBulk for why. Caller
     *  is expected to chunk `rows` itself if it wants incremental progress
     *  feedback between chunks (see bulkUpload.mjs). */
    async provisionStudentLogins(rows) {
      if (!Array.isArray(rows) || !rows.length) return err('No students to provision.');
      return callAdminFunction('create_students_bulk', { rows });
    },

    async provisionStaffLogin({ staff_id, full_name, role, phone }) {
      if (!staff_id || !full_name) return err('Missing staff details for login provisioning.');
      return callAdminFunction('create_staff', { staff_id, full_name, role, phone });
    },

    /** Bulk equivalent of provisionStaffLogin — one Netlify function call
     *  provisions a whole batch (Teachers & Staff bulk upload's follow-up
     *  step), same pattern as provisionStudentLogins. Caller chunks `rows`
     *  itself for incremental progress feedback (see staffBulkUpload.mjs). */
    async provisionStaffLogins(rows) {
      if (!Array.isArray(rows) || !rows.length) return err('No staff to provision.');
      return callAdminFunction('create_staff_bulk', { rows });
    },

    async resetPassword(profileId, newPassword) {
      if (!profileId) return err('Missing profile.');
      return callAdminFunction('reset_password', { profile_id: profileId, new_password: newPassword });
    },

    async setLoginStatus(profileId, status) {
      if (!profileId || (status !== 'active' && status !== 'inactive')) return err('Missing profile or invalid status.');
      return callAdminFunction('set_login_status', { profile_id: profileId, status });
    },

    /** Grant or revoke admin (full) access for an existing staff login —
     *  feature brief "User accounts... one can add or revoke admin rights
     *  here". This is a plain `profiles` row update (not a Netlify/service-role
     *  call): `profiles_admin_update` RLS already lets an admin update any
     *  profile in their own school, and role is just a column, not something
     *  requiring Supabase Auth admin access. Guards against ever revoking the
     *  LAST admin in a school — that would lock every admin out for good with
     *  no one left who could re-grant it. */
    async setRole(profileId, role) {
      if (!profileId || (role !== 'admin' && role !== 'teacher')) return err('Missing profile or invalid role.');
      if (role === 'teacher') {
        const { count, error: countErr } = await supabase.from('profiles').select('id', { count: 'exact', head: true }).eq('role', 'admin');
        if (countErr) return err(countErr.message);
        if ((count || 0) <= 1) return err('You cannot revoke the last remaining admin — grant another admin first.');
      }
      const { error } = await supabase.from('profiles').update({ role }).eq('id', profileId);
      if (error) return err(error.message);
      return ok(true);
    }
  };
}
