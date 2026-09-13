# ShuleTop Troubleshooting Playbook

Why this exists: the offline-banner bug took roughly 30 rounds to actually
fix. Nine different "fixes" (better connectivity checks, CSP corrections,
service worker changes, a full redesign) were all real, necessary
improvements — but none of them was the actual bug. The real cause was a
one-line CSS specificity conflict that none of those fixes touched. This
document captures what made that so slow, so next time something is
"stuck," you can hand this to Claude and skip most of the back-and-forth.

## Copy-paste prompt template

When something looks stuck, fill this in and send it as your first
message instead of just describing the symptom — it gives me everything
needed to start at step 3 of the checklist below instead of step 1:

```
Something looks stuck: [one line describing what you see, e.g. "the
offline banner won't disappear"]

Device(s): [phone app / desktop browser / both]
Did I push and deploy the last fix you sent? [yes/no — if unsure, say so]
Did I hard-refresh or restart the app after that deploy? [yes/no]

Console screenshot: [attach — F12 → Console tab, hard refresh first,
capture every line]

What I was doing when I saw it: [e.g. "just opened the app", "after
clicking Retry", "10 minutes into using it"]
```

## What to send me the moment something looks stuck

Send these together, in one message, before we start guessing:

1. **Which device(s)** — phone app, desktop browser, or both. These run
   completely different code environments (Android WebView vs. Chrome) and
   a fix confirmed on one does not guarantee the other.
2. **A screenshot of the actual broken screen**, not just a description.
3. **A screenshot of the browser console** (F12 → Console tab, hard
   refresh first) — every red line, not just the first one.
4. **Confirmation you actually pushed and deployed the fix already sent**
   — "did you push the last zip/files yet?" This alone accounted for
   several rounds in this saga. A fix sitting unpushed on your machine
   will never show up live no matter how many times it's tested.
5. **Whether a hard refresh / full app restart was tried** after that
   deploy — some fixes (service worker updates especially) need one full
   reload cycle to take effect, and that's expected, not a new bug.

With those four things up front, most "stuck" reports can be diagnosed in
one or two exchanges instead of thirty.

## Diagnostic order for "it looks stuck" bugs

Work through these roughly in order — cheapest/most-likely first:

1. **Was it actually deployed?** Check whether the fix was pushed to the
   real git remote and whether Netlify's deploy finished. A correct fix
   that never left the sandbox looks identical to a broken one from the
   user's side.
2. **Is the browser actually running the new code?** Fetch the live file
   directly (e.g. `fetch('/src/lib/whatever.js').then(r=>r.text())`) and
   check it contains the expected new logic, rather than assuming a
   deploy succeeded.
3. **Check the browser console for outright execution failures before
   debugging logic.** A Content-Security-Policy violation on an inline
   `<script>` block silently prevents that entire script from ever
   running — no error the user would notice, no crash, nothing in the UI.
   This site's CSP is deliberately strict (`script-src 'self'`, no
   `unsafe-inline`) — any new inline `<script>` block or inline
   `onclick=`/`onchange=`/etc. attribute breaks silently under it. Always
   use external `.js` files.
4. **If the JS logic seems to run but the UI doesn't visually reflect it,
   check computed style, not just the DOM property.** This was the actual
   bug: `element.hidden` correctly read `true`, proving the JavaScript
   logic worked — but the element still rendered because of a separate,
   conflicting inline `style="display:flex"` attribute. **An inline style
   always overrides the browser's default `[hidden]{display:none}` rule.**
   The lesson: when "the code runs but nothing visibly changes," check
   `getComputedStyle(el).display` (or take an actual screenshot / render
   a Playwright test), never just the property that the JS sets directly.
   Reading the DOM property back is not proof of what's on screen.
5. **Rule out the service worker as a source of staleness.** `sw.js` now
   uses network-first caching specifically so this class of bug can't
   recur, but if caching strategy ever changes again, remember:
   stale-while-revalidate always serves one load behind whatever was just
   deployed, which is indistinguishable from "the fix didn't work" during
   active, fast iteration.
6. **Rule out browser extensions before assuming it's app code.** A CSP
   violation or console error with **no source file/line listed** is the
   signature of a browser extension's injected script, not this app's
   code — extensions run in an isolated context Chrome doesn't attribute
   a location to. Chrome DevTools → the "Issues" tab (not just Console)
   shows "Affected Resources" with a source location when it's real app
   code; a blank source location means it's very likely an extension.
7. **Test in the same environment the user is reporting from.** A
   sandboxed/cloud test browser or a separate embedded browser pane is
   not the same as the user's actual daily Chrome profile (different
   extensions, different cached state, different service worker
   registration history) or their Android app (a completely different
   WebView runtime). "It works when I test it" only counts as proof for
   the exact environment tested.

## Case study: the offline banner saga, condensed

For reference, here's what actually happened, in order, so the pattern is
recognizable next time:

- **Symptom reported:** "You're offline" banner stuck showing even when
  connected, on phone and desktop, across many redeploys.
- **Fix attempt 1 (real, necessary, not the bug):** replaced the
  unreliable `navigator.onLine` check with a real network probe. Correct
  improvement, but written as an inline `<script>` block.
- **Fix attempt 2 (real, necessary, not the bug):** the banner's
  full-width top-bar layout was covering the mobile hamburger menu.
  Fixed the layout. Still an inline `<script>` block.
- **Fix attempt 3 (real, necessary, not the bug):** discovered via the
  live browser console that the site's CSP (`script-src 'self'`, no
  `unsafe-inline`) was silently blocking BOTH inline `<script>` blocks
  from ever executing at all. Moved them to external files. This felt
  like the root cause — proven by the console errors — but was actually
  necessary-but-insufficient: it made the logic finally *run*, which is
  not the same as making it *correct*.
- **Fix attempt 4 (real, necessary, not the bug):** the service worker
  was serving stale cached versions of the fixed files after every
  deploy (stale-while-revalidate). Switched to network-first caching.
- **Fix attempt 5 (redesign, not the bug):** simplified the full-width
  bar into a small corner toast per direct feedback.
- **Fix attempt 6 (real, necessary, not the bug):** the connectivity
  probe target (`/robots.txt`) was being blocked by something in the
  user's specific browser/network even though the rest of the app worked
  fine. Switched the probe to ping Supabase directly instead.
- **Still stuck.** At this point roughly 25+ rounds had passed. Every fix
  so far was independently correct and necessary, and none of them was
  wrong to make — but none of them touched the actual bug.
- **Actual root cause (fix attempt 7):** the banner's HTML had
  `display:flex` written directly into its `style="..."` attribute,
  right next to `hidden`. This is a pure CSS specificity conflict: an
  inline style always wins over the browser's own `[hidden]{display:none}`
  rule. `hide()` was correctly setting `banner.hidden = true` this ENTIRE
  TIME — every devtools check confirmed the attribute flipped correctly —
  but the element never stopped rendering because of the inline
  `display:flex`. This one-line CSS conflict had existed since before any
  of the above fixes were ever attempted.
- **What would have found it in round 1:** checking
  `getComputedStyle(element).display` (or an actual screenshot/render
  test) instead of `element.hidden`, the very first time the banner was
  reported stuck.

## Standing engagement rules (unchanged)

- Every commit is labeled "Version N," incrementing across the whole
  engagement.
- Every delivered zip/file set is a full project snapshot, not a diff,
  unless you've said otherwise.
- This sandbox cannot push to your real GitHub remote — I'll always give
  exact `git add / commit / push` commands, or (when your computer is
  connected) write the changed files directly onto your disk so you only
  need to run the git commands.
- I test in whatever browser/environment I have access to from here,
  which is not automatically the same as your daily browser or your
  phone app — a fix "confirmed working" from me means confirmed in that
  specific environment, not a guarantee across every device, until you
  confirm it too.
