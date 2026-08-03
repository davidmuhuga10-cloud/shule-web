/**
 * _util.mjs — small helpers shared by every data-access module.
 */
export function ok(data, extra) {
  return Object.assign({ ok: true, data }, extra || {});
}
export function err(message) {
  return { ok: false, message };
}
/** Wrap a Supabase {data,error} result into our {ok,data|message} shape. */
export function fromResult({ data, error }, extra) {
  if (error) return err(error.message || String(error));
  return ok(data, extra);
}

/** Numeric-aware admission-number value — mirrors admissionNumber_() /
 *  admission_no_numeric() in the Apps Script and SQL versions, so client-side
 *  sorts (e.g. a freshly-filtered list before another server round trip)
 *  match the database's own ordering. */
export function admissionNumberValue(v) {
  const digits = String(v || '').replace(/[^0-9]/g, '');
  return digits ? parseInt(digits, 10) : Number.MAX_SAFE_INTEGER;
}

export function byAdmissionNo(a, b) {
  const na = admissionNumberValue(a.admission_no), nb = admissionNumberValue(b.admission_no);
  if (na !== nb) return na - nb;
  return String(a.admission_no).localeCompare(String(b.admission_no));
}

/** Title-cases a name (school name, etc.) — "green hill academy" ->
 *  "Green Hill Academy" — regardless of how it was typed/originally saved.
 *  Small words that read oddly capitalized on their own ("of", "the", "and")
 *  stay lowercase unless they're the first word, matching normal title-case
 *  convention. */
const TITLECASE_MINOR_WORDS = new Set(['of', 'the', 'and', 'for', 'a', 'an', 'in', 'on']);
export function titleCase(str) {
  const s = String(str || '').trim();
  if (!s) return s;
  return s.toLowerCase().split(/\s+/).map((word, i) => {
    if (i > 0 && TITLECASE_MINOR_WORDS.has(word)) return word;
    return word.replace(/[a-z]/i, (c) => c.toUpperCase());
  }).join(' ');
}

export function indexById(rows) {
  const map = {};
  (rows || []).forEach((r) => { map[r.id] = r; });
  return map;
}

/** Grade a numeric score against a set of {min_score,max_score,grade_label,points,remark} bands. */
export function gradeScore(score, bands) {
  const s = Number(score);
  if (isNaN(s)) return { grade_label: '', points: '', remark: '' };
  const hit = (bands || []).find((b) => s >= Number(b.min_score) && s <= Number(b.max_score));
  return hit
    ? { grade_label: hit.grade_label, points: hit.points, remark: hit.remark }
    : { grade_label: '', points: '', remark: '' };
}
