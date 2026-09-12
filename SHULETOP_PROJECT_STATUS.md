# ShuleTop — Project Status

**Last updated:** September 12, 2026
**Current version:** Version 43
**This file's purpose:** Upload this document into a new Claude session at any time and it will fully understand where the project stands — what's built, what's pending, and what's left specifically for the Google Play Store submission. Nothing here is guesswork; it reflects exactly what was done.

---

## 1. What ShuleTop is

ShuleTop is a school management + finance ERP system built for Kenyan schools (CBC curriculum), covering student records, exams/report cards, fee collection, timetables, staff/payroll, inventory, and SMS communication with parents/guardians (via Africa's Talking). It's a web app (Supabase backend, hosted on Netlify at **shuletop.com**) with a native Android wrapper (Capacitor) so it can also be distributed as a Play Store app.

It is live in production for a real school: **Bright Minds Academy**.

**Important correction on record:** Bright Minds Academy, despite being referred to earlier as "the live production school," is actually a **fake/demo school** — not real student or financial data. This means it can be used directly as the login Google's Play Store reviewer uses, with no need to build a separate demo account.

---

## 2. Standing rules for this engagement (apply to every future session)

- Every commit is labeled **"Version N"**, incrementing across the whole engagement — currently at **Version 43**.
- Every delivered zip is named with its version number.
- The Claude sandbox **cannot push to the real GitHub remote** (`https://github.com/davidmuhuga10-cloud/shule-web.git`) — no authorized credentials. Claude always gives exact `git` commands for the user to run themselves.
- User's workflow: unzip the delivered zip **over** their local `shule-web` folder (overwrite), then run the git commands themselves.
- Claude proactively looks for and fixes bugs/compliance issues without being asked.
- Claude shows verification/proof before shipping (test runs, screenshots, etc.).
- Every commit carries this attribution trailer:
  ```
  Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01AAm4JdqQ4FLv5cgu9TubmB
  ```
- Claude never runs destructive/irreversible database operations directly — read-only queries only.
- Never give a Play Store reviewer real Bright Minds Academy credentials for anything that *is* real (this no longer applies to login access itself, per the correction above, but still applies if any other real school ever gets fully onboarded).

---

## 3. ⚠️ Unpushed commits — action needed regardless of what we build next

As of this writing, the local sandbox repo is **22 commits ahead of `origin/main`** (Versions 22 through 43). These are safe and committed locally, but **not yet on GitHub** because the sandbox has no push access. Whenever convenient, run this on your own machine (in your local `shule-web` folder, after unzipping the latest delivered version on top of it):

```
git add -A
git commit -m "Sync through Version 43"
git push origin main
```

If `git push` asks for a password, GitHub requires a personal access token now (not your account password) — ask Claude to walk through generating one if needed.

---

## 4. Play Store readiness — full picture

### ✅ Already done (code-complete, shipped in Version 41–43)

| Item | Status | Details |
|---|---|---|
| Native Android wrapper (Capacitor) | ✅ Done | `appId: com.shuletop.app`, points at live site via `server.url`, so website updates auto-propagate to installed apps with no re-submission needed |
| App icon | ✅ Done | Final design "9E" — deep green gradient, white ring, soft shadow (adaptive icon, works under any launcher mask shape) |
| Target API level | ✅ Compliant | API 36 (Android 16) — meets Google's Aug 31, 2026 deadline already |
| Privacy policy | ✅ Done | Live at `shuletop.com/privacy.html`, tailored to actual data practices (Supabase, Africa's Talking, Netlify named as processors) |
| Account/data deletion | ✅ Done | `shuletop.com/account-deletion.html` + in-app "Delete Account / Data" link in user menu; request-based flow (2-day verification, 30-day completion) |
| Minimum-functionality / anti-webview-rejection | ✅ Done | Offline banner (shows/hides with connectivity, Retry button), native back-button handling, native status bar |
| `privacy@shuletop.com` email forwarding | ✅ Done | Cloudflare Email Routing configured and **verified working** — forwards to davidmuhuga10@gmail.com |
| Debug APK | ✅ Built & shared | Built and shared with the user via WhatsApp for informal testing (NOT the Play Store submission build — that needs a signed release, see below) |

### 🔲 Still needed (things only the account owner can do — paused for now per user's request)

1. **Demo/reviewer account** — ~~build a separate fake school~~ **no longer needed** — Bright Minds Academy is already fake data and can be used directly. Just double-check before submitting: no 2FA/OTP required (or explain the bypass), no real phone numbers wired to SMS features, and a reasonably strong password.
2. **Signing key + signed release build** — Generate a keystore in Android Studio (Build → Generate Signed App Bundle or APK). This is different from the debug APK already built. **The keystore file must be saved somewhere safe and backed up — losing it means the app can never be updated again on Play Store.**
3. **Play Console account** — $25 one-time registration at play.google.com/console (if not already done).
4. **Store listing** — App name (ShuleTop), short + full description, screenshots (2–8, from a real device running the app), feature graphic (1024×500 banner). Claude offered to draft the description text and design the feature graphic — not yet done.
5. **Content rating questionnaire** — Must select **adults/general audience**, NOT "primarily child-directed" (even though the app stores data about students who are minors — the app itself is a professional tool used by adult staff). Answer "yes" honestly to "does your app collect data about children" (different question from "is it directed at children").
6. **Data Safety form** — Must match the privacy policy exactly: personal info (name/phone/email) collected, not shared for ads; financial info collected; list Supabase + Africa's Talking as processors; link to `shuletop.com/privacy.html` and `shuletop.com/account-deletion.html`.
7. **Category & listing framing** — "Education" or "Business" category; word the listing as "for school administrators and staff," not implying direct student/child use — keeps the app outside Google's stricter Families policy.

**Status: paused.** The user wants a break from Play Store work to focus on other app updates. Nothing above is blocking — resume anytime by asking Claude to continue from this list.

---

## 5. Key technical facts (for quick reference in a future session)

- **Repo (local sandbox):** `/home/claude/shule-web`, tracked git repo, remote `origin` = `https://github.com/davidmuhuga10-cloud/shule-web.git`, branch `main`.
- **Live site:** https://shuletop.com (Netlify-hosted, Supabase backend).
- **Capacitor config:** `appId: com.shuletop.app`, `appName: ShuleTop`, `server.url: https://shuletop.com` — meaning the native app is a live wrapper; website-level changes (removing a module, changing a chart type, etc.) reach every installed app instantly with **zero Play Store involvement**. Only native-shell changes (icon, permissions, native plugins) require a new signed build + re-review.
- **Android native project:** `/home/claude/shule-web/android/` — `minSdkVersion=24`, `compileSdkVersion=36`, `targetSdkVersion=36`. Only permission requested: `INTERNET`.
- **SMS provider:** Africa's Talking (confirmed in `netlify/functions/_lib/smsProvider.js`).
- **Latest delivered zips:** `shule-web-v41-mobile.zip`, `shule-web-v42-app-icon.zip`, `shule-web-v43-playstore-compliance.zip`.
- **Version counter:** currently **43** — the next code change of any kind should be committed as "Version 44."

---

## 6. What to tell Claude when you're ready to resume Play Store work

Just say something like: *"Let's continue the Play Store checklist — I want to do the signing key next"* or *"draft the store listing text and feature graphic."* Upload this file first if you're in a new session so there's no need to re-explain any of the above.

---

## 7. What's next right now

Per your latest request, we're pausing Play Store work and moving to other app updates/features. Let Claude know what you'd like to work on next.
