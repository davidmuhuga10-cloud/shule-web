/**
 * capabilities.mjs — grant/revoke the small, purpose-built capability model
 * added in Phase 2a (see staff_capabilities in migrations/0005_exam_workflow.sql).
 * Today the only capability wired to anything is 'publish_results' — the
 * final step of the exam-results publishing workflow (Subject Teacher ->
 * Class Teacher -> Supervisor -> Admin). This product has no separate
 * "Supervisor" login — that role in the chain is simply an admin, or any
 * teacher an admin has explicitly granted this capability to.
 */
import { ok, err } from './_util.mjs';

export const CAPABILITIES = ['publish_results'];
export const CAPABILITY_LABELS = { publish_results: 'Publish exam results' };

export function createCapabilitiesApi(supabase) {
  return {
    async listForStaff(staffId) {
      if (!staffId) return ok([]);
      const { data, error } = await supabase.from('staff_capabilities').select('*').eq('staff_id', staffId);
      if (error) return err(error.message);
      return ok((data || []).map((r) => r.capability));
    },

    async grant(staffId, capability) {
      if (!staffId) return err('Missing staff member.');
      if (CAPABILITIES.indexOf(capability) === -1) return err('Unknown capability.');
      const { data: existing } = await supabase.from('staff_capabilities').select('id')
        .eq('staff_id', staffId).eq('capability', capability).maybeSingle();
      if (existing) return ok(true);
      const { error } = await supabase.from('staff_capabilities').insert({ staff_id: staffId, capability });
      if (error) return err(error.message);
      return ok(true);
    },

    async revoke(staffId, capability) {
      if (!staffId) return err('Missing staff member.');
      const { error } = await supabase.from('staff_capabilities').delete().eq('staff_id', staffId).eq('capability', capability);
      if (error) return err(error.message);
      return ok(true);
    }
  };
}
