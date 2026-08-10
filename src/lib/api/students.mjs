/**
 * students.mjs — Supabase equivalent of Students.gs.
 */
import { ok, err, byAdmissionNo } from './_util.mjs';

const VALID_GENDERS = ['Male', 'Female'];
export const LEAVING_REASONS = ['transferred', 'graduated', 'withdrawn', 'other'];
export const LEAVING_REASON_LABELS = {
  transferred: 'Transferred to another school', graduated: 'Graduated', withdrawn: 'Withdrawn', other: 'Other'
};

function todayIso() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

/** Feature brief: admission number, gender, name, class and stream are all
 *  compulsory when adding a SINGLE student via save() — UNLESS the chosen
 *  class has no streams set up at all, in which case there's nothing to
 *  pick. bulkCreate() has its own equivalent all-rows-required stream rule
 *  (Round 4 §1) enforced directly in bulkCreate() below, since it validates
 *  a whole file of rows up front rather than one payload at a time. */
async function classHasStreams(supabase, classId) {
  if (!classId) return false;
  const { data } = await supabase.from('streams').select('id').eq('class_id', classId);
  return !!(data && data.length);
}

export function createStudentsApi(supabase) {
  async function withNames(rows) {
    const classIds = [...new Set(rows.map((r) => r.class_id).filter(Boolean))];
    const streamIds = [...new Set(rows.map((r) => r.stream_id).filter(Boolean))];
    const [{ data: classes }, { data: streams }] = await Promise.all([
      classIds.length ? supabase.from('classes').select('id, name').in('id', classIds) : Promise.resolve({ data: [] }),
      streamIds.length ? supabase.from('streams').select('id, name').in('id', streamIds) : Promise.resolve({ data: [] })
    ]);
    const classMap = {}; (classes || []).forEach((c) => { classMap[c.id] = c.name; });
    const streamMap = {}; (streams || []).forEach((s) => { streamMap[s.id] = s.name; });
    return rows.map((r) => ({ ...r, class_name: classMap[r.class_id] || '', stream_name: streamMap[r.stream_id] || '' }));
  }

  return {
    async list(filters) {
      filters = filters || {};
      let q = supabase.from('students').select('*');
      if (filters.class_id) q = q.eq('class_id', filters.class_id);
      if (filters.stream_id) q = q.eq('stream_id', filters.stream_id);
      q = q.eq('status', filters.status || 'active');
      const { data, error } = await q;
      if (error) return err(error.message);
      const withN = await withNames(data || []);
      withN.sort(byAdmissionNo);
      return ok(withN);
    },

    /** Search ACROSS every active student (ignoring any class/stream filter
     *  currently applied in the UI) by admission number or name — brief §5's
     *  "search-student feature." Small/medium school roster sizes make a
     *  client-side substring match perfectly fine here; no need for a
     *  database-side ilike-or() (which the mock query builder doesn't
     *  support anyway). */
    async search(query) {
      query = String(query || '').trim().toLowerCase();
      if (!query) return ok([]);
      const { data, error } = await supabase.from('students').select('*').eq('status', 'active');
      if (error) return err(error.message);
      const matched = (data || []).filter((s) =>
        String(s.admission_no || '').toLowerCase().indexOf(query) !== -1 ||
        String(s.full_name || '').toLowerCase().indexOf(query) !== -1
      );
      const withN = await withNames(matched);
      withN.sort(byAdmissionNo);
      return ok(withN);
    },

    async get(id) {
      const { data, error } = await supabase.from('students').select('*').eq('id', id).maybeSingle();
      if (error) return err(error.message);
      if (!data) return err('Student not found.');
      const [withN] = await withNames([data]);
      return ok(withN);
    },

    /** Round 3 §2: lets the bulk-upload PREVIEW step catch a duplicate
     *  admission number up front — same "already in use" check save() does
     *  for a single student — instead of only finding out at import time.
     *  Deliberately unfiltered by status (matches save()'s own duplicate
     *  check), since an admission number stays reserved even for an
     *  archived/left student. */
    async existingAdmissionNumbers() {
      const { data, error } = await supabase.from('students').select('admission_no');
      if (error) return err(error.message);
      return ok((data || []).map((r) => String(r.admission_no || '').trim().toLowerCase()).filter(Boolean));
    },

    async save(payload) {
      payload = payload || {};
      const admissionNo = String(payload.admission_no || '').trim();
      const fullName = String(payload.full_name || '').trim();
      const gender = payload.gender;
      if (!admissionNo) return err('Admission number is required.');
      if (!fullName) return err('Student name is required.');
      if (VALID_GENDERS.indexOf(gender) === -1) return err('Please choose a gender (Male or Female).');
      if (!payload.class_id) return err('Please choose a class.');
      if (!payload.stream_id && await classHasStreams(supabase, payload.class_id)) {
        return err('Please choose an arm — this class has arms set up.');
      }

      const rec = {
        admission_no: admissionNo,
        full_name: fullName,
        gender,
        class_id: payload.class_id,
        stream_id: payload.stream_id || null,
        guardian_name: payload.guardian_name || '',
        guardian_contact: payload.guardian_contact || '',
        status: payload.status || 'active',
        // Richer bio-data (Phase 2c) — all optional.
        date_of_birth: payload.date_of_birth || null,
        admission_date: payload.admission_date || null,
        upi_number: payload.upi_number || '',
        assessment_number: payload.assessment_number || '',
        previous_school: payload.previous_school || '',
        guardian_relationship: payload.guardian_relationship || '',
        guardian_id_number: payload.guardian_id_number || '',
        medical_notes: payload.medical_notes || ''
      };

      let dupQuery = supabase.from('students').select('id').eq('admission_no', admissionNo);
      const { data: dupRows } = await dupQuery;
      const dup = (dupRows || []).find((r) => String(r.id) !== String(payload.id || ''));
      if (dup) return err(`Admission number "${admissionNo}" is already in use.`);

      if (payload.id) {
        const { data, error } = await supabase.from('students').update(rec).eq('id', payload.id).select().single();
        if (error) return err(error.message);
        return ok(data);
      }
      const { data, error } = await supabase.from('students').insert(rec).select().single();
      if (error) return err(error.message);
      return ok(data);
    },

    /** Permanently deletes the student AND every historical record tied to
     *  them (results, attendance, parent links — all cascade). Kept for
     *  genuine mistakes (a duplicate/test record entered in error); for the
     *  ordinary "this student left the school" case, use archive() instead
     *  — it keeps their historical results/attendance intact for reference
     *  rather than erasing them. */
    async remove(id) {
      const { error } = await supabase.from('students').delete().eq('id', id);
      if (error) return err(error.message);
      return ok(true);
    },

    /** Soft-remove: takes the student off the active roster (list() no
     *  longer returns them by default, and they automatically drop out of
     *  class ranking cohorts) while keeping every historical record —
     *  results, attendance, parent links — untouched. This is the normal
     *  path for "this student transferred / graduated / withdrew." */
    async archive(id, payload) {
      if (!id) return err('Missing student.');
      payload = payload || {};
      const reason = LEAVING_REASONS.indexOf(payload.reason) !== -1 ? payload.reason : 'other';
      const rec = {
        status: 'left',
        left_reason: reason,
        left_date: payload.left_date || todayIso(),
        left_notes: payload.notes || ''
      };
      const { data, error } = await supabase.from('students').update(rec).eq('id', id).select().single();
      if (error) return err(error.message);
      return ok(data);
    },

    /** Puts an archived student back on the active roster. */
    async restore(id) {
      if (!id) return err('Missing student.');
      const { data, error } = await supabase.from('students')
        .update({ status: 'active', left_reason: null, left_date: null, left_notes: null }).eq('id', id).select().single();
      if (error) return err(error.message);
      return ok(data);
    },

    /** Move one or more students to a different class/stream at once — the
     *  "promotion day" case (moving a whole class up a grade), rather than
     *  editing students one at a time. */
    async bulkMove(payload) {
      payload = payload || {};
      const ids = Array.isArray(payload.student_ids) ? payload.student_ids.filter(Boolean) : [];
      if (!ids.length) return err('Choose at least one student to move.');
      if (!payload.class_id) return err('Please choose the class to move them to.');
      const rec = { class_id: payload.class_id, stream_id: payload.stream_id || null };
      const { error } = await supabase.from('students').update(rec).in('id', ids);
      if (error) return err(error.message);
      return ok(null, { moved: ids.length });
    },

    /**
     * Bulk-create students already validated + previewed client-side. Class
     * is chosen ONCE in the UI (never read from the uploaded file) — every
     * row is enrolled into it — but Stream is read PER ROW from the
     * spreadsheet's own "Stream" column (Round 2 §6: "add a 'Stream' column
     * directly into the bulk upload Excel template... so a single upload
     * can include students across multiple streams in one class at once").
     * Resolved server-side (not trusted from the client) by matching each
     * row's `stream` text against the class's real streams.
     *
     * Round 4 §1 (BUG): a blank Stream used to be silently allowed — now
     * it's rejected, and not just per-row: if EVEN ONE row in the whole file
     * has a blank stream, the ENTIRE import is refused up front (nothing
     * inserted at all), matching bulkUpload.mjs's client-side validateRow()
     * gate exactly rather than diverging from it. This mirrors what the
     * client already blocks at preview time, but re-checked here too since
     * this endpoint is never trusted to only ever be called through that UI.
     * rows: [{ admission_no, full_name, gender, stream, guardian_name?, guardian_contact? }]
     */
    async bulkCreate(payload) {
      payload = payload || {};
      if (!payload.class_id) return err('Please choose a class before importing.');
      const rows = Array.isArray(payload.rows) ? payload.rows : [];
      if (!rows.length) return err('No rows to import.');

      const blankStreamLines = rows
        .map((row, idx) => (String(row.stream || '').trim() ? null : idx + 1))
        .filter((line) => line !== null);
      if (blankStreamLines.length) {
        return err(`Import rejected — stream not filled for row(s) ${blankStreamLines.slice(0, 10).join(', ')}${blankStreamLines.length > 10 ? ', and more' : ''}. Every student needs an Arm before importing — fix the spreadsheet and re-upload.`);
      }

      const [{ data: existing }, { data: classStreams }] = await Promise.all([
        supabase.from('students').select('admission_no'),
        supabase.from('streams').select('id, name').eq('class_id', payload.class_id)
      ]);
      const existingSet = new Set((existing || []).map((r) => String(r.admission_no).toLowerCase()));
      const seenInBatch = new Set();
      const streamByName = {};
      (classStreams || []).forEach((s) => { streamByName[String(s.name).trim().toLowerCase()] = s.id; });

      const skipped = [];
      const toInsert = [];
      rows.forEach((row, idx) => {
        const line = idx + 1;
        const admissionNo = String(row.admission_no || '').trim();
        const fullName = String(row.full_name || '').trim();
        const gender = row.gender;
        if (!admissionNo || !fullName) {
          skipped.push({ line, admission_no: admissionNo, full_name: fullName, reason: 'Missing admission number or name.' });
          return;
        }
        if (VALID_GENDERS.indexOf(gender) === -1) {
          skipped.push({ line, admission_no: admissionNo, full_name: fullName, reason: 'Gender must be Male or Female.' });
          return;
        }
        const streamText = String(row.stream || '').trim();
        let streamId = null;
        if (streamText) {
          streamId = streamByName[streamText.toLowerCase()] || null;
          if (!streamId) {
            skipped.push({ line, admission_no: admissionNo, full_name: fullName, reason: `Arm "${streamText}" was not found for this class.` });
            return;
          }
        }
        const key = admissionNo.toLowerCase();
        if (existingSet.has(key) || seenInBatch.has(key)) {
          skipped.push({ line, admission_no: admissionNo, full_name: fullName, reason: 'Duplicate admission number.' });
          return;
        }
        seenInBatch.add(key);
        toInsert.push({
          admission_no: admissionNo, full_name: fullName, gender,
          class_id: payload.class_id, stream_id: streamId,
          guardian_name: row.guardian_name || '', guardian_contact: row.guardian_contact || '', status: 'active',
          // Richer bio-data — all optional, same field set as the single
          // Add Student form's "More details" section, so a bulk import can
          // fill in a full profile without a follow-up edit per student.
          date_of_birth: row.date_of_birth || null, admission_date: row.admission_date || null,
          upi_number: row.upi_number || '', assessment_number: row.assessment_number || '',
          previous_school: row.previous_school || '', guardian_relationship: row.guardian_relationship || '',
          guardian_id_number: row.guardian_id_number || '', medical_notes: row.medical_notes || ''
        });
      });

      let created = 0;
      let createdRows = [];
      if (toInsert.length) {
        const { data, error } = await supabase.from('students').insert(toInsert).select();
        if (error) return err('Import failed: ' + error.message);
        created = toInsert.length;
        createdRows = data || [];
      }
      // createdRows lets the caller provision a login for each new student
      // (see netlify/functions/README.md) without a second round-trip.
      return ok(null, { created, createdRows, skipped, total: rows.length });
    }
  };
}
