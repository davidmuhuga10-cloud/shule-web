/**
 * settings.mjs — Supabase equivalent of Dashboard.gs's getSettings/saveSettings.
 * Key/value pairs: school_name, school_motto, po_box, phone, email, logo.
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

    async save(payload) {
      payload = payload || {};
      for (const key of Object.keys(payload)) {
        const { data: existing } = await supabase.from('settings').select('key').eq('key', key).maybeSingle();
        if (existing) {
          const { error } = await supabase.from('settings').update({ value: payload[key] }).eq('key', key);
          if (error) return err(error.message);
        } else {
          const { error } = await supabase.from('settings').insert({ key, value: payload[key] });
          if (error) return err(error.message);
        }
      }
      return ok(true);
    }
  };
}
