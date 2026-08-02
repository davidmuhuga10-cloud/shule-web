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
import { ok, err } from './_util.mjs';

export function createStaffApi(supabase) {
  return {
    async list() {
      const { data, error } = await supabase.from('staff').select('*').order('full_name', { ascending: true });
      if (error) return err(error.message);
      return ok(data || []);
    },

    async get(id) {
      const { data, error } = await supabase.from('staff').select('*').eq('id', id).maybeSingle();
      if (error) return err(error.message);
      if (!data) return err('Staff member not found.');
      return ok(data);
    },

    async save(payload) {
      payload = payload || {};
      const fullName = String(payload.full_name || '').trim();
      const email = String(payload.email || '').trim().toLowerCase();
      if (!fullName) return err('Full name is required.');
      if (!email) return err('Email is required (used to sign in).');

      const { data: existing } = await supabase.from('staff').select('id').eq('email', email);
      const dup = (existing || []).find((r) => String(r.id) !== String(payload.id || ''));
      if (dup) return err(`A staff member with email "${email}" already exists.`);

      const rec = {
        full_name: fullName,
        email,
        phone: payload.phone || '',
        role: payload.role || 'teacher',
        gender: payload.gender || null,
        qualifications: payload.qualifications || '',
        employment_start_date: payload.employment_start_date || null,
        status: payload.status || 'active'
      };
      if (payload.id) {
        const { data, error } = await supabase.from('staff').update(rec).eq('id', payload.id).select().single();
        if (error) return err(error.message);
        return ok(data);
      }
      const { data, error } = await supabase.from('staff').insert(rec).select().single();
      if (error) return err(error.message);
      return ok(data);
    },

    async remove(id) {
      const { error } = await supabase.from('staff').delete().eq('id', id);
      if (error) return err(error.message);
      return ok(true);
    }
  };
}
