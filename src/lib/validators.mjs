/**
 * validators.mjs — small, pure, dependency-free string validators shared
 * between view code (immediate feedback) and the API layer (the actual
 * enforcement — a client-side check alone is never trusted).
 *
 * Round 2 brief §2 (BUG): a stream name like "Blue,Red" was accepted
 * without validation — the comma reads as if it's secretly two stream
 * names glued together, and nothing stopped it from being saved that way.
 * Fix: stream names (and anything else that's meant to be a short, plain
 * label rather than free text) are validated as letters, digits and single
 * spaces only — no commas, slashes, punctuation, etc.
 */

// Letters (any script covered by \p{L}), digits, and spaces only. \p{L}
// rather than a-zA-Z so a school using non-Latin class/stream names (e.g.
// Kiswahili) isn't wrongly rejected — the actual bug being fixed is
// "special characters", not "non-English".
const PLAIN_NAME_RE = /^[\p{L}\p{N} ]+$/u;

/** True for a non-empty string containing only letters/digits/spaces (after
 *  trimming). Used for stream names (brief §2) and anywhere else a short
 *  plain label, not free text, is expected. */
export function isPlainName(value) {
  const trimmed = String(value === undefined || value === null ? '' : value).trim();
  if (!trimmed) return false;
  return PLAIN_NAME_RE.test(trimmed);
}

/** Human-readable reason a plain-name check failed, for error messages —
 *  distinguishes "empty" from "has special characters" so the message
 *  actually helps the person fix it. */
export function plainNameError(value, label) {
  label = label || 'Name';
  const trimmed = String(value === undefined || value === null ? '' : value).trim();
  if (!trimmed) return `${label} is required.`;
  if (!PLAIN_NAME_RE.test(trimmed)) return `${label} can only contain letters, numbers and spaces — no commas or other special characters.`;
  return '';
}
