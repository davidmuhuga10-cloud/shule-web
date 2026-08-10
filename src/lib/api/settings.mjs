/**
 * settings.mjs — Supabase equivalent of Dashboard.gs's getSettings/saveSettings.
 * Key/value pairs: school_name, school_motto, po_box, phone, email, logo,
 * show_pathway_summary ('true'/'false' — Permissions toggle (moved out of
 * School Settings per Round 4 §6; see permissionsSettings.mjs) gating the
 * Report Form's STEM/Social Sciences/Arts & Sport Science cluster row, off
 * by default; see _reportCard.mjs's clusterSummaryHtml()).
 */
import { ok, err, titleCase } from './_util.mjs';

export function createSettingsApi(supabase) {
  return {
    async get() {
      const { data, error } = await supabase.from('settings').select('*');
      if (error) return err(error.message);
      const map = {};
      (data || []).forEach((r) => { map[r.key] = r.value; });
      // Brief: "Capitalize school name to always even when entered in small
      // letter" — normalized here (read time, not save time) so it's
      // corrected everywhere the name is shown, including names that were
      // already saved in lowercase before this existed.
      if (map.school_name) map.school_name = titleCase(map.school_name);
      return ok(map);
    },

    // System Fixes brief §12/§13 (performance): this used to be one SELECT
    // then one UPDATE-or-INSERT PER KEY, all sequential — School Settings
    // alone saves ~8 keys (school_name/motto/po_box/postal_code/town/phone/
    // email/logo), and Report Forms separately saves school_closed_on/
    // next_term_begins_on (Round 3 §4 — moved out of Settings) through this
    // same save(), so a single click could still be many round trips back
    // to back. That's very likely the real cause behind brief §2's "no
    // feedback... users click repeatedly" complaint — withBusy() (app.js)
    // fixes the missing feedback, this fixes the slow save that provoked it
    // in the first place. One query to see which keys already exist, then
    // every insert/update fired together instead of one at a time.
    async save(payload) {
      payload = payload || {};
      const keys = Object.keys(payload);
      if (!keys.length) return ok(true);
      const { data: existingRows, error: readError } = await supabase.from('settings').select('key').in('key', keys);
      if (readError) return err(readError.message);
      const existingKeys = new Set((existingRows || []).map((r) => r.key));
      const writes = keys.map((key) => existingKeys.has(key)
        ? supabase.from('settings').update({ value: payload[key] }).eq('key', key)
        : supabase.from('settings').insert({ key, value: payload[key] }));
      const results = await Promise.all(writes);
      const failed = results.find((r) => r.error);
      if (failed) return err(failed.error.message);
      return ok(true);
    }
  };
}
