/**
 * parents.mjs — Parent Portal data access: admin-side account provisioning +
 * linking, parent-side "my children" read.
 *
 * The reverse relationship this module walks (profiles [parent] -> parent_links
 * -> students) is deliberately built as an explicit two-query merge in JS,
 * the same convention students.mjs's withNames() uses for classes/streams,
 * rather than a Supabase nested-embed select — that embed syntax depends on
 * PostgREST's auto-detected foreign-key relationships, which can't be
 * verified without a live project to query against, so an explicit merge is
 * the safer choice here.
 *
 * Creating the parent's login itself needs the service_role key (Supabase
 * Auth), so that step is delegated to the admin-provision Netlify function
 * via the injected callAdminFunction — see netlify/functions/admin-provision.js
 * (action: create_parent). Linking a parent to a student does NOT need the
 * service role: RLS's parent_links_admin_write policy already lets a signed-in
 * admin insert directly, so that goes straight through the plain client.
 */
import { ok, err, byAdmissionNo, indexById, createMemoCache, clearAllCaches } from './_util.mjs';

export function createParentsApi(supabase, callAdminFunction) {
  // Same short-window in-memory memoization pattern as the rest of the app
  // (see _util.mjs's createMemoCache header comment for the app-wide
  // invalidation bus this shares). Scoped per createParentsApi() CALL, not
  // module-level — see the same note in academics.mjs/students.mjs.
  const { cached } = createMemoCache(20000);
  function clearCache() { clearAllCaches(); }
  return {
    // ---- Admin ----

    /** All parent accounts (profiles with role='parent') in this school. */
    async list() {
      return cached('parents.list', null, async () => {
        const { data, error } = await supabase
          .from('profiles')
          .select('id, name, email, status, created_at')
          .eq('role', 'parent')
          .order('name', { ascending: true });
        if (error) return err(error.message);
        return ok(data || []);
      });
    },

    /** Every parent<->student link in this school, with parent + student
     *  names attached, for the admin's "Parent Accounts" management view. */
    async links() {
      return cached('parents.links', null, async () => {
      const { data: rows, error } = await supabase
        .from('parent_links')
        .select('id, parent_profile_id, student_id, relationship, created_at')
        .order('created_at', { ascending: false });
      if (error) return err(error.message);
      if (!rows || !rows.length) return ok([]);

      const parentIds = [...new Set(rows.map((r) => r.parent_profile_id))];
      const studentIds = [...new Set(rows.map((r) => r.student_id))];
      const [{ data: parents }, { data: students }] = await Promise.all([
        supabase.from('profiles').select('id, name, email').in('id', parentIds),
        supabase.from('students').select('id, full_name, admission_no').in('id', studentIds)
      ]);
      const parentMap = indexById(parents || []);
      const studentMap = indexById(students || []);

      return ok(rows.map((r) => ({
        ...r,
        parent_name: parentMap[r.parent_profile_id] ? parentMap[r.parent_profile_id].name : '(unknown)',
        parent_email: parentMap[r.parent_profile_id] ? parentMap[r.parent_profile_id].email : '',
        student_name: studentMap[r.student_id] ? studentMap[r.student_id].full_name : '(unknown)',
        admission_no: studentMap[r.student_id] ? studentMap[r.student_id].admission_no : ''
      })));
      });
    },

    /** Create a parent's login. payload: { full_name, phone, student_id } —
     *  a child must be chosen up front now, since the parent's password is
     *  that child's admission number (not a generic default password). */
    async provision({ full_name, phone, student_id }) {
      if (!full_name || !phone || !student_id) return err('Parent name, phone number, and a child to link are required.');
      const res = await callAdminFunction('create_parent', { full_name, phone, student_id });
      if (res && res.ok) clearCache();
      return res;
    },

    /** Link an already-provisioned parent account to one of their children.
     *  payload: { parent_profile_id, student_id, relationship? } */
    async linkStudent({ parent_profile_id, student_id, relationship }) {
      if (!parent_profile_id || !student_id) return err('Choose both a parent and a student.');
      const { data, error } = await supabase
        .from('parent_links')
        .insert({ parent_profile_id, student_id, relationship: relationship || null })
        .select()
        .single();
      if (error) {
        if (String(error.message || '').toLowerCase().includes('duplicate')) {
          return err('This parent is already linked to this student.');
        }
        return err(error.message);
      }
      clearCache();
      return ok(data);
    },

    async unlink(linkId) {
      if (!linkId) return err('Missing link.');
      const { error } = await supabase.from('parent_links').delete().eq('id', linkId);
      if (error) return err(error.message);
      clearCache();
      return ok(true);
    },

    // ---- Parent (signed in as the parent themselves) ----

    /** The signed-in parent's own children — RLS (parent_links_self_read)
     *  already limits the parent_links row this returns to their own. */
    async myChildren() {
      // Cached like classes.list()/streams.list() in academics.mjs, which
      // read the students table the same way — safe because ANY write to
      // students (via students.mjs) calls clearAllCaches(), which clears
      // this too. See _util.mjs's createMemoCache header comment.
      return cached('parents.myChildren', null, async () => {
        const { data: links, error } = await supabase.from('parent_links').select('student_id, relationship');
        if (error) return err(error.message);
        const studentIds = [...new Set((links || []).map((l) => l.student_id))];
        if (!studentIds.length) return ok([]);

        const { data: students, error: sErr } = await supabase
          .from('students')
          .select('id, admission_no, full_name, class_id, stream_id, guardian_name, guardian_contact')
          .in('id', studentIds);
        if (sErr) return err(sErr.message);

        const relMap = {}; (links || []).forEach((l) => { relMap[l.student_id] = l.relationship || ''; });

        const classIds = [...new Set((students || []).map((s) => s.class_id).filter(Boolean))];
        const { data: classes } = classIds.length
          ? await supabase.from('classes').select('id, name').in('id', classIds)
          : { data: [] };
        const classMap = {}; (classes || []).forEach((c) => { classMap[c.id] = c.name; });

        const rows = (students || []).map((s) => ({
          ...s, relationship: relMap[s.id] || '', class_name: classMap[s.class_id] || ''
        }));
        rows.sort(byAdmissionNo);
        return ok(rows);
      });
    }
  };
}
