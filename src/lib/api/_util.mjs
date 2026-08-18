/**
 * _util.mjs — small helpers shared by every data-access module.
 *
 * Caching (app-wide "fast as Finance" pass): every read-heavy API module
 * (finance.mjs, students.mjs, results.mjs, settings.mjs, academics.mjs,
 * dashboard.mjs, ...) memoizes its reads for CACHE_MS via createMemoCache()
 * below, so re-opening a screen or flipping between tabs within a few
 * seconds doesn't re-hit the database — same idea Finance shipped with.
 *
 * The hard part isn't caching reads, it's knowing when to invalidate: many
 * screens' cached reads (e.g. results.mjs's exam board) join across tables
 * OTHER modules write to (e.g. students.mjs writes `students`). Tracking
 * that per-table by hand is exactly what caused a real regression earlier
 * this round (a newly-enrolled student not showing up on the exam board for
 * up to 20 seconds) — a module's cache went stale because a DIFFERENT
 * module's write had no way to know it needed clearing.
 *
 * Fix: one global invalidation bus. Every module registers its cache's
 * clear() here via registerCache(), and every write anywhere calls
 * clearAllCaches() instead of trying to reason about which OTHER modules'
 * caches might depend on the table it just touched. Slightly broader than
 * strictly necessary (a Finance write also clears the unrelated Academics
 * cache), but that costs a few extra cache misses within the same 20-second
 * window — trivial — versus the alternative of a subtly wrong, hand-
 * maintained dependency graph that's one missed edge away from showing
 * stale data on a screen that matters (money, marks, rosters).
 */
const registeredCaches = [];
export function registerCache(clearFn) { registeredCaches.push(clearFn); }
export function clearAllCaches() { registeredCaches.forEach((fn) => fn()); }

/** Creates a self-contained short-window memoization cache and registers it
 *  on the global invalidation bus. Call the returned `cached(name, args, fn)`
 *  around any read; call `clear()` after any write IN THIS module (clearing
 *  every OTHER registered module's cache too, via clearAllCaches(), is what
 *  actually keeps things correct — clear() alone only clears this one). Most
 *  callers should call clearAllCaches() directly after a write rather than
 *  this module-local clear(), for exactly that reason. */
export function createMemoCache(ttlMs) {
  const ttl = ttlMs || 20000;
  const map = new Map();
  function key(name, args) { return name + '|' + JSON.stringify(args === undefined ? null : args); }
  async function cached(name, args, fn) {
    const k = key(name, args);
    const hit = map.get(k);
    if (hit && Date.now() - hit.at < ttl) return hit.value;
    const value = await fn();
    if (value && value.ok) map.set(k, { at: Date.now(), value });
    return value;
  }
  function clear() { map.clear(); }
  registerCache(clear);
  return { cached, clear };
}

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
