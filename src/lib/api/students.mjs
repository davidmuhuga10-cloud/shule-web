/**
 * students.mjs — Supabase equivalent of Students.gs.
 */
import { ok, err, byAdmissionNo } from './_util.mjs';

const VALID_GENDERS = ['Male', 'Female'];

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

    async get(id) {
      const { data, error } = await supabase.from('students').select('*').eq('id', id).maybeSingle();
      if (error) return err(error.message);
      if (!data) return err('Student not found.');
      const [withN] = await withNames([data]);
      return ok(withN);
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

      const rec = {
        admission_no: admissionNo,
        full_name: fullName,
        gender,
        class_id: payload.class_id,
        stream_id: payload.stream_id || null,
        guardian_name: payload.guardian_name || '',
        guardian_contact: payload.guardian_contact || '',
        status: payload.status || 'active'
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

    async remove(id) {
      const { error } = await supabase.from('students').delete().eq('id', id);
      if (error) return err(error.message);
      return ok(true);
    },

    /**
     * Bulk-create students already validated + previewed client-side. Class
     * and stream are chosen ONCE in the UI (never read from the uploaded
     * file), matching the Apps Script version's bulkCreateStudents.
     * rows: [{ admission_no, full_name, gender, guardian_name?, guardian_contact? }]
     */
    async bulkCreate(payload) {
      payload = payload || {};
      if (!payload.class_id) return err('Please choose a class before importing.');
      const rows = Array.isArray(payload.rows) ? payload.rows : [];
      if (!rows.length) return err('No rows to import.');

      const { data: existing } = await supabase.from('students').select('admission_no');
      const existingSet = new Set((existing || []).map((r) => String(r.admission_no).toLowerCase()));
      const seenInBatch = new Set();

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
        const key = admissionNo.toLowerCase();
        if (existingSet.has(key) || seenInBatch.has(key)) {
          skipped.push({ line, admission_no: admissionNo, full_name: fullName, reason: 'Duplicate admission number.' });
          return;
        }
        seenInBatch.add(key);
        toInsert.push({
          admission_no: admissionNo, full_name: fullName, gender,
          class_id: payload.class_id, stream_id: payload.stream_id || null,
          guardian_name: row.guardian_name || '', guardian_contact: row.guardian_contact || '', status: 'active'
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
