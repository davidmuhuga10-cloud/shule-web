/**
 * grading.mjs — Supabase equivalent of Grading.gs.
 * Configurable grading scales and their grade bands. One scale is flagged
 * default and is used for all grading.
 */
import { ok, err, gradeScore } from './_util.mjs';

/** The official 8-band CBC competency scale (Below/Approaching/Meeting/Exceeding
 *  Expectation, split 1/2). Offered as a loadable preset alongside a school's
 *  default letter-grade scale — schools pick whichever they report with via
 *  the existing "Make default" mechanism; loading this one never touches or
 *  removes the letter-grade scale. */
export const CBC_COMPETENCY_SCALE_NAME = 'CBC Competency Scale';
export const CBC_COMPETENCY_BANDS = [
  { min_score: 0, max_score: 12, grade_label: 'BE2', points: 1, remark: 'Below Expectation' },
  { min_score: 13, max_score: 24, grade_label: 'BE1', points: 2, remark: 'Below Expectation' },
  { min_score: 25, max_score: 36, grade_label: 'AE2', points: 3, remark: 'Approaching Expectation' },
  { min_score: 37, max_score: 49, grade_label: 'AE1', points: 4, remark: 'Approaching Expectation' },
  { min_score: 50, max_score: 60, grade_label: 'ME2', points: 5, remark: 'Meeting Expectation' },
  { min_score: 61, max_score: 72, grade_label: 'ME1', points: 6, remark: 'Meeting Expectation' },
  { min_score: 73, max_score: 84, grade_label: 'EE2', points: 7, remark: 'Exceeding Expectation' },
  { min_score: 85, max_score: 100, grade_label: 'EE1', points: 8, remark: 'Exceeding Expectation' }
];

export function createGradingApi(supabase) {
  const api = {
    // Perf fix: this used to fetch each scale's bands with its own round
    // trip, one scale at a time (a school with several scales meant that
    // many sequential waits just to open the Grading Scales page). All
    // bands for every scale are now fetched together in one query and
    // grouped client-side by grading_scale_id.
    async listScales() {
      const { data: scales, error } = await supabase.from('grading_scales').select('*');
      if (error) return err(error.message);
      const rows = scales || [];
      if (rows.length) {
        const { data: allBands } = await supabase.from('grade_ranges').select('*').in('grading_scale_id', rows.map((sc) => sc.id));
        const bandsByScale = {};
        (allBands || []).forEach((b) => { (bandsByScale[b.grading_scale_id] = bandsByScale[b.grading_scale_id] || []).push(b); });
        rows.forEach((sc) => {
          sc.bands = (bandsByScale[sc.id] || []).slice().sort((a, b) => Number(b.min_score) - Number(a.min_score));
        });
      }
      return ok(rows);
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

    /** (Re)load the CBC competency scale preset. Safe to click more than once —
     *  if the scale already exists this is a no-op rather than a duplicate. */
    async loadCbcCompetencyScale() {
      const { data: existing } = await supabase.from('grading_scales').select('id')
        .ilike('name', CBC_COMPETENCY_SCALE_NAME).maybeSingle();
      if (existing) return ok(null, { added: false });

      const { count } = await supabase.from('grading_scales').select('id', { count: 'exact', head: true });
      const { data: scale, error } = await supabase.from('grading_scales')
        .insert({
          name: CBC_COMPETENCY_SCALE_NAME,
          description: 'The 8-band CBC competency-based scale (Below/Approaching/Meeting/Exceeding Expectation).',
          is_default: (count || 0) === 0
        }).select().single();
      if (error) return err(error.message);

      const { error: bandErr } = await supabase.from('grade_ranges')
        .insert(CBC_COMPETENCY_BANDS.map((b) => ({ ...b, grading_scale_id: scale.id })));
      if (bandErr) return err(bandErr.message);
      return ok(null, { added: true });
    },

    /** The default scale's bands — used internally by results.mjs to grade a score. */
    async defaultScaleBands() {
      const { data: scale } = await supabase.from('grading_scales').select('id').eq('is_default', true).maybeSingle();
      if (!scale) return [];
      const { data: bands } = await supabase.from('grade_ranges').select('*').eq('grading_scale_id', scale.id);
      return bands || [];
    },

    /** A SPECIFIC scale's bands, by id — brief Step 10's "Overall Grading
     *  System" is chosen per (exam, class) at publish time (exam_classes.
     *  grading_scale_id), which may or may not be the school's single
     *  is_default scale defaultScaleBands() above always uses. Falls back to
     *  the default scale when scaleId is falsy, so callers can pass
     *  `exam_classes.grading_scale_id` straight through without a null check. */
    async scaleBands(scaleId) {
      if (!scaleId) return api.defaultScaleBands();
      const { data: bands } = await supabase.from('grade_ranges').select('*').eq('grading_scale_id', scaleId);
      return bands || [];
    },

    gradeScore
  };
  return api;
}
