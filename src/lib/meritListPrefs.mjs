/**
 * meritListPrefs.mjs — pure, testable logic for the Mark List's two Round 2
 * Permissions toggles (§1 "Show subject papers separately", §2 "Custom
 * subject ordering"). Kept separate from views/broadsheet.mjs (which
 * imports app.js and so can't be unit-tested directly) — same
 * pure-core/browser-wrapper split as broadsheetXlsx.mjs/broadsheetSummary.mjs.
 */

/** §1: "Show subject papers separately on the Mark List" — defaults to
 *  true (UNLIKE every other Permissions toggle in this app) when the key is
 *  genuinely missing, so an existing school from before this setting
 *  existed keeps seeing papers split out exactly as before, rather than
 *  silently losing that view. See settings.mjs's comment on this key. */
export function showPapersSeparately(settings) {
  settings = settings || {};
  return settings.show_papers_separately === undefined ? true : String(settings.show_papers_separately) === 'true';
}

/** §2: "Custom Subject Ordering on Mark List" — off by default (normal
 *  system order). When on, sorts `subjects` by the school's saved
 *  subject_order (a JSON array of subject ids); any subject not in that
 *  list (added since the order was last set) falls back to its original
 *  position, appended after every explicitly-ordered subject — never
 *  silently dropped from the Mark List. */
export function orderSubjects(settings, subjects) {
  settings = settings || {};
  subjects = subjects || [];
  if (String(settings.use_custom_subject_order) !== 'true') return subjects;
  let order = [];
  try { order = JSON.parse(settings.subject_order || '[]'); } catch (e) { order = []; }
  const rank = {}; order.forEach((id, i) => { rank[id] = i; });
  return subjects.slice().sort((a, b) => {
    const ra = rank[a.id], rb = rank[b.id];
    if (ra === undefined && rb === undefined) return 0;
    if (ra === undefined) return 1;
    if (rb === undefined) return -1;
    return ra - rb;
  });
}

/** Applies both preferences in one call — the single place broadsheet.mjs
 *  calls once, right after fetching, so the on-screen grid and the Excel
 *  export both work from the exact same already-adjusted subjects list and
 *  can never disagree with each other. When papers are folded into a
 *  single column, this only strips the DISPLAY-only `papers` array — the
 *  combined score itself (student.scores[sub.id]) is untouched, since
 *  getBroadsheet()'s combination math already produces it regardless of
 *  this purely cosmetic toggle. */
export function applyMeritListDisplayPrefs(subjects, settings) {
  let out = subjects || [];
  if (!showPapersSeparately(settings)) out = out.map((s) => ({ ...s, papers: [] }));
  return orderSubjects(settings, out);
}
