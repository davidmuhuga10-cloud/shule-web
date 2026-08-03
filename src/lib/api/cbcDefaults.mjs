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
 *  names line up exactly the same way across the whole platform. */
export const STANDARD_CLASS_LEVELS = [
  'Daycare', 'PP1', 'PP2',
  'Grade 1', 'Grade 2', 'Grade 3', 'Grade 4', 'Grade 5', 'Grade 6',
  'Grade 7', 'Grade 8', 'Grade 9'
];

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
  return 'Junior Secondary';                // Grade 7-9
}
