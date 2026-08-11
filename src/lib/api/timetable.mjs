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
import { generateTimetable, checkCapacity, DEFAULT_PERIODS_PER_WEEK, CONSTRAINT_TYPES } from '../timetable/generate.mjs';

export const TIMETABLE_DAYS_DEFAULT = [1, 2, 3, 4, 5];

// 1=Mon .. 7=Sun — some schools teach on Sunday too, so the week isn't
// capped at Saturday.
function parseDays(value) {
  if (!value) return TIMETABLE_DAYS_DEFAULT.slice();
  const nums = String(value).split(',').map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n >= 1 && n <= 7);
  return nums.length ? nums : TIMETABLE_DAYS_DEFAULT.slice();
}

/** Round 5 §10: which version_number is currently "the" active timetable
 *  for a scope — used both to keep manual single-cell edits/inserts landing
 *  on the currently-visible version (rather than silently starting a
 *  stray untracked one) and as the fallback "start counting from here" for
 *  a school's very first generate/manual entry. Defaults to 1 when the
 *  scope has no entries at all yet. */
async function activeVersionNumber(supabase, academicYearId, termId) {
  const { data } = await supabase.from('timetable_entries').select('version_number')
    .eq('academic_year_id', academicYearId).eq('term_id', termId).eq('is_active', true).limit(1);
  return (data && data.length) ? (Number(data[0].version_number) || 1) : 1;
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

    /** Round 2 §7: the Constraints module — school-configured scheduling
     *  preferences fed into generate.mjs's placement engine as soft
     *  constraints (see that file's header comment for the full research
     *  and design rationale, and CONSTRAINT_TYPES for the canonical list
     *  of the 6 supported types). Every row is independently
     *  enabled/disabled and independently deletable; `save()` validates
     *  each type's own `config` shape so the UI gets a clear rejection
     *  rather than silently saving an inert row the engine will just skip. */
    constraints: {
      async list() {
        const { data, error } = await supabase.from('timetable_constraints').select('*').order('created_at', { ascending: true });
        if (error) return err(error.message);
        return ok(data || []);
      },
      async save(payload) {
        payload = payload || {};
        const type = payload.type;
        if (!CONSTRAINT_TYPES.includes(type)) return err('Unknown constraint type.');
        const config = payload.config || {};
        const enabled = payload.enabled !== false;
        // A DISABLED row is allowed to be incomplete/blank — a school
        // should be able to save "off, not configured yet" without first
        // filling in every field. Full validation only applies once a row
        // is actually being turned on, since that's the point an
        // incomplete config would otherwise silently do nothing at
        // generate time.
        let cleanConfig;
        if (type === 'subject_pair_not_consecutive') {
          if (enabled) {
            if (!config.subject_a || !config.subject_b) return err('Choose both subjects for this pair.');
            if (config.subject_a === config.subject_b) return err('Choose two different subjects.');
          }
          cleanConfig = { subject_a: config.subject_a || null, subject_b: config.subject_b || null };
        } else if (type === 'avoid_consecutive_intensive') {
          const ids = [...new Set((config.subject_ids || []).filter(Boolean))];
          if (enabled && ids.length < 2) return err('Pick at least 2 subjects to treat as mentally intensive.');
          cleanConfig = { subject_ids: ids };
        } else if (type === 'pe_before_break') {
          const ids = [...new Set((config.subject_ids || []).filter(Boolean))];
          if (enabled && !ids.length) return err('Pick at least 1 subject to treat as PE.');
          cleanConfig = { subject_ids: ids };
        } else if (type === 'max_consecutive_periods_class' || type === 'max_consecutive_periods_teacher') {
          const max = Number(config.max);
          if (enabled && (!Number.isFinite(max) || max < 1)) return err('Enter a maximum of at least 1 period.');
          cleanConfig = { max: Number.isFinite(max) && max >= 1 ? Math.floor(max) : null };
        } else {
          cleanConfig = {}; // teacher_no_immediate_after_out — just an on/off, no extra config
        }
        const rec = { type, enabled, config: cleanConfig };
        if (payload.id) {
          const { error } = await supabase.from('timetable_constraints').update(rec).eq('id', payload.id);
          if (error) return err(error.message);
          return ok(true);
        }
        const { data, error } = await supabase.from('timetable_constraints').insert(rec).select().single();
        if (error) return err(error.message);
        return ok(data);
      },
      async remove(id) {
        if (!id) return err('Missing constraint.');
        const { error } = await supabase.from('timetable_constraints').delete().eq('id', id);
        if (error) return err(error.message);
        return ok(true);
      }
    },

    entries: {
      /** filters: { academic_year_id, term_id, class_id?, stream_id?,
       *  staff_id?, version_number? } — Round 5 §10: with no version_number
       *  given, this returns only the currently ACTIVE version (what
       *  everyone sees/prints/edits by default); pass version_number to
       *  preview a specific kept-but-deactivated older generation instead
       *  (see listVersions()/reactivateVersion() below). */
      async list(filters) {
        filters = filters || {};
        if (!filters.academic_year_id || !filters.term_id) return err('Missing academic year or term.');
        let q = supabase.from('timetable_entries')
          .select('*, subjects(name), staff(full_name), streams(name), classes(name), rooms(name)')
          .eq('academic_year_id', filters.academic_year_id).eq('term_id', filters.term_id);
        if (filters.class_id) q = q.eq('class_id', filters.class_id);
        if (filters.stream_id) q = q.eq('stream_id', filters.stream_id);
        if (filters.staff_id) q = q.eq('staff_id', filters.staff_id);
        if (filters.version_number) q = q.eq('version_number', Number(filters.version_number));
        else q = q.eq('is_active', true);
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
       *  indexes enforce (0018_timetable.sql/0026_timetable_versions.sql),
       *  so the person gets a plain English message ("Mr Otieno already has
       *  a lesson then") instead of a raw duplicate-key error. The DB
       *  constraints stay in place regardless — never trust the
       *  client-side check alone.
       *
       *  Round 5 §10: the clash check is scoped to is_active=true only — an
       *  older, deactivated version's entries no longer "occupy" a slot as
       *  far as manual edits on the current timetable are concerned. New
       *  rows (no payload.id) land on whichever version_number is
       *  currently active, so a manual tweak accumulates onto the visible
       *  timetable rather than silently starting an untracked version. */
      async saveEntry(payload) {
        payload = payload || {};
        const required = ['academic_year_id', 'term_id', 'day_of_week', 'period_index', 'subject_id', 'class_id', 'stream_id'];
        for (const f of required) if (!payload[f] && payload[f] !== 0) return err('Missing required timetable fields.');
        let q = supabase.from('timetable_entries').select('id, staff_id, room_id, stream_id')
          .eq('academic_year_id', payload.academic_year_id).eq('term_id', payload.term_id)
          .eq('day_of_week', payload.day_of_week).eq('period_index', payload.period_index)
          .eq('is_active', true);
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
        rec.version_number = await activeVersionNumber(supabase, payload.academic_year_id, payload.term_id);
        rec.is_active = true;
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

      /** A full, unconditional wipe of every version this scope has ever
       *  had — unlike generate() (which keeps the last 3, see below), this
       *  is the "start completely over" escape hatch. Never called by
       *  generate() itself any more (Round 5 §10). */
      async clearScope(academicYearId, termId) {
        if (!academicYearId || !termId) return err('Missing academic year or term.');
        const { error } = await supabase.from('timetable_entries').delete().eq('academic_year_id', academicYearId).eq('term_id', termId);
        if (error) return err(error.message);
        return ok(true);
      },

      /** Round 5 §10: what's available to compare/reactivate for this
       *  scope — every kept generation (up to the last 3 regenerate()
       *  keeps around), newest first, with whether it's the one currently
       *  active and how many lessons it placed. */
      async listVersions(academicYearId, termId) {
        if (!academicYearId || !termId) return err('Missing academic year or term.');
        const { data, error } = await supabase.from('timetable_entries')
          .select('version_number, is_active, created_at')
          .eq('academic_year_id', academicYearId).eq('term_id', termId);
        if (error) return err(error.message);
        const byVersion = {};
        (data || []).forEach((r) => {
          const v = Number(r.version_number) || 1;
          if (!byVersion[v]) byVersion[v] = { version_number: v, is_active: false, created_at: r.created_at, count: 0 };
          byVersion[v].count++;
          if (r.is_active) byVersion[v].is_active = true;
          if (r.created_at && (!byVersion[v].created_at || r.created_at < byVersion[v].created_at)) byVersion[v].created_at = r.created_at;
        });
        const versions = Object.values(byVersion).sort((a, b) => b.version_number - a.version_number);
        return ok(versions);
      },

      /** Round 5 §10: switch which kept version is "the" active timetable
       *  — for when a fresh regenerate turns out worse than what was there
       *  before. Nothing is deleted or re-generated, just a flip of which
       *  rows are the visible/editable/printable set: deactivates whatever
       *  is currently active for this scope, then activates the chosen
       *  version instead. */
      async reactivateVersion(academicYearId, termId, versionNumber) {
        if (!academicYearId || !termId) return err('Missing academic year or term.');
        const v = Number(versionNumber);
        if (!Number.isInteger(v)) return err('Missing timetable version.');
        const { data: existing, error: exErr } = await supabase.from('timetable_entries').select('id')
          .eq('academic_year_id', academicYearId).eq('term_id', termId).eq('version_number', v).limit(1);
        if (exErr) return err(exErr.message);
        if (!existing || !existing.length) return err('That timetable version is no longer available.');
        const { error: deactErr } = await supabase.from('timetable_entries').update({ is_active: false })
          .eq('academic_year_id', academicYearId).eq('term_id', termId).eq('is_active', true);
        if (deactErr) return err(deactErr.message);
        const { error: actErr } = await supabase.from('timetable_entries').update({ is_active: true })
          .eq('academic_year_id', academicYearId).eq('term_id', termId).eq('version_number', v);
        if (actErr) return err(actErr.message);
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
      const [{ data: classes }, { data: streams }, periodsRes, daysRes, { data: unavailRows }, constraintsRes] = await Promise.all([
        supabase.from('classes').select('id, name'),
        supabase.from('streams').select('id, class_id, name'),
        this.periods.list(),
        this.days.get(),
        supabase.from('teacher_unavailability').select('staff_id, day_of_week, period_index'),
        this.constraints.list()
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
      const classNameById = {}; (classes || []).forEach((c) => { classNameById[c.id] = c.name; });
      const streamNameById = {}; (streams || []).forEach((s) => { streamNameById[s.id] = s.name; });

      const generateInput = {
        days: daysRes.data,
        periods: periodsRes.data.map((p) => ({ period_index: p.period_index, is_break: p.is_break })),
        streams: streamsInput,
        unavailable
      };

      // Round 2 §7: fail clearly BEFORE running the placement engine or
      // touching any existing timetable, whenever a stream is being asked
      // for more periods/week than the week genuinely has room for — this
      // used to only ever surface as a pile of per-subject `unresolved`
      // entries after generation had already cleared the old timetable and
      // run to completion. Nothing has been cleared or written yet at this
      // point, so a school that hits this still has its previous timetable
      // (if any) intact and untouched.
      const capacity = checkCapacity(generateInput);
      if (!capacity.ok) {
        const detail = capacity.overloaded.map((o) => {
          const label = `${classNameById[o.class_id] || ''} ${streamNameById[o.stream_id] || ''}`.trim() || 'A class/arm';
          return `${label} needs ${o.required} periods/week but the week only has ${o.available}`;
        }).join('; ');
        return err(`Not enough room in the week for what's configured: ${detail}. Reduce periods/week for the affected subject(s) or add more periods to the daily grid (Setup tab), then try again.`);
      }

      // Round 2 §7: the school's configured Constraints, fed to the engine
      // as soft preferences — see generate.mjs's header comment. A school
      // with none configured (or a fetch failure, e.g. offline) simply
      // generates exactly as it always has (empty array = no constraints
      // enforced, not a hard failure).
      generateInput.constraints = constraintsRes.ok ? constraintsRes.data : [];

      // Round 5 §10's version tracking doubles as Round 6 §3's fix for
      // "regenerate produces nearly identical output": the engine is
      // deterministic by design (generate.mjs's header comment), so without
      // something to vary between runs the exact same input always
      // produces the exact same layout. The next version_number this
      // generate will become is a natural, already-tracked value that's
      // guaranteed to differ every time — passed as the engine's `seed`, it
      // genuinely reshuffles the placement each regenerate while staying
      // fully deterministic/reproducible for that specific version.
      // Queried here (before running the engine) so it's ready in time;
      // reused below instead of querying it a second time.
      const { data: existingVersionRows, error: versErr } = await supabase.from('timetable_entries')
        .select('version_number').eq('academic_year_id', academicYearId).eq('term_id', termId);
      if (versErr) return err(versErr.message);
      const existingVersions = [...new Set((existingVersionRows || []).map((r) => Number(r.version_number) || 1))];
      const nextVersion = existingVersions.length ? Math.max(...existingVersions) + 1 : 1;
      generateInput.seed = nextVersion;

      const { entries, unresolved } = generateTimetable(generateInput);

      // Round 5 §10: a total placement failure (nothing at all could be
      // scheduled, yet something WAS supposed to be) is the worst possible
      // regenerate outcome — leave the existing timetable (if any) fully
      // intact rather than replacing it with an empty one. A genuinely
      // empty result with nothing unresolved either (e.g. a brand-new
      // school with classes but no subjects assigned yet) is not this case
      // and proceeds normally below.
      if (!entries.length && unresolved.length) {
        return err('Nothing could be placed — check your subject/teacher/period configuration and try again. Your existing timetable (if any) has not been changed.');
      }

      // Round 5 §10: keep the last 3 generated timetables per scope instead
      // of hard-deleting the previous one outright — deactivate whatever's
      // currently active (kept, not deleted, so it can be reactivated if
      // this regenerate turns out worse via entries.reactivateVersion()),
      // insert this result as a fresh version, then prune anything older
      // than the 3 most recent versions so the table doesn't grow forever.
      const { error: deactErr } = await supabase.from('timetable_entries').update({ is_active: false })
        .eq('academic_year_id', academicYearId).eq('term_id', termId).eq('is_active', true);
      if (deactErr) return err(deactErr.message);

      if (entries.length) {
        const rows = entries.map((e) => ({ ...e, academic_year_id: academicYearId, term_id: termId, version_number: nextVersion, is_active: true }));
        const { error } = await supabase.from('timetable_entries').insert(rows);
        if (error) return err(error.message);
      }

      const keepVersions = [...existingVersions, nextVersion].sort((a, b) => b - a).slice(0, 3);
      const pruneVersions = existingVersions.filter((v) => !keepVersions.includes(v));
      if (pruneVersions.length) {
        const { error: pruneErr } = await supabase.from('timetable_entries').delete()
          .eq('academic_year_id', academicYearId).eq('term_id', termId).in('version_number', pruneVersions);
        if (pruneErr) return err(pruneErr.message);
      }

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
