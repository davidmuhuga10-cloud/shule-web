/**
 * navIntent.mjs — a tiny in-memory handoff for "take me straight there,
 * already filled in" navigation between views.
 *
 * The app's router is plain hash routing (`location.hash = '#/route'`) with
 * no query-string support (see app.js's go()/router()) — there was never a
 * way to say "go to Enter Marks, and pre-select this exam/class" without
 * either adding URL params app-wide or a shared bit of state. This module is
 * that shared state: one view sets an intent right before calling go(),
 * the next view's mount takes (reads + clears) it if present, and falls
 * back to its normal empty-selection start screen if nothing was set —
 * so nothing behaves differently for the direct-nav case (clicking the
 * sidebar link) versus the guided-handoff case (clicking "Enter Marks").
 *
 * Intentionally NOT persisted (no localStorage — see the artifacts
 * restriction elsewhere in this app for why, but also this genuinely should
 * NOT survive a page reload; it's a same-session, one-shot signal only).
 */
let pending = null;

/** Stash a selection for the next view to pick up. Overwrites any unread
 *  previous intent — only the most recent "take me there" wins. */
export function setNavIntent(key, payload) {
  pending = { key, payload };
}

/** Read and clear the pending intent if it matches `key`; returns null
 *  otherwise (including when nothing was pending, or it was meant for a
 *  different view). Clearing on read means navigating away and back later
 *  starts fresh, exactly like landing on the page any other way. */
export function takeNavIntent(key) {
  if (!pending || pending.key !== key) return null;
  const payload = pending.payload;
  pending = null;
  return payload;
}
