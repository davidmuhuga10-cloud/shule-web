/**
 * academics.mjs
 * ----------------------------------------------------------------------------
 * Academic Years, Terms, Classes, Streams, Subjects (CBC-aware) — the direct
 * Supabase equivalent of the Apps Script Academics.gs. Every function takes
 * the shared Supabase client (RLS does the authorization that requireAuth_()
 * used to do server-side) and returns { ok, data|message }, same shape as
 * before, to keep view code familiar.
 * ----------------------------------------------------------------------------
 */
import { ok, err, fromResult } from './_util.mjs';

/** Official Kenyan CBC learning areas (KICD), per level, including the 2024
 *  Junior Secondary rationalisation to 9 core subjects — identical list to
 *  the Apps Script version's CBC_SUBJECTS. */
export const CBC_LEVELS = ['Pre-Primary', 'Lower Primary', 'Upper Primary', 'Junior Secondary'];
export const CBC_SUBJECTS = [
  { name: 'Language Activities', level: 'Pre-Primary' },
  { name: 'Mathematical Activities', level: 'Pre-Primary' },
  { name: 'Environmental Activities', level: 'Pre-Primary' },
  { name: 'Psychomotor and Creative Activities', level: 'Pre-Primary' },
  { name: 'Religious Education Activities', level: 'Pre-Primary' },
  { name: 'Literacy Activities', level: 'Lower Primary' },
  { name: 'English Language Activities', level: 'Lower Primary' },
  { name: 'Kiswahili Language Activities', level: 'Lower Primary' },
  { name: 'Indigenous Language Activities', level: 'Lower Primary' },
  { name: 'Mathematical Activities', level: 'Lower Primary' },
  { name: 'Environmental Activities', level: 'Lower Primary' },
  { name: 'Hygiene and Nutrition Activities', level: 'Lower Primary' },
  { name: 'Religious Education', level: 'Lower Primary' },
  { name: 'Movement and Creative Activities', level: 'Lower Primary' },
  { name: 'English', level: 'Upper Primary' },
  { name: 'Kiswahili', level: 'Upper Primary' },
  { name: 'Mathematics', level: 'Upper Primary' },
  { name: 'Science and Technology', level: 'Upper Primary' },
  { name: 'Social Studies', level: 'Upper Primary' },
  { name: 'Religious Education', level: 'Upper Primary' },
  { name: 'Agriculture', level: 'Upper Primary' },
  { name: 'Home Science', level: 'Upper Primary' },
  { name: 'Creative Arts', level: 'Upper Primary' },
  { name: 'Physical and Health Education', level: 'Upper Primary' },
  { name: 'English', level: 'Junior Secondary' },
  { name: 'Kiswahili', level: 'Junior Secondary' },
  { name: 'Mathematics', level: 'Junior Secondary' },
  { name: 'Integrated Science', level: 'Junior Secondary' },
  { name: 'Pre-Technical Studies', level: 'Junior Secondary' },
  { name: 'Social Studies', level: 'Junior Secondary' },
  { name: 'Agriculture', level: 'Junior Secondary' },
  { name: 'Religious Education', level: 'Junior Secondary' },
  { name: 'Creative Arts and Sports', level: 'Junior Secondary' }
];

export function createAcademicsApi(supabase) {
  return {
    academicYears: {
      async list() {
        const res = await supabase.from('academic_years').select('*').order('name', { ascending: false });
        return fromResult(res);
      },
      async save(payload) {
        const name = String((payload || {}).name || '').trim();
        if (!name) return err('Academic year name is required (e.g. "2026").');
        const rec = {
          name,
          start_date: payload.start_date || null,
          end_date: payload.end_date || null,
          status: payload.status || 'upcoming'
        };
        let saved;
        if (payload.id) {
          const { data, error } = await supabase.from('academic_years').update(rec).eq('id', payload.id).select().single();
          if (error) return err(error.message);
          saved = data;
        } else {
          const { data: dup } = await supabase.from('academic_years').select('id').eq('name', name).maybeSingle();
          if (dup) return err(`An academic year named "${name}" already exists.`);
          const { data, error } = await supabase.from('academic_years').insert(rec).select().single();
          if (error) return err(error.message);
          saved = data;
        }
        if (rec.status === 'active') {
          await supabase.from('academic_years').update({ status: 'archived' }).neq('id', saved.id).eq('status', 'active');
        }
        return ok(saved);
      },
      async remove(id) {
        const { count } = await supabase.from('terms').select('id', { count: 'exact', head: true }).eq('academic_year_id', id);
        if (count > 0) return err('This academic year has terms linked to it. Delete those terms first.');
        const { error } = await supabase.from('academic_years').delete().eq('id', id);
        if (error) return err(error.message);
        return ok(true);
      }
    },

    terms: {
      async list(academicYearId) {
        let q = supabase.from('terms').select('*, academic_years(name)');
        if (academicYearId) q = q.eq('academic_year_id', academicYearId);
        const { data, error } = await q.order('name', { ascending: true });
        if (error) return err(error.message);
        const rows = (data || []).map((t) => ({
          ...t,
          academic_year_name: t.academic_years ? t.academic_years.name : ''
        }));
        return ok(rows);
      },
      async save(payload) {
        payload = payload || {};
        if (!payload.academic_year_id) return err('Please choose an academic year first.');
        if (!payload.name) return err('Please choose the term (Term 1, 2 or 3).');
        const rec = {
          academic_year_id: payload.academic_year_id,
          name: payload.name,
          start_date: payload.start_date || null,
          end_date: payload.end_date || null,
          status: payload.status || 'upcoming'
        };
        let saved;
        if (payload.id) {
          const { data, error } = await supabase.from('terms').update(rec).eq('id', payload.id).select().single();
          if (error) return err(error.message);
          saved = data;
        } else {
          const { data: dup } = await supabase.from('terms')
            .select('id').eq('academic_year_id', payload.academic_year_id).eq('name', payload.name).maybeSingle();
          if (dup) return err(`${payload.name} already exists for that academic year.`);
          const { data, error } = await supabase.from('terms').insert(rec).select().single();
          if (error) return err(error.message);
          saved = data;
        }
        if (rec.status === 'active') {
          await supabase.from('terms').update({ status: 'archived' }).neq('id', saved.id).eq('status', 'active');
        }
        return ok(saved);
      },
      async remove(id) {
        const { error } = await supabase.from('terms').delete().eq('id', id);
        if (error) return err(error.message);
        return ok(true);
      }
    },

    classes: {
      async list() {
        const { data, error } = await supabase.from('classes').select('*');
        if (error) return err(error.message);
        const rows = (data || []).slice().sort((a, b) => {
          const ao = Number(a.level_order) || 0, bo = Number(b.level_order) || 0;
          if (ao !== bo) return ao - bo;
          return String(a.name).localeCompare(String(b.name));
        });
        for (const c of rows) {
          const [{ count: streamCount }, { count: studentCount }] = await Promise.all([
            supabase.from('streams').select('id', { count: 'exact', head: true }).eq('class_id', c.id),
            supabase.from('students').select('id', { count: 'exact', head: true }).eq('class_id', c.id)
          ]);
          c.stream_count = streamCount || 0;
          c.student_count = studentCount || 0;
        }
        return ok(rows);
      },
      /** payload.streams: optional array of stream names to ensure exist for this class. */
      async save(payload) {
        payload = payload || {};
        const name = String(payload.name || '').trim();
        if (!name) return err('Class name is required (e.g. "Form 1" or "Grade 7").');
        const rec = { name, level_order: payload.level_order || 0, description: payload.description || '' };
        let saved;
        if (payload.id) {
          const { data, error } = await supabase.from('classes').update(rec).eq('id', payload.id).select().single();
          if (error) return err(error.message);
          saved = data;
        } else {
          const { data: dup } = await supabase.from('classes').select('id').eq('name', name).maybeSingle();
          if (dup) return err('That class already exists.');
          const { data, error } = await supabase.from('classes').insert(rec).select().single();
          if (error) return err(error.message);
          saved = data;
        }

        let streamsAdded = 0;
        if (Array.isArray(payload.streams) && payload.streams.length) {
          const { data: existingStreams } = await supabase.from('streams').select('name').eq('class_id', saved.id);
          const have = (existingStreams || []).map((s) => String(s.name).toLowerCase());
          const toInsert = [];
          payload.streams.forEach((nm) => {
            nm = String(nm || '').trim();
            if (nm && have.indexOf(nm.toLowerCase()) === -1) {
              toInsert.push({ class_id: saved.id, name: nm });
              have.push(nm.toLowerCase());
            }
          });
          if (toInsert.length) {
            const { error: streamErr } = await supabase.from('streams').insert(toInsert);
            if (!streamErr) streamsAdded = toInsert.length;
          }
        }
        return ok(saved, { streamsAdded });
      },
      async remove(id) {
        const { count } = await supabase.from('students').select('id', { count: 'exact', head: true }).eq('class_id', id);
        if (count > 0) return err('Students are enrolled in this class. Move or remove them first.');
        // Streams cascade-delete automatically (ON DELETE CASCADE in schema.sql).
        const { error } = await supabase.from('classes').delete().eq('id', id);
        if (error) return err(error.message);
        return ok(true);
      }
    },

    streams: {
      async list(classId) {
        let q = supabase.from('streams').select('*, classes(name)');
        if (classId) q = q.eq('class_id', classId);
        const { data, error } = await q;
        if (error) return err(error.message);
        const rows = (data || []).map((s) => ({ ...s, class_name: s.classes ? s.classes.name : '' }));
        for (const s of rows) {
          const { count } = await supabase.from('students').select('id', { count: 'exact', head: true }).eq('stream_id', s.id);
          s.student_count = count || 0;
        }
        rows.sort((a, b) => a.class_name !== b.class_name
          ? String(a.class_name).localeCompare(String(b.class_name))
          : String(a.name).localeCompare(String(b.name)));
        return ok(rows);
      },
      async save(payload) {
        payload = payload || {};
        if (!payload.class_id) return err('Please choose the class this stream belongs to.');
        const name = String(payload.name || '').trim();
        if (!name) return err('Stream name is required (e.g. "East", "North", "Blue").');
        const rec = { class_id: payload.class_id, name, description: payload.description || '' };
        if (payload.id) {
          const { data, error } = await supabase.from('streams').update(rec).eq('id', payload.id).select().single();
          if (error) return err(error.message);
          return ok(data);
        }
        const { data: dup } = await supabase.from('streams').select('id').eq('class_id', payload.class_id).eq('name', name).maybeSingle();
        if (dup) return err('That stream already exists for this class.');
        const { data, error } = await supabase.from('streams').insert(rec).select().single();
        if (error) return err(error.message);
        return ok(data);
      },
      async remove(id) {
        const { count } = await supabase.from('students').select('id', { count: 'exact', head: true }).eq('stream_id', id);
        if (count > 0) return err('Students are assigned to this stream. Move them first.');
        const { error } = await supabase.from('streams').delete().eq('id', id);
        if (error) return err(error.message);
        return ok(true);
      }
    },

    subjects: {
      async list() {
        const { data, error } = await supabase.from('subjects').select('*');
        if (error) return err(error.message);
        const order = {};
        CBC_LEVELS.forEach((l, i) => { order[l] = i; });
        const rows = (data || []).slice().sort((a, b) => {
          const la = order[a.level] === undefined ? 99 : order[a.level];
          const lb = order[b.level] === undefined ? 99 : order[b.level];
          if (la !== lb) return la - lb;
          return String(a.name).localeCompare(String(b.name));
        });
        return ok(rows, { levels: CBC_LEVELS });
      },
      async save(payload) {
        payload = payload || {};
        const name = String(payload.name || '').trim();
        if (!name) return err('Subject name is required (e.g. "Mathematics").');
        const level = payload.level || null;
        const rec = { name, code: payload.code || '', level, description: payload.description || '' };
        if (payload.id) {
          const { data, error } = await supabase.from('subjects').update(rec).eq('id', payload.id).select().single();
          if (error) return err(error.message);
          return ok(data);
        }
        let dupQuery = supabase.from('subjects').select('id').ilike('name', name);
        dupQuery = level ? dupQuery.eq('level', level) : dupQuery.is('level', null);
        const { data: dup } = await dupQuery.maybeSingle();
        if (dup) return err('That subject already exists for this level.');
        const { data, error } = await supabase.from('subjects').insert(rec).select().single();
        if (error) return err(error.message);
        return ok(data);
      },
      async remove(id) {
        // subject_class_assignments / subject_teacher_assignments cascade-delete automatically.
        const { error } = await supabase.from('subjects').delete().eq('id', id);
        if (error) return err(error.message);
        return ok(true);
      },
      /** (Re)load the CBC master subject list. Returns the number newly added. */
      async loadCbc() {
        const { data, error } = await supabase
          .from('subjects')
          .upsert(CBC_SUBJECTS.map((s) => ({ ...s, code: '', description: '' })), {
            onConflict: 'name,level',
            ignoreDuplicates: true
          })
          .select();
        if (error) return err(error.message);
        return ok(null, { added: (data || []).length });
      }
    }
  };
}
