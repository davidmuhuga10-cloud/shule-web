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
import { CBC_LEVELS, STANDARD_CLASS_LEVELS, CBC_SUBJECTS, levelBucketForClassName } from './cbcDefaults.mjs';
import { seedDefaultSubjectsForNewStream } from './assignments.mjs';
import { plainNameError } from '../validators.mjs';

// Re-exported for backward compatibility — these used to be defined here
// directly; existing imports (e.g. views/classes.mjs) keep working
// unchanged. See cbcDefaults.mjs for the canonical source and
// the reasoning for why this moved out (avoids a circular import with
// assignments.mjs, which also needs this data to seed a new stream's
// default subjects — Phase 2g / brief §4.2).
export { CBC_LEVELS, STANDARD_CLASS_LEVELS, CBC_SUBJECTS };

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
      // Perf fix: this used to fetch every class first, then loop over them
      // ONE AT A TIME awaiting a 2-query Promise.all per class — a school
      // with 10-15 classes meant 10-15 sequential network round trips just
      // to open the Classes & Streams page (a real contributor to slow page
      // loads, same root-cause shape as the dashboard's old waterfall — see
      // dashboard.mjs). Streams and students for EVERY class are now fetched
      // in the same single Promise.all as the classes themselves, and counts
      // are derived client-side — one round trip regardless of class count.
      async list() {
        const { data, error } = await supabase.from('classes').select('*');
        if (error) return err(error.message);
        const rows = (data || []).slice().sort((a, b) => {
          const ao = Number(a.level_order) || 0, bo = Number(b.level_order) || 0;
          if (ao !== bo) return ao - bo;
          return String(a.name).localeCompare(String(b.name));
        });
        if (!rows.length) return ok(rows);
        const classIds = rows.map((c) => c.id);
        const [{ data: streams }, { data: students }] = await Promise.all([
          supabase.from('streams').select('id, class_id').in('class_id', classIds),
          supabase.from('students').select('id, class_id').in('class_id', classIds)
        ]);
        const streamCountByClass = {};
        (streams || []).forEach((s) => { streamCountByClass[s.class_id] = (streamCountByClass[s.class_id] || 0) + 1; });
        const studentCountByClass = {};
        (students || []).forEach((s) => { studentCountByClass[s.class_id] = (studentCountByClass[s.class_id] || 0) + 1; });
        rows.forEach((c) => {
          c.stream_count = streamCountByClass[c.id] || 0;
          c.student_count = studentCountByClass[c.id] || 0;
        });
        return ok(rows);
      },
      /** payload.streams: optional array of stream names to ensure exist for this class.
       *  level_order is derived automatically when `name` matches one of
       *  STANDARD_CLASS_LEVELS (Daycare=1 ... Grade 9=12), so every school's
       *  classes sort identically without anyone having to set an order by
       *  hand. A class saved under a non-standard name (legacy data from
       *  before this list existed) keeps whatever level_order it already
       *  had, or the caller's explicit value, so nothing already in the
       *  database breaks. */
      async save(payload) {
        payload = payload || {};
        const name = String(payload.name || '').trim();
        if (!name) return err('Please choose a class.');
        const stdIndex = STANDARD_CLASS_LEVELS.findIndex((n) => n.toLowerCase() === name.toLowerCase());
        let level_order;
        if (stdIndex !== -1) {
          level_order = stdIndex + 1;
        } else if (payload.level_order !== undefined && payload.level_order !== null && payload.level_order !== '') {
          level_order = Number(payload.level_order) || 0;
        } else if (payload.id) {
          const { data: current } = await supabase.from('classes').select('level_order').eq('id', payload.id).maybeSingle();
          level_order = current ? current.level_order : 0;
        } else {
          level_order = 0;
        }
        const rec = {
          name, level_order, description: payload.description || '',
          class_teacher_staff_id: payload.class_teacher_staff_id || null
        };
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
            const { data: insertedStreams, error: streamErr } = await supabase.from('streams').insert(toInsert).select();
            if (!streamErr) {
              streamsAdded = toInsert.length;
              // Brief §4.2: a brand-new stream starts with the correct default
              // CBC subject set for its grade, instead of every subject in the
              // system — see seedDefaultSubjectsForNewStream in assignments.mjs.
              for (const s of insertedStreams || []) {
                await seedDefaultSubjectsForNewStream(supabase, s.id, saved.id, saved.name);
              }
            }
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
        // System Fixes brief §13 (site-wide performance under load): one
        // student-count round trip per stream, fired together instead of
        // awaited one at a time — every stream's count is independent.
        await Promise.all(rows.map(async (s) => {
          const { count } = await supabase.from('students').select('id', { count: 'exact', head: true }).eq('stream_id', s.id);
          s.student_count = count || 0;
        }));
        rows.sort((a, b) => a.class_name !== b.class_name
          ? String(a.class_name).localeCompare(String(b.class_name))
          : String(a.name).localeCompare(String(b.name)));
        return ok(rows);
      },
      async save(payload) {
        payload = payload || {};
        if (!payload.class_id) return err('Please choose the class this stream belongs to.');
        const name = String(payload.name || '').trim();
        // Round 2 brief §2 (BUG): "Blue,Red" was accepted as one stream
        // name — plain letters/digits/spaces only from here on, whether
        // this is a brand-new stream or a rename (§4) of an existing one.
        const nameError = plainNameError(name, 'Stream name');
        if (nameError) return err(name ? nameError : 'Stream name is required (e.g. "East", "North", "Blue").');
        const rec = { class_id: payload.class_id, name, description: payload.description || '' };
        // Same-name-in-this-class dup check applies to a rename too now
        // (excluding the row being renamed) — previously only checked on
        // create, so renaming stream B to collide with existing stream A
        // silently succeeded.
        let dupQuery = supabase.from('streams').select('id').eq('class_id', payload.class_id).eq('name', name);
        if (payload.id) dupQuery = dupQuery.neq('id', payload.id);
        const { data: dup } = await dupQuery.maybeSingle();
        if (dup) return err('That stream already exists for this class.');
        if (payload.id) {
          const { data, error } = await supabase.from('streams').update(rec).eq('id', payload.id).select().single();
          if (error) return err(error.message);
          return ok(data);
        }
        const { data, error } = await supabase.from('streams').insert(rec).select().single();
        if (error) return err(error.message);
        // Brief §4.2: seed the correct default CBC subjects for this stream's
        // grade level right away (best-effort — a lookup/insert hiccup here
        // shouldn't fail the stream creation itself; the admin can still add
        // subjects manually from the class's subject screen).
        const { data: cls } = await supabase.from('classes').select('name').eq('id', payload.class_id).maybeSingle();
        if (cls) await seedDefaultSubjectsForNewStream(supabase, data.id, payload.class_id, cls.name);
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
    },

    /** Paper 1 / Paper 2 (etc.) weighting per subject — see subject_papers
     *  in migrations/0005_exam_workflow.sql. A subject with zero rows here
     *  is "single-paper" and marks entry/broadsheets/report cards all work
     *  exactly as they always have. */
    subjectPapers: {
      async list(subjectId) {
        let q = supabase.from('subject_papers').select('*');
        if (subjectId) q = q.eq('subject_id', subjectId);
        const { data, error } = await q.order('paper_no', { ascending: true });
        if (error) return err(error.message);
        return ok(data || []);
      },
      async save(payload) {
        payload = payload || {};
        if (!payload.subject_id) return err('Please choose the subject this paper belongs to.');
        const name = String(payload.name || '').trim();
        if (!name) return err('Paper name is required (e.g. "Paper 1").');
        const rec = {
          subject_id: payload.subject_id,
          name,
          paper_no: Number(payload.paper_no) || 1,
          weight: payload.weight === '' || payload.weight === undefined || payload.weight === null ? 1 : Number(payload.weight),
          out_of: Number(payload.out_of) || 100
        };
        if (payload.id) {
          const { data, error } = await supabase.from('subject_papers').update(rec).eq('id', payload.id).select().single();
          if (error) return err(error.message);
          return ok(data);
        }
        const { data: dup } = await supabase.from('subject_papers').select('id')
          .eq('subject_id', payload.subject_id).eq('paper_no', rec.paper_no).maybeSingle();
        if (dup) return err(`Paper ${rec.paper_no} already exists for this subject.`);
        const { data, error } = await supabase.from('subject_papers').insert(rec).select().single();
        if (error) return err(error.message);
        return ok(data);
      },
      async remove(id) {
        const { error } = await supabase.from('subject_papers').delete().eq('id', id);
        if (error) return err(error.message);
        return ok(true);
      }
    }
  };
}
