/**
 * timetable.mjs — Round 4 §7: the Timetable module's data-access layer.
 * Same conventions as every other api/*.mjs module: takes the Supabase
 * client as a parameter (unit-testable with a mock — see
 * tests/timetable.test.mjs), returns { ok, data|message }.
 *
 * `settingsApi` is injected (same pattern results.mjs takes gradingApi) so
 * `days` can read/write `settings.timetable_days` through the exact same
 * batched save() every other settings field uses, instead of hand-rolling a
 * second key/value writer.
 *
 * See supabase/migrations/0018_timetable.sql for the full schema/design
 * rationale and Timetable_Module_Research_and_Design_Proposal.docx for the
 * research this is built on.
 */
import { ok, err } from './_util.mjs';
import { generateTimetable, DEFAULT_PERIODS_PER_WEEK } from '../timetable/generate.mjs';

export const TIMETABLE_DAYS_DEFAULT = [1, 2, 3, 4, 5];

// 1=Mon .. 7=Sun — some schools teach on Sunday too, so the week isn't
// capped at Saturday.
function parseDays(value) {
  if (!value) return TIMETABLE_DAYS_DEFAULT.slice();
  const nums = String(value).split(',').map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n >= 1 && n <= 7);
  return nums.length ? nums : TIMETABLE_DAYS_DEFAULT.slice();
}

export function createTimetableApi(supabase, settingsApi) {
  return {
    rooms: {
      async list() {
        const { data, error } = await supabase.from('rooms').select('*').order('name', { ascending: true });
        if (error) return err(error.message);
        return ok(data || []);
      },
      async save(payload) {
        payload = payload || {};
        const name = String(payload.name || '').trim();
        if (!name) return err('Room name is required (e.g. "Lab 1", "Room 4").');
        const rec = { name, capacity: payload.capacity === '' || payload.capacity === undefined || payload.capacity === null ? null : Number(payload.capacity) || null };
        if (payload.id) {
          const { data, error } = await supabase.from('rooms').update(rec).eq('id', payload.id).select().single();
          if (error) return err(error.message.includes('duplicate') ? `A room named "${name}" already exists.` : error.message);
          return ok(data);
        }
        const { data, error } = await supabase.from('rooms').insert(rec).select().single();
        if (error) return err(error.message.includes('duplicate') ? `A room named "${name}" already exists.` : error.message);
        return ok(data);
      },
      async remove(id) {
        // Safe unconditionally — timetable_entries.room_id is ON DELETE SET
        // NULL, so removing a room just clears it off any lesson that had
        // it, rather than blocking the delete or cascading data loss.
        const { error } = await supabase.from('rooms').delete().eq('id', id);
        if (error) return err(error.message);
        return ok(true);
      }
    },

    periods: {
      async list() {
        const { data, error } = await supabase.from('timetable_periods').select('*').order('period_index', { ascending: true });
        if (error) return err(error.message);
        return ok(data || []);
      },
      /** Replace-all, same convention as every other "the whole set is the
       *  unit of change" save in this codebase (setStreamSubjects, etc.) —
       *  rows = [{ period_index, start_time, end_time, is_break, label }],
       *  in the order they should appear. */
      async saveGrid(rows) {
        rows = (rows || []).map((r, i) => ({
          period_index: i + 1,
          start_time: String(r.start_time || '').trim(),
          end_time: String(r.end_time || '').trim(),
          is_break: !!r.is_break,
          label: String(r.label || '').trim() || null
        }));
        if (!rows.length) return err('Add at least one period before saving.');
        for (const r of rows) {
          if (!r.start_time || !r.end_time) return err('Every period needs a start and end time.');
          if (r.end_time <= r.start_time) return err(`Period ${r.period_index}'s end time must be after its start time.`);
        }
        const { error: delError } = await supabase.from('timetable_periods').delete().neq('period_index', -1);
        if (delError) return err(delError.message);
        const { error } = await supabase.from('timetable_periods').insert(rows);
        if (error) return err(error.message);
        return ok(true);
      }
    },

    days: {
      /** Which weekdays the school actually runs — 1=Mon..6=Sat. Defaults to
       *  Mon-Fri so a school never has to touch this to get a working
       *  timetable. */
      async get() {
        const res = await settingsApi.get();
        if (!res.ok) return err(res.message);
        return ok(parseDays(res.data.timetable_days));
      },
      async save(days) {
        days = (days || []).map(Number).filter((n) => Number.isInteger(n) && n >= 1 && n <= 7);
        if (!days.length) return err('Choose at least one teaching day.');
        return settingsApi.save({ timetable_days: days.join(',') });
      }
    },

    availability: {
      async listForStaff(staffId) {
        if (!staffId) return ok([]);
        const { data, error } = await supabase.from('teacher_unavailability').select('day_of_week, period_index').eq('staff_id', staffId);
        if (error) return err(error.message);
        return ok(data || []);
      },
      /** Replace-all for one teacher — blocks = [{day_of_week, period_index}]. */
      async saveForStaff(staffId, blocks) {
        if (!staffId) return err('Missing teacher.');
        const { error: delError } = await supabase.from('teacher_unavailability').delete().eq('staff_id', staffId);
        if (delError) return err(delError.message);
        const rows = (blocks || []).map((b) => ({ staff_id: staffId, day_of_week: Number(b.day_of_week), period_index: Number(b.period_index) }));
        if (!rows.length) return ok(true);
        const { error } = await supabase.from('teacher_unavailability').insert(rows);
        if (error) return err(error.message);
        return ok(true);
      }
    },

    requirements: {
      /** Updates ONE subject_class_assignments row's weekly-period config —
       *  `assignmentId` comes straight off a row returned by
       *  Db.assignments.getStreamSubjects() (see that function's Round 4 §7
       *  additions). No new fetch needed here; the Setup screen already has
       *  everything it needs from that one call.
       *
       *  `doublePeriodsPerWeek` is a COUNT, not a yes/no — e.g. "Math gets 3
       *  double lessons a week" — so a school can mix doubles and singles
       *  for the same subject exactly as they actually run it, rather than
       *  a checkbox that forces every possible pair into a double. */
      async save(assignmentId, periodsPerWeek, doublePeriodsPerWeek) {
        if (!assignmentId) return err('Missing subject assignment.');
        const periods = periodsPerWeek === '' || periodsPerWeek === null || periodsPerWeek === undefined ? null : Number(periodsPerWeek) || null;
        const doubles = doublePeriodsPerWeek === '' || doublePeriodsPerWeek === null || doublePeriodsPerWeek === undefined ? 0 : Number(doublePeriodsPerWeek) || 0;
        const capacity = periods === null ? DEFAULT_PERIODS_PER_WEEK : periods;
        if (doubles > Math.floor(capacity / 2)) {
          return err(`${doubles} double lesson${doubles === 1 ? '' : 's'} need${doubles === 1 ? 's' : ''} at least ${doubles * 2} periods/week — this subject only has ${capacity}.`);
        }
        const rec = { periods_per_week: periods, double_periods_per_week: doubles };
        const { error } = await supabase.from('subject_class_assignments').update(rec).eq('id', assignmentId);
        if (error) return err(error.message);
        return ok(true);
      }
    },

    entries: {
      /** filters: { academic_year_id, term_id, class_id?, stream_id?, staff_id? } */
      async list(filters) {
        filters = filters || {};
        if (!filters.academic_year_id || !filters.term_id) return err('Missing academic year or term.');
        let q = supabase.from('timetable_entries')
          .select('*, subjects(name), staff(full_name), streams(name), classes(name), rooms(name)')
          .eq('academic_year_id', filters.academic_year_id).eq('term_id', filters.term_id);
        if (filters.class_id) q = q.eq('class_id', filters.class_id);
        if (filters.stream_id) q = q.eq('stream_id', filters.stream_id);
        if (filters.staff_id) q = q.eq('staff_id', filters.staff_id);
        const { data, error } = await q;
        if (error) return err(error.message);
        const rows = (data || []).map((r) => ({
          ...r,
          subject_name: r.subjects ? r.subjects.name : '',
          teacher_name: r.staff ? r.staff.full_name : '',
          stream_name: r.streams ? r.streams.name : '',
          class_name: r.classes ? r.classes.name : '',
          room_name: r.rooms ? r.rooms.name : ''
        }));
        return ok(rows);
      },

      /** Manual single-cell edit (the Timetable screen's "click a slot" edit
       *  path) — pre-checks the same hard constraints the DB's own unique
       *  indexes enforce (0018_timetable.sql), so the person gets a plain
       *  English message ("Mr Otieno already has a lesson then") instead of
       *  a raw duplicate-key error. The DB constraints stay in place
       *  regardless — never trust the client-side check alone. */
      async saveEntry(payload) {
        payload = payload || {};
        const required = ['academic_year_id', 'term_id', 'day_of_week', 'period_index', 'subject_id', 'class_id', 'stream_id'];
        for (const f of required) if (!payload[f] && payload[f] !== 0) return err('Missing required timetable fields.');
        let q = supabase.from('timetable_entries').select('id, staff_id, room_id, stream_id')
          .eq('academic_year_id', payload.academic_year_id).eq('term_id', payload.term_id)
          .eq('day_of_week', payload.day_of_week).eq('period_index', payload.period_index);
        const { data: clashRows } = await q;
        const others = (clashRows || []).filter((r) => r.id !== payload.id);
        const streamClash = others.find((r) => r.stream_id === payload.stream_id);
        if (streamClash) return err('This stream already has a lesson in that slot.');
        if (payload.staff_id) {
          const staffClash = others.find((r) => r.staff_id === payload.staff_id);
          if (staffClash) return err('This teacher already has a lesson in that slot.');
        }
        if (payload.room_id) {
          const roomClash = others.find((r) => r.room_id === payload.room_id);
          if (roomClash) return err('This room is already booked in that slot.');
        }
        const rec = {
          academic_year_id: payload.academic_year_id, term_id: payload.term_id,
          day_of_week: Number(payload.day_of_week), period_index: Number(payload.period_index),
          subject_id: payload.subject_id, class_id: payload.class_id, stream_id: payload.stream_id,
          staff_id: payload.staff_id || null, room_id: payload.room_id || null
        };
        if (payload.id) {
          const { error } = await supabase.from('timetable_entries').update(rec).eq('id', payload.id);
          if (error) return err(error.message);
          return ok(true);
        }
        const { error } = await supabase.from('timetable_entries').insert(rec);
        if (error) return err(error.message);
        return ok(true);
      },

      async deleteEntry(id) {
        if (!id) return err('Missing entry.');
        const { error } = await supabase.from('timetable_entries').delete().eq('id', id);
        if (error) return err(error.message);
        return ok(true);
      },

      /** Used right before a fresh Generate — clears only this (year, term)'s
       *  own rows, never touches any other term's saved timetable. */
      async clearScope(academicYearId, termId) {
        if (!academicYearId || !termId) return err('Missing academic year or term.');
        const { error } = await supabase.from('timetable_entries').delete().eq('academic_year_id', academicYearId).eq('term_id', termId);
        if (error) return err(error.message);
        return ok(true);
      }
    },

    /** Orchestrates a full auto-generate for one (academic year, term):
     *  fetches every class's streams + effective subjects (with their
     *  configured periods/week, double-lesson flag and assigned teacher —
     *  see assignments.mjs's getStreamSubjects), the period grid, teaching
     *  days and teacher-unavailability blocks, runs the pure engine
     *  (generate.mjs), replaces this scope's existing entries with the
     *  result, and reports back both what was placed and — just as
     *  important — what couldn't be, by name, rather than silently
     *  producing an incomplete timetable. */
    async generate(academicYearId, termId) {
      if (!academicYearId || !termId) return err('Choose an academic year and term first.');

      // Perf: fetch classes/streams/period grid/teaching days/teacher
      // unavailability up front, all in parallel — none of these depend on
      // each other, and teacher_unavailability doesn't depend on anything
      // else in this function either, so there's no reason to wait for the
      // subject-assignment step before starting it.
      const [{ data: classes }, { data: streams }, periodsRes, daysRes, { data: unavailRows }] = await Promise.all([
        supabase.from('classes').select('id, name'),
        supabase.from('streams').select('id, class_id, name'),
        this.periods.list(),
        this.days.get(),
        supabase.from('teacher_unavailability').select('staff_id, day_of_week, period_index')
      ]);
      if (!periodsRes.ok) return err(periodsRes.message);
      if (!daysRes.ok) return err(daysRes.message);
      if (!periodsRes.data.length) return err('Set up your period grid first (Setup tab) before generating a timetable.');
      if (!(streams || []).length) return err('No classes/arms found — add classes and arms first.');

      // Effective subjects (with periods/week, doubles/week, teacher) per
      // stream — same stream-row-wins-else-class-wide precedence
      // assignments.mjs's getEffectiveClassSubjectIdsBatch already uses,
      // but fetched here in exactly TWO queries total (every stream's own
      // rows in one .in() call, every class-wide fallback row in another),
      // not two queries PER STREAM. A big school with 30-40 streams used to
      // mean 60-80 sequential-feeling round trips (the browser can only run
      // ~6 requests at once per host, so most of them just queued) — that
      // was the main reason Generate felt slow. Now it's always 2, however
      // many streams the school has.
      const streamIds = (streams || []).map((s) => s.id);
      const classIds = [...new Set((streams || []).map((s) => s.class_id))];
      const [{ data: streamRows }, { data: classWideRows }] = await Promise.all([
        streamIds.length ? supabase.from('subject_class_assignments').select('subject_id, stream_id, class_id, periods_per_week, double_periods_per_week').in('stream_id', streamIds) : Promise.resolve({ data: [] }),
        classIds.length ? supabase.from('subject_class_assignments').select('subject_id, stream_id, class_id, periods_per_week, double_periods_per_week').in('class_id', classIds).is('stream_id', null) : Promise.resolve({ data: [] })
      ]);
      const rowsByStream = {};
      (streamRows || []).forEach((r) => { (rowsByStream[r.stream_id] = rowsByStream[r.stream_id] || []).push(r); });
      const rowsByClass = {};
      (classWideRows || []).forEach((r) => { (rowsByClass[r.class_id] = rowsByClass[r.class_id] || []).push(r); });
      const streamSubjectsRes = (streams || []).map((s) => ({
        stream: s,
        rows: (rowsByStream[s.id] && rowsByStream[s.id].length) ? rowsByStream[s.id] : (rowsByClass[s.class_id] || [])
      }));

      const allSubjectIds = [...new Set(streamSubjectsRes.flatMap((r) => r.rows.map((x) => x.subject_id)))];
      const [{ data: subjectsMeta }, { data: teacherRows }] = await Promise.all([
        allSubjectIds.length ? supabase.from('subjects').select('id, name').in('id', allSubjectIds) : Promise.resolve({ data: [] }),
        allSubjectIds.length ? supabase.from('subject_teacher_assignments').select('subject_id, stream_id, class_id, staff_id').in('subject_id', allSubjectIds) : Promise.resolve({ data: [] })
      ]);
      const subjectNameById = {}; (subjectsMeta || []).forEach((s) => { subjectNameById[s.id] = s.name; });
      // Teacher lookup: stream-specific assignment wins, else class-wide
      // (stream_id null) — same precedence subject_class_assignments uses.
      const teacherByStreamSubject = {}, teacherByClassSubject = {};
      (teacherRows || []).forEach((t) => {
        if (t.stream_id) teacherByStreamSubject[`${t.stream_id}|${t.subject_id}`] = t.staff_id;
        else teacherByClassSubject[`${t.class_id}|${t.subject_id}`] = t.staff_id;
      });

      const streamsInput = streamSubjectsRes.map(({ stream, rows }) => ({
        stream_id: stream.id, class_id: stream.class_id,
        subjects: rows.map((r) => ({
          subject_id: r.subject_id, subject_name: subjectNameById[r.subject_id] || '',
          periods_per_week: r.periods_per_week, double_periods_per_week: r.double_periods_per_week,
          staff_id: teacherByStreamSubject[`${stream.id}|${r.subject_id}`] || teacherByClassSubject[`${stream.class_id}|${r.subject_id}`] || null
        }))
      }));

      const unavailable = new Set((unavailRows || []).map((u) => `${u.staff_id}|${u.day_of_week}|${u.period_index}`));

      const { entries, unresolved } = generateTimetable({
        days: daysRes.data,
        periods: periodsRes.data.map((p) => ({ period_index: p.period_index, is_break: p.is_break })),
        streams: streamsInput,
        unavailable
      });

      const clearRes = await this.entries.clearScope(academicYearId, termId);
      if (!clearRes.ok) return err(clearRes.message);

      if (entries.length) {
        const rows = entries.map((e) => ({ ...e, academic_year_id: academicYearId, term_id: termId }));
        const { error } = await supabase.from('timetable_entries').insert(rows);
        if (error) return err(error.message);
      }

      const classNameById = {}; (classes || []).forEach((c) => { classNameById[c.id] = c.name; });
      const streamNameById = {}; (streams || []).forEach((s) => { streamNameById[s.id] = s.name; });
      const unresolvedNamed = unresolved.map((u) => ({
        ...u,
        subject_name: u.subject_name || subjectNameById[u.subject_id] || '',
        class_name: classNameById[u.class_id] || '',
        stream_name: streamNameById[u.stream_id] || ''
      }));

      return ok({ placed: entries.length, unresolved: unresolvedNamed });
    }
  };
}
