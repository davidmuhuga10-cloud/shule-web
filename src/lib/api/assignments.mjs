/**
 * assignments.mjs — Supabase equivalent of Assignments.gs.
 *
 * Phase 2g (brief §4 — "the most significant change"): subjects are now
 * assigned per STREAM, not per class. subject_class_assignments gained a
 * nullable stream_id column (migration 0009): a row with stream_id = null is
 * a legacy/class-wide row (from before this change, or a class with no
 * streams yet); a row with stream_id set is that stream's own authoritative
 * subject list. Once a stream has ANY stream-specific rows, those rows are
 * used exclusively for that stream (no merging with the class-wide rows) —
 * see getStreamSubjects()'s "inherited" flag for how the UI tells the admin
 * which case they're in.
 *
 * getClassSubjects(classId) is kept (same signature/behaviour as before) for
 * every existing caller that only knows about class_id — marks entry,
 * results, broadsheets, the exam-classes board, etc. It now returns the
 * UNION of every one of the class's streams' effective subjects, which is
 * exactly the class-wide set in the normal case (every stream studies the
 * same subjects) and is what actually fixes the reported "every class
 * attached to 30+ subjects" problem — a class only shows what belongs to it.
 */
import { ok, err } from './_util.mjs';
import { CBC_SUBJECTS, levelBucketForClassName } from './cbcDefaults.mjs';

/** Auto-populate a brand-new stream with its grade's default CBC subjects
 *  (brief §4.2). Best-effort: creates any missing subject rows for that
 *  level first (so a school that hasn't loaded the CBC list yet still gets
 *  sensible defaults), then assigns them to the stream. Silently does
 *  nothing for a non-standard class name (no defaults to guess) or if
 *  something goes wrong — a failure here should never block stream
 *  creation itself. */
export async function seedDefaultSubjectsForNewStream(supabase, streamId, classId, className) {
  try {
    const level = levelBucketForClassName(className);
    if (!level) return;
    const defaults = CBC_SUBJECTS.filter((s) => s.level === level).map((s) => s.name);
    if (!defaults.length) return;
    const wanted = new Set(defaults.map((n) => n.toLowerCase()));

    const { data: existingSubjects } = await supabase.from('subjects').select('id, name').eq('level', level);
    const haveNames = new Set((existingSubjects || []).map((s) => String(s.name).toLowerCase()));
    const toCreate = defaults.filter((n) => !haveNames.has(n.toLowerCase()));
    if (toCreate.length) {
      await supabase.from('subjects').insert(toCreate.map((name) => ({ name, level, code: '', description: '' })));
    }

    const { data: allLevelSubjects } = await supabase.from('subjects').select('id, name').eq('level', level);
    const idsToAssign = (allLevelSubjects || []).filter((s) => wanted.has(String(s.name).toLowerCase())).map((s) => s.id);
    if (idsToAssign.length) {
      await supabase.from('subject_class_assignments').insert(
        idsToAssign.map((subject_id) => ({ subject_id, class_id: classId, stream_id: streamId }))
      );
    }
  } catch (e) {
    // Non-fatal — the admin can still assign subjects manually.
  }
}

/** Standalone (not part of createAssignmentsApi) so OTHER api modules —
 *  results.mjs's listExamClasses/listSubmissions in particular — can get a
 *  class's effective (union-of-streams, "customized stream overrides
 *  class-wide" precedence) subject id list without composing a second whole
 *  assignments API instance. This is the single source of truth for "what
 *  subjects does this class actually study" now that assignment is
 *  per-stream (Phase 2g) — see getClassSubjects below, which just wraps
 *  this. */
export async function getEffectiveClassSubjectIds(supabase, classId) {
  const [{ data: streams }, { data: allRows }] = await Promise.all([
    supabase.from('streams').select('id').eq('class_id', classId),
    supabase.from('subject_class_assignments').select('subject_id, stream_id').eq('class_id', classId)
  ]);
  const classWideIds = (allRows || []).filter((r) => !r.stream_id).map((r) => r.subject_id);
  const byStream = {};
  (allRows || []).filter((r) => r.stream_id).forEach((r) => {
    (byStream[r.stream_id] = byStream[r.stream_id] || []).push(r.subject_id);
  });
  const set = new Set();
  const streamList = (streams && streams.length) ? streams : [{ id: null }];
  streamList.forEach((s) => {
    const effective = (s.id && byStream[s.id] && byStream[s.id].length) ? byStream[s.id] : classWideIds;
    effective.forEach((id) => set.add(id));
  });
  return [...set];
}

/** Perf fix: listExamClasses (the "Manage Exams" board) used to call
 *  getEffectiveClassSubjectIds() once PER class, sequentially — an exam
 *  covering 10+ classes meant 10+ sequential round trips just to open the
 *  board. Same logic as the single-class version above, but fetches every
 *  class's streams + assignment rows in ONE pair of batched queries and
 *  returns a { classId: [subjectIds] } map instead of looping. */
export async function getEffectiveClassSubjectIdsBatch(supabase, classIds) {
  const ids = [...new Set((classIds || []).filter(Boolean))];
  if (!ids.length) return {};
  const [{ data: streams }, { data: allRows }] = await Promise.all([
    supabase.from('streams').select('id, class_id').in('class_id', ids),
    supabase.from('subject_class_assignments').select('subject_id, stream_id, class_id').in('class_id', ids)
  ]);
  const streamsByClass = {};
  (streams || []).forEach((s) => { (streamsByClass[s.class_id] = streamsByClass[s.class_id] || []).push(s); });
  const classWideByClass = {};
  const byStream = {};
  (allRows || []).forEach((r) => {
    if (r.stream_id) (byStream[r.stream_id] = byStream[r.stream_id] || []).push(r.subject_id);
    else (classWideByClass[r.class_id] = classWideByClass[r.class_id] || []).push(r.subject_id);
  });
  const result = {};
  ids.forEach((cid) => {
    const classWideIds = classWideByClass[cid] || [];
    const set = new Set();
    const streamList = (streamsByClass[cid] && streamsByClass[cid].length) ? streamsByClass[cid] : [{ id: null }];
    streamList.forEach((s) => {
      const effective = (s.id && byStream[s.id] && byStream[s.id].length) ? byStream[s.id] : classWideIds;
      effective.forEach((id) => set.add(id));
    });
    result[cid] = [...set];
  });
  return result;
}

export function createAssignmentsApi(supabase) {
  // Round 4 §7: also selects id/periods_per_week/is_double (not just
  // subject_id) so getStreamSubjects() can surface the Timetable module's
  // per-subject weekly period count alongside everything else this already
  // resolves — same stream-row-wins-else-class-wide precedence, no
  // duplicated logic in timetable.mjs.
  async function effectiveSubjectIdsForStream(streamId, classId) {
    const cols = 'id, subject_id, periods_per_week, is_double';
    const { data: streamRows } = await supabase.from('subject_class_assignments').select(cols).eq('stream_id', streamId);
    if (streamRows && streamRows.length) return { ids: streamRows.map((r) => r.subject_id), rows: streamRows, inherited: false };
    const { data: classWide } = await supabase.from('subject_class_assignments').select(cols).eq('class_id', classId).is('stream_id', null);
    return { ids: (classWide || []).map((r) => r.subject_id), rows: classWide || [], inherited: (classWide || []).length > 0 };
  }

  return {
    async getClassSubjects(classId) {
      const ids = await getEffectiveClassSubjectIds(supabase, classId);
      return ok(ids.map((subject_id) => ({ subject_id })));
    },

    /** Legacy whole-class assignment — kept for any old data/callers, but no
     *  longer exposed via its own nav screen (see getStreamSubjects/
     *  setStreamSubjects, which is what the Classes UI now uses). */
    async setClassSubjects(classId, subjectIds) {
      if (!classId) return err('Please choose a class.');
      subjectIds = subjectIds || [];
      const { data: existing } = await supabase.from('subject_class_assignments').select('id, subject_id').eq('class_id', classId).is('stream_id', null);
      const existingIds = (existing || []).map((a) => String(a.subject_id));

      const toAdd = subjectIds.filter((sid) => existingIds.indexOf(String(sid)) === -1);
      const toRemove = (existing || []).filter((a) => subjectIds.map(String).indexOf(String(a.subject_id)) === -1);

      if (toAdd.length) {
        const { error } = await supabase.from('subject_class_assignments').insert(toAdd.map((sid) => ({ subject_id: sid, class_id: classId })));
        if (error) return err(error.message);
      }
      for (const a of toRemove) {
        await supabase.from('subject_class_assignments').delete().eq('id', a.id);
      }

      const [{ data: cls }, { count: streamCount }] = await Promise.all([
        supabase.from('classes').select('name').eq('id', classId).maybeSingle(),
        supabase.from('streams').select('id', { count: 'exact', head: true }).eq('class_id', classId)
      ]);
      return ok(null, { count: subjectIds.length, streamCount: streamCount || 0, className: cls ? cls.name : '' });
    },

    /** Effective subject list for ONE stream, each row enriched with which
     *  teacher (if any) is assigned to teach it in this stream — the data
     *  the new Classes > Stream > Subjects screen renders directly
     *  (brief §4.2/§4.3). `inherited: true` means this stream hasn't been
     *  customized yet — it's showing the class-wide default (or nothing). */
    async getStreamSubjects(streamId) {
      if (!streamId) return err('Please choose an arm.');
      const { data: stream } = await supabase.from('streams').select('id, class_id, name').eq('id', streamId).maybeSingle();
      if (!stream) return err('Arm not found.');
      const { ids: subjectIds, rows: assignmentRows, inherited } = await effectiveSubjectIdsForStream(streamId, stream.class_id);
      const assignmentBySubject = {}; assignmentRows.forEach((r) => { assignmentBySubject[r.subject_id] = r; });

      const [{ data: subjects }, { data: teacherRows }, { data: staffAll }, { data: cls }] = await Promise.all([
        subjectIds.length ? supabase.from('subjects').select('id, name, code, level').in('id', subjectIds) : Promise.resolve({ data: [] }),
        subjectIds.length ? supabase.from('subject_teacher_assignments').select('subject_id, staff_id').eq('stream_id', streamId).in('subject_id', subjectIds) : Promise.resolve({ data: [] }),
        supabase.from('staff').select('id, full_name'),
        supabase.from('classes').select('name').eq('id', stream.class_id).maybeSingle()
      ]);
      const staffMap = {}; (staffAll || []).forEach((s) => { staffMap[s.id] = s.full_name; });
      const teacherBySubject = {}; (teacherRows || []).forEach((t) => { teacherBySubject[t.subject_id] = t.staff_id; });

      const rows = (subjects || []).map((s) => {
        const a = assignmentBySubject[s.id] || {};
        return {
          subject_id: s.id, name: s.name, code: s.code, level: s.level,
          teacher_staff_id: teacherBySubject[s.id] || null,
          teacher_name: teacherBySubject[s.id] ? (staffMap[teacherBySubject[s.id]] || '(deleted)') : '',
          // Round 4 §7 (Timetable module): the subject_class_assignments row
          // this came from, plus its weekly-period config — assignment_id is
          // what timetable.mjs's requirements.save() targets to update it.
          assignment_id: a.id || null,
          periods_per_week: a.periods_per_week === undefined ? null : a.periods_per_week,
          is_double: !!a.is_double
        };
      }).sort((a, b) => String(a.name).localeCompare(String(b.name)));

      return ok(rows, { inherited, class_id: stream.class_id, class_name: cls ? cls.name : '', stream_name: stream.name });
    },

    /** Replace the full set of subjects for ONE stream in one call — this is
     *  what "add subject" (tick from the full list, then Save) writes.
     *  Removing a subject here also clears any teacher assigned to it in
     *  this stream, so a stale assignment can't linger unassigned-but-set. */
    async setStreamSubjects(streamId, classId, subjectIds) {
      if (!streamId) return err('Please choose an arm.');
      if (!classId) return err('Missing class.');
      subjectIds = (subjectIds || []).map(String);
      const { data: existing } = await supabase.from('subject_class_assignments').select('id, subject_id').eq('stream_id', streamId);
      const existingIds = (existing || []).map((a) => String(a.subject_id));

      const toAdd = subjectIds.filter((sid) => existingIds.indexOf(sid) === -1);
      const toRemove = (existing || []).filter((a) => subjectIds.indexOf(String(a.subject_id)) === -1);

      if (toAdd.length) {
        const { error } = await supabase.from('subject_class_assignments').insert(
          toAdd.map((subject_id) => ({ subject_id, class_id: classId, stream_id: streamId }))
        );
        if (error) return err(error.message);
      }
      for (const a of toRemove) {
        await supabase.from('subject_class_assignments').delete().eq('id', a.id);
        await supabase.from('subject_teacher_assignments').delete().eq('stream_id', streamId).eq('subject_id', a.subject_id);
      }
      return ok(null, { count: subjectIds.length });
    },

    /** Remove a single subject from a stream (the inline "✕ remove" action —
     *  no need to reopen the full tick-list for a mistake). */
    async removeStreamSubject(streamId, subjectId) {
      if (!streamId || !subjectId) return err('Missing arm or subject.');
      const { data: existing } = await supabase.from('subject_class_assignments').select('id').eq('stream_id', streamId).eq('subject_id', subjectId);
      for (const a of existing || []) await supabase.from('subject_class_assignments').delete().eq('id', a.id);
      await supabase.from('subject_teacher_assignments').delete().eq('stream_id', streamId).eq('subject_id', subjectId);
      return ok(true);
    },

    /** Set (or clear, if staff_id is falsy) which teacher teaches a subject
     *  in a specific stream — replaces any prior assignment for that exact
     *  stream+subject pair rather than allowing duplicates. */
    async setStreamSubjectTeacher(payload) {
      payload = payload || {};
      if (!payload.stream_id) return err('Missing arm.');
      if (!payload.subject_id) return err('Missing subject.');
      if (!payload.class_id) return err('Missing class.');
      const { data: existing } = await supabase.from('subject_teacher_assignments').select('id')
        .eq('stream_id', payload.stream_id).eq('subject_id', payload.subject_id);
      for (const e of existing || []) await supabase.from('subject_teacher_assignments').delete().eq('id', e.id);
      if (!payload.staff_id) return ok(null);
      const { error } = await supabase.from('subject_teacher_assignments').insert({
        subject_id: payload.subject_id, staff_id: payload.staff_id, class_id: payload.class_id, stream_id: payload.stream_id
      });
      if (error) return err(error.message);
      return ok(true);
    },

    async listTeacherAssignments(filters) {
      filters = filters || {};
      let q = supabase.from('subject_teacher_assignments').select('*');
      if (filters.staff_id) q = q.eq('staff_id', filters.staff_id);
      if (filters.class_id) q = q.eq('class_id', filters.class_id);
      if (filters.stream_id) q = q.eq('stream_id', filters.stream_id);
      const { data, error } = await q;
      if (error) return err(error.message);
      const rows = data || [];

      const subjectIds = [...new Set(rows.map((r) => r.subject_id).filter(Boolean))];
      const staffIds = [...new Set(rows.map((r) => r.staff_id).filter(Boolean))];
      const classIds = [...new Set(rows.map((r) => r.class_id).filter(Boolean))];
      const streamIds = [...new Set(rows.map((r) => r.stream_id).filter(Boolean))];
      const [{ data: subjects }, { data: staff }, { data: classes }, { data: streams }] = await Promise.all([
        subjectIds.length ? supabase.from('subjects').select('id, name').in('id', subjectIds) : Promise.resolve({ data: [] }),
        staffIds.length ? supabase.from('staff').select('id, full_name').in('id', staffIds) : Promise.resolve({ data: [] }),
        classIds.length ? supabase.from('classes').select('id, name').in('id', classIds) : Promise.resolve({ data: [] }),
        streamIds.length ? supabase.from('streams').select('id, name').in('id', streamIds) : Promise.resolve({ data: [] })
      ]);
      const subMap = {}; (subjects || []).forEach((s) => { subMap[s.id] = s.name; });
      const staffMap = {}; (staff || []).forEach((s) => { staffMap[s.id] = s.full_name; });
      const classMap = {}; (classes || []).forEach((c) => { classMap[c.id] = c.name; });
      const streamMap = {}; (streams || []).forEach((s) => { streamMap[s.id] = s.name; });

      rows.forEach((a) => {
        a.subject_name = subMap[a.subject_id] || '(deleted)';
        a.staff_name = staffMap[a.staff_id] || '(deleted)';
        a.class_name = classMap[a.class_id] || '';
        a.stream_name = streamMap[a.stream_id] || '';
      });
      rows.sort((a, b) => String(a.class_name + a.stream_name + a.subject_name).localeCompare(String(b.class_name + b.stream_name + b.subject_name)));
      return ok(rows);
    },

    async saveTeacherAssignment(payload) {
      payload = payload || {};
      if (!payload.staff_id) return err('Please choose a teacher.');
      if (!payload.subject_id) return err('Please choose a subject.');
      if (!payload.class_id) return err('Please choose a class.');

      const { data: existing } = await supabase.from('subject_teacher_assignments').select('*')
        .eq('subject_id', payload.subject_id).eq('class_id', payload.class_id).eq('staff_id', payload.staff_id);
      const dup = (existing || []).find((a) => String(a.stream_id || '') === String(payload.stream_id || ''));
      if (dup) return err('That teacher is already assigned to this subject and arm.');

      const { data, error } = await supabase.from('subject_teacher_assignments').insert({
        subject_id: payload.subject_id,
        staff_id: payload.staff_id,
        class_id: payload.class_id,
        stream_id: payload.stream_id || null,
        academic_year_id: payload.academic_year_id || null,
        term_id: payload.term_id || null
      }).select().single();
      if (error) return err(error.message);
      return ok(data);
    },

    async deleteTeacherAssignment(id) {
      const { error } = await supabase.from('subject_teacher_assignments').delete().eq('id', id);
      if (error) return err(error.message);
      return ok(true);
    }
  };
}
