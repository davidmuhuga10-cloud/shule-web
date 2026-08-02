/**
 * grading.mjs — Supabase equivalent of Grading.gs.
 * Configurable grading scales and their grade bands. One scale is flagged
 * default and is used for all grading.
 */
import { ok, err, gradeScore } from './_util.mjs';

export function createGradingApi(supabase) {
  const api = {
    async listScales() {
      const { data: scales, error } = await supabase.from('grading_scales').select('*');
      if (error) return err(error.message);
      for (const sc of scales || []) {
        const { data: bands } = await supabase.from('grade_ranges').select('*').eq('grading_scale_id', sc.id);
        sc.bands = (bands || []).slice().sort((a, b) => Number(b.min_score) - Number(a.min_score));
      }
      return ok(scales || []);
    },

    async saveScale(payload) {
      payload = payload || {};
      const name = String(payload.name || '').trim();
      if (!name) return err('Scale name is required.');
      if (payload.id) {
        const { data, error } = await supabase.from('grading_scales')
          .update({ name, description: payload.description || '' }).eq('id', payload.id).select().single();
        if (error) return err(error.message);
        return ok(data);
      }
      const { count } = await supabase.from('grading_scales').select('id', { count: 'exact', head: true });
      const { data, error } = await supabase.from('grading_scales')
        .insert({ name, description: payload.description || '', is_default: (count || 0) === 0 }).select().single();
      if (error) return err(error.message);
      return ok(data);
    },

    async setDefaultScale(id) {
      const { data: scales } = await supabase.from('grading_scales').select('id');
      for (const sc of scales || []) {
        await supabase.from('grading_scales').update({ is_default: String(sc.id) === String(id) }).eq('id', sc.id);
      }
      return ok(true);
    },

    async deleteScale(id) {
      const { data: scale } = await supabase.from('grading_scales').select('*').eq('id', id).maybeSingle();
      if (scale && scale.is_default) {
        return err('You cannot delete the default scale. Make another scale default first.');
      }
      // grade_ranges cascade-delete automatically (ON DELETE CASCADE in schema.sql).
      const { error } = await supabase.from('grading_scales').delete().eq('id', id);
      if (error) return err(error.message);
      return ok(true);
    },

    async saveBand(payload) {
      payload = payload || {};
      if (!payload.grading_scale_id) return err('Missing grading scale.');
      const min = Number(payload.min_score), max = Number(payload.max_score);
      if (isNaN(min) || isNaN(max)) return err('Enter valid minimum and maximum scores.');
      if (min > max) return err('Minimum score cannot be greater than the maximum.');
      const label = String(payload.grade_label || '').trim();
      if (!label) return err('Grade label is required (e.g. "A").');

      const rec = {
        grading_scale_id: payload.grading_scale_id,
        min_score: min, max_score: max, grade_label: label,
        points: payload.points || null, remark: payload.remark || ''
      };
      if (payload.id) {
        const { data, error } = await supabase.from('grade_ranges').update(rec).eq('id', payload.id).select().single();
        if (error) return err(error.message);
        return ok(data);
      }
      const { data, error } = await supabase.from('grade_ranges').insert(rec).select().single();
      if (error) return err(error.message);
      return ok(data);
    },

    async deleteBand(id) {
      const { error } = await supabase.from('grade_ranges').delete().eq('id', id);
      if (error) return err(error.message);
      return ok(true);
    },

    /** The default scale's bands — used internally by results.mjs to grade a score. */
    async defaultScaleBands() {
      const { data: scale } = await supabase.from('grading_scales').select('id').eq('is_default', true).maybeSingle();
      if (!scale) return [];
      const { data: bands } = await supabase.from('grade_ranges').select('*').eq('grading_scale_id', scale.id);
      return bands || [];
    },

    gradeScore
  };
  return api;
}
