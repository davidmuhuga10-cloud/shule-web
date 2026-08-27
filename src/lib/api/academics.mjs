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
import { ok, err, fromResult, createMemoCache, clearAllCaches } from './_util.mjs';
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
  // Same short-window in-memory memoization pattern as finance.mjs/
  // students.mjs (see _util.mjs's createMemoCache header comment for the
  // app-wide invalidation bus this shares) — Academic Years/Terms/Classes/
  // Streams/Subjects are read on nearly every screen in the app (every
  // filter dropdown, every "choose a class" picker), so this is one of the
  // highest-traffic caching wins available. clearCache() below clears every
  // OTHER cached module too — deliberate, since e.g. classes.list()/
  // streams.list() read student counts from the students table, which only
  // students.mjs writes to.
  //
  // Scoped per createAcademicsApi() CALL (not module-level) — production
  // only ever calls this once (see index.mjs), so behaviour is identical,
  // but it also means each test's fresh mock client gets its own cache
  // instead of accidentally sharing one across every test in the file.
  const { cached } = createMemoCache(20000);
  function clearCache() { clearAllCaches(); }
  return {
    academicYears: {
      async list() {
        return cached('academicYears.list', null, async () => {
          const res = await supabase.from('academic_years').select('*').order('name', { ascending: false });
          return fromResult(res);
        });
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
        clearCache();
        return ok(saved);
      },
      async remove(id) {
        const { count } = await supabase.from('terms').select('id', { count: 'exact', head: true }).eq('academic_year_id', id);
        if (count > 0) return err('This academic year has terms linked to it. Delete those terms first.');
        const { error } = await supabase.from('academic_years').delete().eq('id', id);
        if (error) return err(error.message);
        clearCache();
        return ok(true);
      }
    },

    terms: {
      async list(academicYearId) {
        return cached('terms.list', academicYearId, async () => {
          let q = supabase.from('terms').select('*, academic_years(name)');
          if (academicYearId) q = q.eq('academic_year_id', academicYearId);
          const { data, error } = await q.order('name', { ascending: true });
          if (error) return err(error.message);
          const rows = (data || []).map((t) => ({
            ...t,
            academic_year_name: t.academic_years ? t.academic_years.name : ''
          }));
          return ok(rows);
        });
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
        clearCache();
        return ok(saved);
      },
      async remove(id) {
        const { error } = await supabase.from('terms').delete().eq('id', id);
        if (error) return err(error.message);
        clearCache();
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
        return cached('classes.list', null, async () => {
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
        });
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
        // Round 3 §17: "no class should ever be allowed to exist without at
        // least one stream (arm)... this removes the zero-stream state from
        // the system entirely, rather than needing to handle it as an edge
        // case." Checked BEFORE the class row itself is inserted (not
        // after-the-fact cleanup), and only for a brand-new class — an
        // existing class always already has at least one stream once this
        // rule has been in force since its creation (see migration
        // 0016_require_class_stream.sql for classes that predate it).
        const pendingStreamNames = Array.isArray(payload.streams)
          ? [...new Set(payload.streams.map((nm) => String(nm || '').trim()).filter(Boolean).map((nm) => nm))]
          : [];
        if (!payload.id && !pendingStreamNames.length) {
          return err('Add at least one arm for this class — e.g. "Main" if it only has one group.');
        }

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
            } else if (!payload.id) {
              // Round 3 §17: for a brand-new class the required stream(s)
              // failing to insert would otherwise leave exactly the
              // zero-stream state this fix exists to prevent, silently
              // (the class row itself already succeeded above) — surfaced
              // as a real failure instead of a quiet no-op so the admin
              // knows to retry rather than assuming the class is ready.
              return err(`Class was created, but its arm(s) could not be added: ${streamErr.message}. Add one from the class page before using it.`);
            }
          }
        }
        clearCache();
        return ok(saved, { streamsAdded });
      },
      /** Next Sprint 2 §2: "Bulk Add Classes — tick boxes to pick several
       *  classes at once, type streams for each, support multiple streams
       *  per class." Deliberately just a loop over the same save() above
       *  (not a separate insert path) — so bulk-added classes go through
       *  every rule single-add already enforces (level_order, at-least-one-
       *  stream, default CBC subjects per new stream) with zero risk of the
       *  two paths drifting apart. items: [{ name, streams: [...] }]. A
       *  failure on one class (e.g. a duplicate name) doesn't stop the
       *  rest — every result is reported back so the caller can show a
       *  clear "N of M added, these failed" summary. */
      async bulkSave(items) {
        items = Array.isArray(items) ? items : [];
        if (!items.length) return err('Choose at least one class to add.');
        const results = [];
        for (const item of items) {
          const name = String((item && item.name) || '').trim();
          const streams = Array.isArray(item && item.streams) ? item.streams : [];
          if (!name) { results.push({ name: '', ok: false, message: 'Missing class name.' }); continue; }
          const res = await this.save({ name, streams });
          results.push({ name, ok: res.ok, message: res.ok ? '' : res.message });
        }
        const created = results.filter((r) => r.ok).length;
        const failed = results.filter((r) => !r.ok);
        return ok(null, { created, total: items.length, failed });
      },
      async remove(id) {
        const { count } = await supabase.from('students').select('id', { count: 'exact', head: true }).eq('class_id', id);
        if (count > 0) return err('Students are enrolled in this class. Move or remove them first.');
        // Streams cascade-delete automatically (ON DELETE CASCADE in schema.sql).
        const { error } = await supabase.from('classes').delete().eq('id', id);
        if (error) return err(error.message);
        clearCache();
        return ok(true);
      }
    },

    streams: {
      async list(classId) {
        return cached('streams.list', classId, async () => {
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
        });
      },
      async save(payload) {
        payload = payload || {};
        if (!payload.class_id) return err('Please choose the class this arm belongs to.');
        const name = String(payload.name || '').trim();
        // Round 2 brief §2 (BUG): "Blue,Red" was accepted as one stream
        // name — plain letters/digits/spaces only from here on, whether
        // this is a brand-new stream or a rename (§4) of an existing one.
        const nameError = plainNameError(name, 'Arm name');
        if (nameError) return err(name ? nameError : 'Arm name is required (e.g. "East", "North", "Blue").');
        const rec = { class_id: payload.class_id, name, description: payload.description || '' };
        // Same-name-in-this-class dup check applies to a rename too now
        // (excluding the row being renamed) — previously only checked on
        // create, so renaming stream B to collide with existing stream A
        // silently succeeded.
        let dupQuery = supabase.from('streams').select('id').eq('class_id', payload.class_id).eq('name', name);
        if (payload.id) dupQuery = dupQuery.neq('id', payload.id);
        const { data: dup } = await dupQuery.maybeSingle();
        if (dup) return err('That arm already exists for this class.');
        if (payload.id) {
          const { data, error } = await supabase.from('streams').update(rec).eq('id', payload.id).select().single();
          if (error) return err(error.message);
          clearCache();
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
        clearCache();
        return ok(data);
      },
      async remove(id) {
        const { count } = await supabase.from('students').select('id', { count: 'exact', head: true }).eq('stream_id', id);
        if (count > 0) return err('Students are assigned to this arm. Move them first.');
        // Round 3 §17: a class must always have at least one stream (arm) —
        // deleting an individual stream down to zero is refused; deleting
        // the WHOLE class (classes.remove() above) still cascades and
        // removes every one of its streams together, since that's an
        // explicit, different action, not this one.
        const { data: thisStream } = await supabase.from('streams').select('class_id').eq('id', id).maybeSingle();
        if (thisStream) {
          const { count: siblingCount } = await supabase.from('streams').select('id', { count: 'exact', head: true }).eq('class_id', thisStream.class_id).neq('id', id);
          if (!siblingCount) return err('A class must always have at least one arm — rename this one instead, or delete the whole class if it\'s no longer needed.');
        }
        const { error } = await supabase.from('streams').delete().eq('id', id);
        if (error) return err(error.message);
        clearCache();
        return ok(true);
      }
    },

    subjects: {
      async list() {
        return cached('subjects.list', null, async () => {
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
        });
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
          clearCache();
          return ok(data);
        }
        let dupQuery = supabase.from('subjects').select('id').ilike('name', name);
        dupQuery = level ? dupQuery.eq('level', level) : dupQuery.is('level', null);
        const { data: dup } = await dupQuery.maybeSingle();
        if (dup) return err('That subject already exists for this level.');
        const { data, error } = await supabase.from('subjects').insert(rec).select().single();
        if (error) return err(error.message);
        clearCache();
        return ok(data);
      },
      async remove(id) {
        // subject_class_assignments / subject_teacher_assignments cascade-delete automatically.
        const { error } = await supabase.from('subjects').delete().eq('id', id);
        if (error) return err(error.message);
        clearCache();
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
        clearCache();
        return ok(null, { added: (data || []).length });
      }
    },

    /** Paper 1 / Paper 2 (etc.) weighting per subject, PER EXAM — see
     *  subject_papers in migrations/0005_exam_workflow.sql and its exam
     *  scoping in 0020_learning_area_papers.sql. A subject with zero rows
     *  here for a given exam is "single-paper" for that exam and marks
     *  entry/broadsheets/report cards all work exactly as they always have.
     *  Deliberately exam-scoped, not a permanent subject setting — the same
     *  subject can have a totally different (or no) paper setup in a
     *  different exam; see the Learning Area Papers screen
     *  (learningAreaPapers.mjs). */
    subjectPapers: {
      /** Papers for ONE subject in ONE exam, optionally scoped further to
       *  ONE class (0021_learning_area_papers_per_class.sql — papers are not
       *  school-wide even within a single exam: Grade 1 might sit a subject
       *  as a single mark while Grade 8 sits the same subject, same exam, as
       *  3 papers). Marks Entry/Bulk Upload always pass classId, since a
       *  paper list only makes sense for the one class actually being
       *  entered. */
      async list(examId, subjectId, classId) {
        if (!examId) return ok([]);
        let q = supabase.from('subject_papers').select('*').eq('exam_id', examId);
        if (subjectId) q = q.eq('subject_id', subjectId);
        if (classId) q = q.eq('class_id', classId);
        const { data, error } = await q.order('paper_no', { ascending: true });
        if (error) return err(error.message);
        return ok(data || []);
      },
      /** Every configured paper across every subject AND every class for
       *  ONE exam, in one call — what the Learning Area Papers setup screen
       *  renders its whole table from (grouped client-side by subject, then
       *  by class), instead of one request per subject per class. */
      async listForExam(examId) {
        if (!examId) return ok([]);
        const { data, error } = await supabase.from('subject_papers').select('*').eq('exam_id', examId).order('paper_no', { ascending: true });
        if (error) return err(error.message);
        return ok(data || []);
      },
      /** Replace the WHOLE paper list for one (exam, subject, CLASS) in a
       *  single call — same "the full set is the unit of change" convention
       *  as setStreamSubjects()/periods.saveGrid() (Timetable). `papers` =
       *  [{ id?, name, out_of, ratio }] in display order; ratio is 0-100 (a
       *  percentage, matching how the setup screen collects it) and is
       *  stored internally as a 0-1 weight, keeping the existing
       *  score/out_of*weight combination formula (results.mjs,
       *  get_report_card()) completely unchanged.
       *
       *  An EMPTY array deliberately means "no papers" — deletes every
       *  existing row for this (exam, subject, class), reverting it to a
       *  single combined mark for this exam+class. That's the intended,
       *  easy way to undo papers for a class that shouldn't use them, per
       *  the brief's "must be decided fresh" requirement — never a one-way
       *  door.
       *
       *  Applying the SAME paper setup to several classes at once (the
       *  Learning Area Papers screen's class picker) means calling this
       *  once per selected class with the same `papers` array — see the
       *  id-ownership check below for why that's safe even though every
       *  call shares the same `papers` object (with the same `.id`s) across
       *  classes that don't actually own those ids. */
      async setForSubject(examId, subjectId, classId, papers) {
        if (!examId) return err('Missing exam.');
        if (!subjectId) return err('Missing subject.');
        if (!classId) return err('Missing class.');

        // Round 5 §6: paper setup ("out of" and ratio) may be reconfigured
        // at any point WHILE this subject's results for this class are
        // still unpublished — including after marks have already been
        // uploaded against it, which used to feel locked/impossible to
        // change. Once actually PUBLISHED, though, the grading structure
        // parents/students already saw shouldn't shift under them, so that
        // one state still blocks a reconfigure.
        const { data: submission } = await supabase.from('result_submissions').select('status')
          .eq('exam_id', examId).eq('class_id', classId).eq('subject_id', subjectId).maybeSingle();
        if (submission && submission.status === 'published') {
          return err('This subject\'s results are already published for this class — unpublish them first before changing paper setup.');
        }

        papers = (papers || []).map((p, i) => ({
          id: p.id || undefined,
          name: String(p.name || '').trim() || `Paper ${i + 1}`,
          paper_no: i + 1,
          out_of: p.out_of === '' || p.out_of === undefined || p.out_of === null ? 100 : Number(p.out_of),
          ratio: p.ratio === '' || p.ratio === undefined || p.ratio === null ? 0 : Number(p.ratio)
        }));
        if (papers.length) {
          for (const p of papers) {
            if (!(p.out_of > 0)) return err(`${p.name}: "Out of" must be a positive number.`);
          }
          // A single paper is always the whole subject — its ratio is
          // locked to 100% regardless of what's on screen, so a school
          // that's just giving one subject a custom "out of" this exam
          // (no real combining) never gets blocked by ratio math that
          // doesn't actually apply to them.
          if (papers.length === 1) {
            papers[0].ratio = 100;
          } else {
            const ratioTotal = Math.round(papers.reduce((a, p) => a + p.ratio, 0) * 100) / 100;
            if (ratioTotal !== 100) return err(`Ratios must add up to 100% — currently at ${ratioTotal}%.`);
          }
        }

        const { data: existing } = await supabase.from('subject_papers').select('id, name').eq('exam_id', examId).eq('subject_id', subjectId).eq('class_id', classId);
        const existingIds = new Set((existing || []).map((r) => r.id));
        // Defense in depth: an incoming id is only ever reused as an UPDATE
        // target if it actually belongs to THIS (exam, subject, class).
        // Applying one paper setup to multiple classes reuses the exact
        // same `papers` array (with the exact same `.id`s) across every
        // selected class — without this check, the second and later
        // classes in that loop would silently steal/overwrite the FIRST
        // class's rows via their shared ids instead of creating their own.
        papers.forEach((p) => { if (p.id && !existingIds.has(p.id)) p.id = undefined; });

        const keepIds = new Set(papers.filter((p) => p.id).map((p) => p.id));
        const toRemove = (existing || []).filter((r) => !keepIds.has(r.id));

        // Round 5 §6: validate against ALREADY-ENTERED marks BEFORE writing
        // anything — never delete/update a paper first and only then
        // discover the change breaks it. Two protections, both following
        // the brief's "if existing marks would no longer make sense, throw
        // a clear error" instruction:
        //   1. removing a paper that already has marks recorded against it
        //      would silently orphan those marks (paper_id -> null via the
        //      FK's ON DELETE SET NULL) — refused outright.
        //   2. shrinking a paper's "out of" below a mark that's already
        //      been entered against it would leave that score reading as
        //      more than the new maximum — refused with the exact reason.
        const touchedIds = [...new Set([...toRemove.map((r) => r.id), ...papers.filter((p) => p.id).map((p) => p.id)])];
        const resultsByPaper = {};
        if (touchedIds.length) {
          const { data: rows } = await supabase.from('results').select('paper_id, score').in('paper_id', touchedIds);
          (rows || []).forEach((r) => {
            if (r.score === null || r.score === undefined) return;
            (resultsByPaper[r.paper_id] = resultsByPaper[r.paper_id] || []).push(Number(r.score));
          });
        }
        for (const r of toRemove) {
          if ((resultsByPaper[r.id] || []).length) {
            return err(`Can't remove "${r.name}" — it already has marks recorded. Remove those marks first, or keep the paper and just adjust its "out of"/ratio instead.`);
          }
        }
        for (const p of papers) {
          if (!p.id) continue; // brand-new paper — nothing entered against it yet
          const tooHigh = (resultsByPaper[p.id] || []).filter((s) => s > p.out_of);
          if (tooHigh.length) {
            return err(`"${p.name}": ${tooHigh.length} student${tooHigh.length === 1 ? '' : 's'} already ha${tooHigh.length === 1 ? 's' : 've'} a mark above the new "out of" of ${p.out_of} — remove or adjust those marks first, or choose a higher "out of".`);
          }
        }

        for (const r of toRemove) {
          const { error } = await supabase.from('subject_papers').delete().eq('id', r.id);
          if (error) return err(error.message);
        }

        for (const p of papers) {
          const rec = { name: p.name, paper_no: p.paper_no, out_of: p.out_of, weight: p.ratio / 100 };
          if (p.id) {
            const { error } = await supabase.from('subject_papers').update(rec).eq('id', p.id);
            if (error) return err(error.message);
          } else {
            const { error } = await supabase.from('subject_papers').insert({ ...rec, exam_id: examId, subject_id: subjectId, class_id: classId });
            if (error) return err(error.message);
          }
        }
        return ok(true, { count: papers.length });
      }
    },

    /** Subject Combination (Round 2 §3) — the opposite direction from
     *  Learning Area Papers: instead of splitting one subject into papers,
     *  this combines two or more EXISTING subjects into one named,
     *  school-chosen result (e.g. Social Studies + CRE -> "SST/CRE
     *  Combined"), scoped to one exam, with a ratio/weighting between the
     *  member subjects — same 0-100 Ratio / 0-1 weight convention as
     *  subjectPapers. Marks are still entered per underlying subject
     *  exactly as before; only the Mark List (results.mjs's getBroadsheet)
     *  folds a combo's members into one combined column. */
    subjectCombinations: {
      /** Every combination configured for ONE exam, each with its member
       *  subjects nested — what the Subject Combination setup screen
       *  renders its whole list from, and what results.mjs's getBroadsheet
       *  uses to fold member subjects together. */
      async listForExam(examId) {
        if (!examId) return ok([]);
        const { data: combos, error } = await supabase.from('subject_combinations').select('*').eq('exam_id', examId).order('created_at', { ascending: true });
        if (error) return err(error.message);
        if (!(combos || []).length) return ok([]);
        const comboIds = combos.map((c) => c.id);
        const { data: members, error: mErr } = await supabase.from('subject_combination_members').select('*').in('combination_id', comboIds);
        if (mErr) return err(mErr.message);
        const membersByCombo = {};
        (members || []).forEach((m) => { (membersByCombo[m.combination_id] = membersByCombo[m.combination_id] || []).push(m); });
        return ok(combos.map((c) => ({ ...c, members: membersByCombo[c.id] || [] })));
      },

      /** Replace the WHOLE combination in a single call — same "the full
       *  set is the unit of change" convention as subjectPapers.setForSubject
       *  above. `id` is omitted to CREATE a new combination, or passed to
       *  replace an existing one's name + member list wholesale.
       *  `members` = [{ subject_id, ratio }], ratio 0-100 summing to 100,
       *  same as papers. Requires at least 2 members (fewer than that isn't
       *  a combination — it's just the one subject on its own) and refuses
       *  to save if any chosen subject is already part of a DIFFERENT
       *  combination in this same exam (a subject can only ever be folded
       *  into ONE combined result per exam). */
      async setCombination(examId, payload) {
        payload = payload || {};
        if (!examId) return err('Missing exam.');
        const id = payload.id || undefined;
        const name = String(payload.name || '').trim();
        if (!name) return err('Give this combination a name.');
        let members = (payload.members || []).map((m) => ({
          subject_id: m.subject_id,
          ratio: m.ratio === '' || m.ratio === undefined || m.ratio === null ? 0 : Number(m.ratio)
        })).filter((m) => m.subject_id);
        // De-dupe defensively — the setup screen shouldn't let the same
        // subject be picked twice, but never trust the client alone.
        const seen = new Set();
        members = members.filter((m) => { if (seen.has(m.subject_id)) return false; seen.add(m.subject_id); return true; });
        if (members.length < 2) return err('A combination needs at least 2 subjects.');
        const ratioTotal = Math.round(members.reduce((a, m) => a + m.ratio, 0) * 100) / 100;
        if (ratioTotal !== 100) return err(`Ratios must add up to 100% — currently at ${ratioTotal}%.`);

        // Defense in depth / core rule: none of these subjects may already
        // belong to a DIFFERENT combination for this same exam.
        const { data: otherCombos } = await supabase.from('subject_combinations').select('id, name').eq('exam_id', examId).neq('id', id || '');
        const otherComboIds = (otherCombos || []).map((c) => c.id);
        if (otherComboIds.length) {
          const { data: otherMembers } = await supabase.from('subject_combination_members').select('subject_id, combination_id').in('combination_id', otherComboIds);
          const nameById = {}; (otherCombos || []).forEach((c) => { nameById[c.id] = c.name; });
          const clash = (otherMembers || []).find((m) => members.some((mm) => mm.subject_id === m.subject_id));
          if (clash) return err(`That subject is already part of "${nameById[clash.combination_id] || 'another combination'}" for this exam — remove it there first.`);
        }

        let comboId = id;
        if (comboId) {
          const { error } = await supabase.from('subject_combinations').update({ name }).eq('id', comboId);
          if (error) return err(error.message);
          const { error: delErr } = await supabase.from('subject_combination_members').delete().eq('combination_id', comboId);
          if (delErr) return err(delErr.message);
        } else {
          const { data: created, error } = await supabase.from('subject_combinations').insert({ exam_id: examId, name }).select().single();
          if (error) return err(error.message);
          comboId = created.id;
        }

        const rows = members.map((m) => ({ combination_id: comboId, subject_id: m.subject_id, weight: m.ratio / 100 }));
        const { error: insErr } = await supabase.from('subject_combination_members').insert(rows);
        if (insErr) return err(insErr.message);
        return ok(true, { id: comboId });
      },

      /** Deletes a combination entirely (its members cascade with it) —
       *  the "undo, go back to separate subjects" escape hatch, same
       *  spirit as subjectPapers.setForSubject([]) reverting to a single
       *  mark. */
      async remove(comboId) {
        if (!comboId) return err('Missing combination.');
        const { error } = await supabase.from('subject_combinations').delete().eq('id', comboId);
        if (error) return err(error.message);
        return ok(true);
      }
    }
  };
}
