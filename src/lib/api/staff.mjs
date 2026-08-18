/**
 * staff.mjs — Supabase equivalent of Staff.gs.
 *
 * NOTE: this module only touches the `staff` table. Creating the actual
 * login (Supabase Auth account + linked `profiles` row) requires the
 * service_role key, so it does NOT happen here — the view code must call the
 * `admin-provision` Netlify function (action: 'create_staff') immediately
 * after a successful save(), same pattern as students. See
 * netlify/functions/README.md.
 */
import { ok, err, createMemoCache, clearAllCaches } from './_util.mjs';

export function createStaffApi(supabase) {
  // Same short-window in-memory memoization pattern as the rest of the app
  // (see _util.mjs's createMemoCache header comment for the app-wide
  // invalidation bus this shares) — Staff/Teachers is read on the
  // Dashboard, Attendance, Messaging, and every "assign a class teacher"
  // picker. Scoped per createStaffApi() CALL, not module-level — see the
  // same note in academics.mjs/students.mjs.
  const { cached } = createMemoCache(20000);
  function clearCache() { clearAllCaches(); }
  return {
    async list() {
      return cached('staff.list', null, async () => {
        const { data, error } = await supabase.from('staff').select('*').order('full_name', { ascending: true });
        if (error) return err(error.message);
        return ok(data || []);
      });
    },

    async get(id) {
      return cached('staff.get', id, async () => {
        const { data, error } = await supabase.from('staff').select('*').eq('id', id).maybeSingle();
        if (error) return err(error.message);
        if (!data) return err('Staff member not found.');
        return ok(data);
      });
    },

    async save(payload) {
      payload = payload || {};
      const fullName = String(payload.full_name || '').trim();
      const email = String(payload.email || '').trim().toLowerCase();
      if (!fullName) return err('Full name is required.');
      // Email is optional now — sign-in uses a username (first name) or
      // phone number instead, auto-assigned when the login is provisioned.
      // A real email is just an optional contact detail.

      if (email) {
        const { data: existing } = await supabase.from('staff').select('id').eq('email', email);
        const dup = (existing || []).find((r) => String(r.id) !== String(payload.id || ''));
        if (dup) return err(`A staff member with email "${email}" already exists.`);
      }

      const rec = {
        full_name: fullName,
        // Round 3 §5: store NULL (not '') when no email was given. The
        // `unique (school_id, email)` constraint treats every NULL as
        // distinct, so any number of email-less staff can coexist — but
        // multiple '' (empty string) rows collide with each other on that
        // same constraint, which is exactly what caused bulkCreate's false
        // "duplicate key" failures below.
        email: email || null,
        phone: payload.phone || '',
        role: payload.role || 'teacher',
        gender: payload.gender || null,
        qualifications: payload.qualifications || '',
        employment_start_date: payload.employment_start_date || null,
        status: payload.status || 'active',
        // Richer HR bio-data (Phase 2c) — all optional.
        date_of_birth: payload.date_of_birth || null,
        national_id: payload.national_id || '',
        tsc_number: payload.tsc_number || '',
        next_of_kin_name: payload.next_of_kin_name || '',
        next_of_kin_contact: payload.next_of_kin_contact || ''
      };
      if (payload.id) {
        const { data, error } = await supabase.from('staff').update(rec).eq('id', payload.id).select().single();
        if (error) return err(error.message);
        clearCache();
        return ok(data);
      }
      const { data, error } = await supabase.from('staff').insert(rec).select().single();
      if (error) return err(error.message);
      clearCache();
      return ok(data);
    },

    async remove(id) {
      const { error } = await supabase.from('staff').delete().eq('id', id);
      if (error) return err(error.message);
      clearCache();
      return ok(true);
    },

    /**
     * Bulk-create staff/teachers already validated + previewed client-side
     * (Round 2 §5 — "matching the bulk upload capability that already exists
     * for Students"). Same shape as students.bulkCreate: skip exact
     * duplicates (by email, when one is given — many rows will have none,
     * since email is optional here) rather than failing the whole batch.
     * rows: [{ full_name, phone, email, role, gender, qualifications, is_admin }]
     */
    async bulkCreate(payload) {
      payload = payload || {};
      const rows = Array.isArray(payload.rows) ? payload.rows : [];
      if (!rows.length) return err('No rows to import.');

      const { data: existing } = await supabase.from('staff').select('email');
      const existingSet = new Set((existing || []).map((r) => String(r.email || '').toLowerCase()).filter(Boolean));
      const seenInBatch = new Set();

      const skipped = [];
      // toInsert and isAdminFlags stay index-aligned with each other (NOT
      // with the original `rows` array, since invalid/duplicate rows are
      // skipped) so the is_admin flag can be re-attached to the right
      // created row after insert, below.
      const toInsert = [];
      const isAdminFlags = [];
      rows.forEach((row, idx) => {
        const line = idx + 1;
        const fullName = String(row.full_name || '').trim();
        const email = String(row.email || '').trim().toLowerCase();
        if (!fullName) {
          skipped.push({ line, full_name: fullName, reason: 'Missing full name.' });
          return;
        }
        if (email) {
          if (existingSet.has(email) || seenInBatch.has(email)) {
            skipped.push({ line, full_name: fullName, reason: 'Duplicate email address.' });
            return;
          }
          seenInBatch.add(email);
        }
        toInsert.push({
          full_name: fullName,
          // Round 3 §5 fix — see the matching comment in save() above: NULL,
          // never '', for a blank email, so any number of blank-email rows
          // in one batch can coexist without tripping the unique constraint.
          email: email || null,
          phone: row.phone || '',
          role: row.role || 'Teacher',
          gender: row.gender || null,
          qualifications: row.qualifications || '',
          employment_start_date: row.employment_start_date || null,
          status: 'active'
        });
        isAdminFlags.push(!!row.is_admin);
      });

      let created = 0;
      let createdRows = [];
      if (toInsert.length) {
        const { data, error } = await supabase.from('staff').insert(toInsert).select();
        if (error) return err('Import failed: ' + error.message);
        created = toInsert.length;
        // createdRows lets the caller provision a login for each new staff
        // member (with the right admin/teacher role) without a second
        // round-trip — mirrors students.bulkCreate's createdRows.
        createdRows = (data || []).map((r, i) => ({ ...r, is_admin: isAdminFlags[i] }));
        clearCache();
      }
      return ok(null, { created, createdRows, skipped, total: rows.length });
    }
  };
}
