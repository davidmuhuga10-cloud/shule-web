import { showPapersSeparately, orderSubjects, applyMeritListDisplayPrefs } from '../src/lib/meritListPrefs.mjs';

let passed = 0, failed = 0;
function check(name, cond) { if (cond) passed++; else { failed++; console.error('FAIL:', name); } }

function run() {
  // ---- showPapersSeparately (Round 2 §1) -----------------------------------------
  check('defaults to true when the key is genuinely missing (UNLIKE other toggles)', showPapersSeparately({}) === true);
  check('true when explicitly "true"', showPapersSeparately({ show_papers_separately: 'true' }) === true);
  check('false when explicitly "false"', showPapersSeparately({ show_papers_separately: 'false' }) === false);

  // ---- orderSubjects (Round 2 §2) --------------------------------------------------
  const subjects = [{ id: 'a', name: 'Art' }, { id: 'b', name: 'Biology' }, { id: 'c', name: 'Chemistry' }];
  check('leaves order unchanged when the toggle is off', orderSubjects({ use_custom_subject_order: 'false' }, subjects).map((s) => s.id).join(',') === 'a,b,c');
  check('leaves order unchanged when the setting is entirely absent', orderSubjects({}, subjects).map((s) => s.id).join(',') === 'a,b,c');

  const reordered = orderSubjects({ use_custom_subject_order: 'true', subject_order: JSON.stringify(['c', 'a', 'b']) }, subjects);
  check('reorders subjects to match the saved order when the toggle is on', reordered.map((s) => s.id).join(',') === 'c,a,b');

  const partial = orderSubjects({ use_custom_subject_order: 'true', subject_order: JSON.stringify(['b']) }, subjects);
  check('a subject not in the saved order is appended at the end, not dropped', partial.length === 3 && partial[0].id === 'b' && partial.slice(1).map((s) => s.id).sort().join(',') === 'a,c');

  const badJson = orderSubjects({ use_custom_subject_order: 'true', subject_order: 'not json' }, subjects);
  check('malformed subject_order JSON falls back to the original order rather than throwing', badJson.map((s) => s.id).join(',') === 'a,b,c');

  // ---- applyMeritListDisplayPrefs (both combined) ----------------------------------
  const withPapers = [
    { id: 'eng', name: 'English', papers: [{ id: 'p1', name: 'P1' }, { id: 'p2', name: 'P2' }] },
    { id: 'mat', name: 'Mathematics', papers: [] }
  ];
  const on = applyMeritListDisplayPrefs(withPapers, {});
  check('papers stay expanded when show_papers_separately is on (default)', on.find((s) => s.id === 'eng').papers.length === 2);

  const off = applyMeritListDisplayPrefs(withPapers, { show_papers_separately: 'false' });
  check('papers collapse to a single column when show_papers_separately is off', off.find((s) => s.id === 'eng').papers.length === 0);
  check('a subject with no papers is unaffected either way', off.find((s) => s.id === 'mat').papers.length === 0);
  check('turning papers off does not mutate the original input array', withPapers.find((s) => s.id === 'eng').papers.length === 2);

  const combined = applyMeritListDisplayPrefs(withPapers, { show_papers_separately: 'false', use_custom_subject_order: 'true', subject_order: JSON.stringify(['mat', 'eng']) });
  check('both prefs apply together — reordered AND papers collapsed', combined.map((s) => s.id).join(',') === 'mat,eng' && combined.find((s) => s.id === 'eng').papers.length === 0);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

run();
