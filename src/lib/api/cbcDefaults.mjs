/**
 * cbcDefaults.mjs
 * ----------------------------------------------------------------------------
 * Shared, side-effect-free CBC (Kenyan Competency-Based Curriculum) reference
 * data: the official KICD learning-area list per level, the fixed class-level
 * list, and a helper mapping a class name to its CBC level bucket.
 *
 * Pulled out of academics.mjs (which re-exports these same names for
 * backward compatibility with existing imports) so that assignments.mjs can
 * also depend on it — for auto-seeding a new stream's default subjects
 * (Phase 2g / brief §4.2) — WITHOUT academics.mjs and assignments.mjs
 * importing each other (which would be circular: assignments.mjs needs this
 * CBC data, and academics.mjs's streams.save() needs assignments.mjs's
 * seeding helper).
 * ----------------------------------------------------------------------------
 */

/** Official Kenyan CBC learning areas (KICD), per level, including the 2024
 *  Junior Secondary rationalisation to 9 core subjects. */
export const CBC_LEVELS = ['Pre-Primary', 'Lower Primary', 'Upper Primary', 'Junior Secondary'];

/** The 12 standard class levels this product supports, Daycare through
 *  Grade 9 (CBC pre-primary through junior secondary). A class is chosen
 *  from this fixed list rather than typed freehand, so every school's class
 *  names line up exactly the same way across the whole platform.
 *
 *  Next Sprint 3 §1: Senior School (Grade 10-12) and Form 3/4 (8-4-4
 *  legacy) are APPENDED here, not inserted or kept as a separate array —
 *  every existing school's level_order (classes.save() derives it as
 *  `1 + index in this list`, so Daycare=1 ... Grade 9=12 exactly as
 *  before) stays untouched, and a 'senior' category school just uses the
 *  tail end of this same list. This is what brief §1.1 means by "combined
 *  under the same school account, not treated as two separate products" —
 *  one list, one level_order scheme, for every school. Which slice of it a
 *  given school is OFFERED (not restricted to — see classLevelsForCategory
 *  below) is a UI convenience driven by schools.category. */
export const STANDARD_CLASS_LEVELS = [
  'Daycare', 'PP1', 'PP2',
  'Grade 1', 'Grade 2', 'Grade 3', 'Grade 4', 'Grade 5', 'Grade 6',
  'Grade 7', 'Grade 8', 'Grade 9',
  'Grade 10', 'Grade 11', 'Grade 12', 'Form 3', 'Form 4'
];

/** The slice of STANDARD_CLASS_LEVELS a 'pri_jss' category school picks a
 *  new class name from — Daycare through Grade 9, exactly what this product
 *  supported before Senior School existed. */
export const PRI_JSS_CLASS_LEVELS = STANDARD_CLASS_LEVELS.slice(0, 12);

/** The slice a 'senior' category school picks from instead — CBC Grade
 *  10-12 (pathway-based) and the two remaining legacy 8-4-4 cohorts,
 *  Form 3/4 (brief §1.1: real schools still have Form 3/4 students during
 *  the gradual transition, so both must be selectable on one account). */
export const SENIOR_CLASS_LEVELS = STANDARD_CLASS_LEVELS.slice(12);

/** Which class-level list a school's "Add class" / "Bulk Add Classes"
 *  pickers should offer, based on schools.category (brief §1.2). Not an
 *  enforcement boundary — see the header comment on STANDARD_CLASS_LEVELS —
 *  just which of the two slices is the sensible default for that school's
 *  admin to choose from. Unrecognised/missing category (e.g. a school row
 *  from before this column existed) falls back to 'pri_jss', matching the
 *  column's own default. */
export function classLevelsForCategory(category) {
  return category === 'senior' ? SENIOR_CLASS_LEVELS : PRI_JSS_CLASS_LEVELS;
}

/** The three Senior School pathways (brief §1.3) every Grade 10-12 student
 *  chooses between — never applicable to Form 3/4 (8-4-4 has no pathway
 *  concept) or to any Pri/Jss class. */
export const PATHWAYS = ['STEM', 'Social Sciences', 'Arts and Sports Science'];

export const CBC_SUBJECTS = [
  { name: 'Language Activities', level: 'Pre-Primary' },
  { name: 'Mathematical Activities', level: 'Pre-Primary' },
  { name: 'Environmental Activities', level: 'Pre-Primary' },
  { name: 'Psychomotor and Creative Activities', level: 'Pre-Primary' },
  { name: 'Religious Education Activities', level: 'Pre-Primary' },
  { name: 'Literacy Activities', level: 'Lower Primary' },
  { name: 'English Language Activities', level: 'Lower Primary' },
  { name: 'Kiswahili Language Activities', level: 'Lower Primary' },
  { name: 'Indigenous Language Activities', level: 'Lower Primary' },
  { name: 'Mathematical Activities', level: 'Lower Primary' },
  { name: 'Environmental Activities', level: 'Lower Primary' },
  { name: 'Hygiene and Nutrition Activities', level: 'Lower Primary' },
  { name: 'Religious Education', level: 'Lower Primary' },
  { name: 'Movement and Creative Activities', level: 'Lower Primary' },
  { name: 'English', level: 'Upper Primary' },
  { name: 'Kiswahili', level: 'Upper Primary' },
  { name: 'Mathematics', level: 'Upper Primary' },
  { name: 'Science and Technology', level: 'Upper Primary' },
  { name: 'Social Studies', level: 'Upper Primary' },
  { name: 'Religious Education', level: 'Upper Primary' },
  { name: 'Agriculture', level: 'Upper Primary' },
  { name: 'Home Science', level: 'Upper Primary' },
  { name: 'Creative Arts', level: 'Upper Primary' },
  { name: 'Physical and Health Education', level: 'Upper Primary' },
  { name: 'English', level: 'Junior Secondary' },
  { name: 'Kiswahili', level: 'Junior Secondary' },
  { name: 'Mathematics', level: 'Junior Secondary' },
  { name: 'Integrated Science', level: 'Junior Secondary' },
  { name: 'Pre-Technical Studies', level: 'Junior Secondary' },
  { name: 'Social Studies', level: 'Junior Secondary' },
  { name: 'Agriculture', level: 'Junior Secondary' },
  { name: 'Religious Education', level: 'Junior Secondary' },
  { name: 'Creative Arts and Sports', level: 'Junior Secondary' }
];

/** Maps a class name (e.g. "Grade 8", "PP1") to its CBC level bucket, so a
 *  brand-new stream can be auto-populated with the correct default subject
 *  set for its grade (brief §4.2: "please research the correct default
 *  subject set per grade level rather than guessing"). Returns null for a
 *  non-standard/custom class name — no defaults are guessed in that case. */
export function levelBucketForClassName(name) {
  const idx = STANDARD_CLASS_LEVELS.findIndex((n) => n.toLowerCase() === String(name || '').trim().toLowerCase());
  if (idx === -1) return null;
  if (idx <= 2) return 'Pre-Primary';       // Daycare, PP1, PP2
  if (idx <= 5) return 'Lower Primary';     // Grade 1-3
  if (idx <= 8) return 'Upper Primary';     // Grade 4-6
  if (idx <= 11) return 'Junior Secondary'; // Grade 7-9
  if (idx <= 14) return 'Senior Secondary'; // Grade 10-12 (Next Sprint 3 §1.3)
  return 'Form 3-4';                        // Form 3, Form 4 (Next Sprint 3 §1.4)
}

/** Core Senior Secondary subjects EVERY Grade 10-12 student takes,
 *  regardless of pathway (brief §1.3). NOTE (SignUp_Fixes §3): there is no
 *  single generic "Mathematics" subject at Senior School level — per KICD,
 *  Mathematics splits into two distinct, differently-named subjects by
 *  pathway ("Core Mathematics" for STEM, "Essential Mathematics" for Social
 *  Sciences and Arts and Sports Science), so Mathematics is NOT in this
 *  shared core list — it lives in SENIOR_SECONDARY_PATHWAY_SUBJECTS below,
 *  once per pathway, under its pathway-correct name. */
export const SENIOR_SECONDARY_CORE_SUBJECTS = [
  'English', 'Kiswahili (or Kenyan Sign Language)', 'Community Service Learning'
];

/** Each pathway's own specialised subjects, on top of the core list above —
 *  standard KICD-aligned lists (brief §1.3: "these differ meaningfully from
 *  Junior School's subject list and need their own setup"). Schools can add
 *  to or edit this from the Classes screen's "+ Add subject" picker same as
 *  any other subject — this is only the starting default.
 *  SignUp_Fixes §3: Mathematics is two separate, correctly-named subjects,
 *  not one subject with a difficulty label — "Core Mathematics" for STEM,
 *  "Essential Mathematics" for Social Sciences AND Arts and Sports Science. */
export const SENIOR_SECONDARY_PATHWAY_SUBJECTS = {
  'STEM': ['Physics', 'Chemistry', 'Biology', 'Core Mathematics', 'Computer Studies', 'Agriculture', 'Home Science'],
  'Social Sciences': ['History and Citizenship', 'Geography', 'Christian Religious Education', 'Business Studies', 'Literature in English', 'Fasihi ya Kiswahili', 'Essential Mathematics'],
  'Arts and Sports Science': ['Music and Dance', 'Fine Arts', 'Theatre and Film', 'Sports and Recreation', 'Physical Education', 'Essential Mathematics']
};

/** Form 3/4 (8-4-4 legacy) subjects — one fixed full list, no pathways
 *  (brief §1.4: "these follow the traditional 8-4-4 subject list a student
 *  takes as a full set"). Standard list; also editable per school. */
export const FORM_3_4_SUBJECTS = [
  'English', 'Kiswahili', 'Mathematics', 'Biology', 'Chemistry', 'Physics',
  'History and Government', 'Geography', 'Christian Religious Education',
  'Agriculture', 'Business Studies', 'Computer Studies', 'Home Science'
];

/** Returns the default subject set — as `{ name, pathway }` pairs, ready to
 *  insert straight into `subjects` — for a brand-new stream at the given
 *  level bucket. Senior Secondary needs BOTH the 4 core subjects (pathway:
 *  null) AND that stream's own pathway's specialised ones (pathway: the
 *  pathway name) — brief §1.3: "subjects genuinely differ by pathway...
 *  need to work correctly per-pathway at Senior School level, not just
 *  per-class". A Senior Secondary stream with no pathway assigned yet gets
 *  just the core 4 — see classes.mjs, which requires picking a pathway when
 *  adding a Grade 10-12 stream, so this is really only reachable
 *  transiently. Form 3-4 and every Pri/Jss level keep pathway: null
 *  throughout, same as before this feature existed. */
export function defaultSubjectsFor(level, pathway) {
  if (level === 'Senior Secondary') {
    const core = SENIOR_SECONDARY_CORE_SUBJECTS.map((name) => ({ name, pathway: null }));
    const specialised = (pathway && SENIOR_SECONDARY_PATHWAY_SUBJECTS[pathway] || []).map((name) => ({ name, pathway }));
    return [...core, ...specialised];
  }
  if (level === 'Form 3-4') return FORM_3_4_SUBJECTS.map((name) => ({ name, pathway: null }));
  return CBC_SUBJECTS.filter((s) => s.level === level).map((s) => ({ name: s.name, pathway: null }));
}
