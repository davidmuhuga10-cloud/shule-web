# Shule — Product & Engineering Roadmap

**Owner:** Engineering / Product Lead (this document is written from that seat, as requested)
**Status:** Living document. First full draft. Supersedes ad-hoc planning notes.
**Inputs:** Zeraki Analytics Complete User Manual (authoritative), Zeraki Analytics Manual 2025 (supplementary detail on Departments, Subject Groupings, Behaviour, Assessment/CBC rubrics, Timetable, Leave Outs/Checkout, Opportunities), plus a full audit of the current Shule codebase (`supabase/schema.sql`, `src/lib/api/*`, `src/views/*`).

---

## 0. How to read this document

This is not a feature wishlist. It's a sequenced plan, in the order I would actually build it if this were my company, with the reasoning shown so it can be challenged. Section 3 is the most important section in the document — everything else is downstream of that decision. If you read nothing else, read Section 3 and Section 7.

---

## 1. Executive Summary

**Zeraki Analytics** is the entrenched incumbent in Kenyan (and increasingly wider East/pan-African) school management software. Based on the manuals: it's a mature, multi-module platform (Dashboard, Calendar, Classes, Learning Areas, Students, Teachers, BOM/PA, Staff, Exams, Attendance, Messaging, Printouts, Billing, Settings, plus a separate Timetable product, a Behaviour module, an Assessment/CBC-rubric module, and even a teacher job board). It has telco-integrated SMS billing (M-Pesa STK push), a hierarchical exam-publishing workflow, per-country grading systems (Kenya, Uganda, Tanzania, and others), and — critically — a support/security model built for a company operating at scale across thousands of school accounts (token-based agent access, audit logging, MFA, regulatory SMS opt-out compliance).

**Shule today** is a well-engineered, thoroughly-tested, *single-school* deployment: a static SPA on Supabase (Postgres + Auth + RLS) + Netlify Functions, covering the academic core — classes/streams, subjects, students, staff, teacher assignments, grading scales, exams, marks entry, mark lists, report cards, and a student portal. Every line of it is unit-tested and was verified end-to-end in a real browser before shipping. That discipline is worth preserving as we scale up scope — it's a real advantage over sloppier competitors, and I intend to keep it non-negotiable through every phase below.

Here is the plain assessment I'd be failing you as a technical lead not to state up front: **60% market share from an incumbent like this in 3 years is an extremely aggressive target.** Zeraki has years of distribution relationships, county-level relationships, telco billing integration, and switching costs (schools don't love re-training staff or re-importing years of historical results). Market share at that scale is won more by sales motion, pricing, support quality, and a frictionless migration path *off* Zeraki than by feature-for-feature parity alone. I will not pretend otherwise. What I *can* guarantee, and what this roadmap is built around, is: the product will never be the reason we lose a deal, and our architecture will let us serve an order of magnitude more schools per engineer than a legacy competitor can, which is what actually makes an aggressive share target financeable.

**The single highest-leverage decision in this whole roadmap, ahead of any feature work:** Shule is not currently a SaaS product. It's a single-tenant application that gets deployed once per customer (one Supabase project, one Netlify site, one `config.js`, per school). That was the *correct* choice for Phase 1–3 (prove the product works, ship fast, for one real school). It is the *wrong* foundation for "serve hundreds or thousands of schools." Every feature we bolt onto the current schema makes the eventual multi-tenancy migration more expensive. I am treating that migration as Phase 0, ahead of any Zeraki-parity feature — see Section 3 for the full reasoning, and Section 11 for the one thing I need from you before I start it.

---

## 2. Where Shule Stands Today — Honest Audit

| Area | Current state |
|---|---|
| **Deployment model** | One Supabase project + one Netlify site per school. No shared infrastructure, no self-serve signup. Onboarding a new school today means a human (us) manually running SQL and setting env vars. |
| **Roles** | Exactly three: `admin`, `teacher`, `student`. No Parent role, no Director/Deputy/HOD/Bursar/Secretary/BOM granularity, no capability-based permissions — it's a hard binary (admin can do everything, teacher can do very little beyond marks entry). |
| **Academic structure** | Academic years/terms (single active year/term enforced), classes + streams, subjects (CBC list + custom). No Learning Area strands/sub-strands, no Departments, no Subject Groupings. |
| **Students** | Search/list/filter, add/edit (single-step form), bulk CSV upload, delete. Missing: photos, UPI number, assessment number, guardian/medical/previous-school detail, "move between classes" as an audited action, a removed/withdrawn-students archive (we hard-delete today), fee integration. |
| **Staff** | Basic CRUD (name, email, phone, job title, gender, qualifications). Missing: TSC/employee number, department, employment type, date of joining, bulk upload, deactivate-vs-delete distinction (we only have status active/inactive, which is close but not surfaced as a deliberate offboarding flow). |
| **Exams & marks** | One exam type, single grading scale, direct entry/edit by admin or assigned teacher, tie-aware ranking. Missing: exam types (Summative/Formative/CAT/Mock), minimum-subjects-for-ranking rule, subject papers (Paper 1/Paper 2 weighting), and — the big one — **no publishing workflow**. Every teacher's marks are live the instant they're saved; there's no Teacher → Class Teacher → Supervisor → Admin approval chain, so there's no "these results are provisional" state and no accountability trail before parents could theoretically see something. |
| **CBC depth** | We use a single numeric grading scale for everything. Zeraki supports the actual CBC four-level rubric (Exceeding/Meeting/Approaching/Below Expectations) for formative assessment, which is what CBC schools are increasingly required to report against — this is a real curriculum-compliance gap, not just a nice-to-have. |
| **Printouts** | Report cards, mark lists (broadsheets), class lists. Missing: merit lists as a first-class report, transcripts, leaving certificates, admission/transfer letters, batch generation (Zeraki does 50-at-a-time batches). |
| **Attendance** | **Does not exist.** No student attendance, no staff attendance, no reports, no correlation with performance. |
| **Messaging / SMS** | **Does not exist.** No bulk SMS, no fee reminders, no result notifications, no credit/wallet system, no telco billing integration. |
| **Parent access** | **Does not exist.** Parents have no login, no visibility into anything — a school's only communication channel with them stays whatever it was before Shule (phone calls, paper). This is arguably the single biggest gap given how much of Zeraki's stated value proposition is parent communication. |
| **Behaviour tracking** | Does not exist. |
| **BOM/PA management** | Does not exist. |
| **Calendar / events** | Does not exist. |
| **Timetabling** | Does not exist (Zeraki sells this as a related but separate product — genuinely hard to build, discussed in Section 5). |
| **Billing/finance** | No fee module, no subscription billing for us to charge schools, no SMS credit purchasing. |
| **Security posture** | Solid for a single-tenant app — real RLS, real password floors, a properly isolated privileged function for login provisioning. Not yet built for a multi-tenant, multi-support-agent operation: no audit log of admin actions, no MFA, no token-scoped support access. |
| **Engineering quality** | Genuinely strong: 136 passing unit tests across every data module, a vendored dependency (no CDN fragility), full Playwright browser verification of every screen, RLS policies verified against real Postgres role simulation. This is worth protecting — I will hold every phase below to the same bar. |

---

## 3. The One Decision That Changes Everything: Multi-Tenancy

### What "single-tenant" costs us if we don't fix it now

Right now, "onboarding a new school" means: create a new Supabase project by hand, run `schema.sql` + `seed.sql`, manually insert the first admin via SQL, create a new Netlify site, wire up a new GitHub repo (or branch), set environment variables, and hand the school a unique URL. That's roughly what we just walked through together for your own school — and it took the better part of an afternoon, with a real human (you) doing GitHub/Netlify account setup, credential handling, and troubleshooting the whole way.

That process does not scale to "hundreds of schools," let alone a meaningful share of Zeraki's book. It doesn't scale operationally (every school is a bespoke deployment someone has to maintain, patch, and pay hosting for separately), and it doesn't scale commercially (there's no self-serve signup funnel — every customer requires white-glove onboarding, which caps how fast we can grow and how thin our margins can get).

### What changes

We move to **one shared application, one shared Supabase project, serving every school**, with strict tenant isolation enforced the same way we already enforce role isolation: Postgres Row-Level Security. Concretely:

1. A new `schools` table becomes the tenant registry: id, name, subdomain/slug, subscription plan/status, branding (logo/colors), created_at.
2. Every existing table (`staff`, `students`, `classes`, `streams`, `subjects`, `academic_years`, `terms`, `exams`, `results`, `grading_scales`, `grade_ranges`, `settings`, `profiles`, both assignment tables) gets a `school_id` column, not-null, foreign-keyed to `schools`.
3. Every RLS policy gets rewritten to add `and school_id = current_school_id()` alongside the existing role checks. `current_school_id()` becomes a new SECURITY DEFINER helper (same pattern as today's `current_role()`), reading the school_id off the caller's `profiles` row.
4. Every insert path in every `src/lib/api/*.mjs` module needs `school_id` populated — the safe way to do this is a Postgres trigger (`before insert`) that stamps `school_id` from the authenticated user's profile automatically, so the client can never forge a different school's ID even by accident or malice.
5. The frontend needs a way to know "which school" a given login belongs to — since we're moving off "one deployment per school," this becomes either subdomain-based (`riverside.shule.app`) or a school-selection step baked into login. Subdomain-based is the better long-term answer and matches what schools expect from SaaS products they already use.
6. Self-serve school signup becomes a real, first-class flow: someone fills a form, gets a school + a first admin account created transactionally (this is genuinely new work — right now that first-admin step is a manual SQL insert we do by hand), and can start using the product within minutes, not a supported-onboarding afternoon.
7. The Netlify function layer barely changes in shape (it's already the privileged, service-role-only tier) but every action it performs must now be scoped to the caller's `school_id`, not just "is this caller an admin."
8. Operationally, this is a large simplification going forward: one codebase, one database, one deploy pipeline, serving every customer — patches, features, and fixes land for everyone at once instead of requiring per-school redeploys.

### Why this has to happen before more features, not after

Every additional table and screen we build against the current single-tenant schema is more surface area to retrofit later. Today it's roughly 15 tables and 20 API modules; if we build Attendance, Messaging, Behaviour, BOM/PA, and a Parent portal first, it's 25+ tables and 35+ modules, every one of which would need the same `school_id` retrofit, the same RLS rewrite, and the same trigger work — done once under time pressure instead of once, calmly, now, while the surface area is still small and every table's shape is already this session's context. This is a case where "if a feature is too difficult to build at the current stage, do not build it" cuts the other way: multi-tenancy isn't optional or deferrable — it's the foundation everything else stands on, and it only gets more expensive with time.

### What does NOT change

The tech stack stays exactly what it is — static SPA, Supabase, Netlify Functions, no framework, no bundler, native ES modules. That decision was right for the reasons already documented in this project's setup guides, and multi-tenancy doesn't argue against any of them. This is a data-model and access-control migration, not a rewrite.

---

## 4. Feature Gap Analysis — Zeraki vs. Shule

Severity: 🔴 core gap (schools expect this, we don't have it) · 🟡 partial (we have a simpler version) · 🟢 rough parity

| Module | Zeraki capability | Shule today | Severity |
|---|---|---|---|
| Dashboard | Stats, SMS balance, assessment charts, student flow trends, sub-tabs | Stats + setup checklist, no charts/trends | 🟡 |
| Calendar/Events | Full event management, 4 view modes, participant targeting | None | 🔴 |
| Classes | Grade+stream CRUD, supervisor assignment, graduated-class archive | Grade+stream CRUD only | 🟡 |
| Learning Areas | Strands/sub-strands (CBC), Departments (HOD/HOS), Subject Groupings | Flat subject list only | 🔴 (CBC-specific) |
| Students | 5-step registration, photos, UPI/assessment no., move-between-classes, removed-students archive, fee integration | Single-step form, bulk CSV, hard delete | 🟡 |
| Teachers/Staff | TSC number, department, granular role assignment (Supervisor/Class Teacher/Subject Teacher/HOD/Admin), bulk upload | Flat job-title field, binary admin/teacher | 🟡 |
| BOM/PA | Dedicated governance-stakeholder module | None | 🔴 (lower urgency) |
| Exams | Types (Summative/Formative/CAT/Mock), min-subjects rule, subject papers, **multi-level publishing workflow** | One exam type, direct entry, no publishing gate | 🔴 |
| Assessment (CBC rubrics) | 4-level competency rubric (EE/ME/AE/BE), strand-tagged | Numeric-only grading | 🔴 (CBC-specific) |
| Attendance | Daily marking, reports, performance correlation, Leave Outs, Checkout logs | **None** | 🔴🔴 |
| Messaging/SMS | Bulk SMS, exam-result SMS, fee reminders, credit wallet, STK Push purchase, delivery/opt-out compliance | **None** | 🔴🔴 |
| Parent/Student portal | Parents log in to view reports, messages, fee balance | Student portal only, **no parent access at all** | 🔴🔴 |
| Printouts | Report cards, transcripts, merit lists, leaving/transfer/admission certificates, batch (50 at a time) | Report cards, mark lists, class lists | 🟡 |
| Billing (schools paying Zeraki) | Invoices/receipts for subscription + SMS | None (not yet monetizing) | n/a until we charge |
| Behaviour | Merits/infractions, CBC rubric-tagged, reports | None | 🔴 (retention driver) |
| Timetable | Full auto-generation engine with constraints | None | 🔴 (hard, see Section 5) |
| Settings | Compulsory subjects, pass mark, name format, exam-release gating, MFA toggle | Contact/logo/name only | 🟡 |
| Security/Support ops | Token-scoped agent access, audit log, MFA, SMS opt-out (USSD) | None of this exists yet — not needed until we have external support staff touching customer data | 🔴 (sequenced later, see Section 5) |
| Opportunities (job board) | Teacher vacancy/swap board | None | 🟢 (low priority, niche) |

---

## 5. What We Will Deliberately NOT Build Yet — and Why

Per your own instruction — if it's too hard right now, or too risky, don't build it. Here's what I'm explicitly deferring, with reasoning, not just silently skipping:

- **Timetable auto-generation.** Zeraki sells this as a *separate product* for a reason — constraint-based scheduling (teacher availability, double lessons, subject adjacency rules, combined subjects) is a genuinely hard algorithmic problem, easy to get subtly wrong in ways that only surface once a real school tries to use a generated timetable on a Monday morning. Building a half-working version would actively damage trust. This belongs late in the roadmap (Phase 5), as a standalone module, ideally after we've watched how much demand actually shows up for it versus the modules ahead of it.
- **Full Fee/Finance management.** Real money, real reconciliation, real regulatory exposure (M-Pesa integration, receipting). I'm sequencing a *read-only* fee-balance import (schools upload a balance spreadheet, same shape as Zeraki's) ahead of any two-way payment processing — that gets us the "SMS fee reminder" and "balance on report card" value without us taking on payment-processor liability before we're ready for it.
- **Multi-country grading systems (Uganda/Tanzania/etc.).** Kenya is the stated market. Building for five curricula before we've won share in one is scope creep against the actual goal.
- **AI/predictive analytics.** Needs a meaningful volume of historical multi-term data per school to be worth anything — building it now, on day-one data, would produce noise dressed up as insight. Revisit once Phase 1–3 schools have 3+ terms of real data.
- **Biometric attendance / GPS bus tracking.** Hardware dependency, real cost to schools, not core to closing deals right now.
- **MFA, token-scoped support access, full audit logging.** These matter enormously *once we have external support staff and paying multi-tenant customers* — they're a trust/compliance requirement at scale, not a day-one feature. I've placed this in Phase 4/5, timed to land before or alongside our first real support-team hires, not before.
- **Teacher job board (Opportunities).** Genuinely nice, genuinely not why any school signs a contract. Parking indefinitely, revisit only if it becomes a specific customer ask.

---

## 6. Role & Permission Model Redesign

The binary admin/teacher model breaks the moment we need Zeraki's exam-publishing hierarchy (Subject Teacher → Class Teacher → Supervisor → Admin) or want to give a Bursar messaging-only access without full admin rights. Proposed model, built in Phase 0/1 alongside multi-tenancy since it touches the same `profiles`/RLS layer:

- Keep three **account kinds** at the auth level (staff, student, and new: **parent**), since that maps directly to how people actually log in (email vs. admission number vs. a parent-linked contact).
- Replace the single `role` enum on staff with a **capabilities model**: a small `staff_capabilities` table (or a JSON/array column, whichever proves simpler under real RLS testing) granting specific abilities — `manage_students`, `manage_exams`, `publish_results`, `send_messages`, `manage_billing`, `manage_settings`, `class_teacher_of` (scoped to specific class IDs), `supervisor_of` (scoped to specific grade levels). Admin becomes "has all capabilities" rather than a special-cased role.
- Add the **Parent** account kind: linked to one or more student records (a parent with children in different classes needs to see all of them), read-only across report cards, attendance, messages, and (later) fee balance.
- This directly unlocks the exam-publishing workflow in Phase 2 (a result only becomes visible to Class Teacher once Subject Teacher "submits," only visible to Admin/Parent once Class Teacher "publishes") without needing a fourth hard-coded role every time a school's org chart doesn't match ours.

---

## 7. The Roadmap

Phases are ordered by leverage, not calendar time — you've said not to worry about the timeline, so sizes below are *relative* effort signals, not deadlines. Each phase assumes the same verification bar we've held throughout: real unit tests per data module, real Playwright browser verification per screen, no feature ships without both.

### Phase 0 — Multi-Tenant Foundation (blocks everything else)
**Status: delivered** (confirmed no schools besides yours were live, so this shipped as the "straightforward" case described below — see `MULTI_TENANT_MIGRATION_GUIDE.md` for the runbook to apply it to your live project).
- ✅ `schools` tenant table, `school_id` on every existing table, rewritten RLS, `current_school_id()` helper, auto-stamping triggers. Verified against a real local Postgres instance simulating two separate schools (cross-tenant read/insert/update/delete all correctly rejected) before being handed to you, plus a second verification pass replaying the exact migration path against a simulated copy of your live single-tenant data to confirm nothing is lost or misattributed.
- ✅ Self-serve school signup flow (`netlify/functions/school-signup.js` + a new pre-auth screen) — replaces the manual "create a Supabase project by hand" process entirely. New schools seed with the default CBC subjects/grading scale automatically.
- ✅ Migrated your existing school's data into the new shared schema as the first tenant, via `supabase/migrations/0002_multi_tenant.sql`.
- ⏭️ Role/permission model redesign from Section 6 (capability-based staff permissions, Parent account kind) — deliberately deferred to Phase 1, not bundled into this migration. Reasoning: the multi-tenancy schema change alone was already the highest-risk single change this product has had; shipping it in isolation, verified in isolation, keeps that risk contained and easy to reason about. The permission redesign touches the same `profiles`/RLS layer and is next up.
- ⏭️ Subdomain routing — deferred. One shared login screen with a "School Code" field (Slack-workspace-style) does the same job for now with far less infrastructure (no wildcard DNS/SSL to manage), and doesn't block anything downstream; genuine subdomain routing (`greenhill.shule.app`) is a pure infrastructure upgrade we can layer on later without another data migration.
- **Exit criterion — met:** two schools (your real one, migrated, plus a self-signed-up test school) running on one shared deployment, fully isolated from each other, proven via the same RLS role-simulation testing used in Phase 1 (see the migration guide's "what actually changed" section for specifics).

### Phase 1 — Communication & Presence Parity
**Status: delivered** (built and shipped as one combined pass — schema, backend, and frontend for all three features together, tested and deployed in a single round, per your instruction to batch features and minimize Netlify build/deploy cycles rather than shipping/testing one at a time).
This is the highest-value phase after the foundation, because it closes the three biggest gaps schools actually feel day-to-day, and two of them (Messaging, Parent Portal) are arguably *the* reason schools buy this category of software at all:
- ✅ **Attendance** — daily marking for both students (per class/stream, with a "mark all present" shortcut) and staff (whole school), full history per student, and a per-class attendance-rate summary over any date range. `student_attendance`/`staff_attendance` tables with `unique(student_id/staff_id, date)` so re-marking a day corrects it in place rather than duplicating. Available to admin and teacher.
- ✅ **Messaging** — compose-and-send to a whole class's guardians, one guardian, one staff member, or every guardian school-wide; every send is fully logged per-recipient (`message_logs`, grouped by `batch_id` for a readable history). Deliberately staged short of a real SMS gateway integration for this pass: `isProviderConfigured()` in `netlify/functions/send-message.js` checks for an `SMS_PROVIDER_API_KEY` env var that isn't set yet, so messages are logged as real, usable data (and the whole compose/history workflow is real and testable) but marked "not actually sent" instead of pretending delivery happened. Flipping on a real provider (Africa's Talking is the standard choice for this market) later is one function (`sendViaProvider()`) plus one env var — no frontend changes needed. Credit/wallet system and opt-out mechanism are still deferred until a real provider is actually connected, since neither means anything without one.
- ✅ **Parent Portal** — a fourth account kind (`user_role` extended with `parent`, additive so nothing about the existing three roles changed), signing in with a phone number the same way students sign in with an admission number. Admins provision parent logins and link them to one or more children from the new "Parent Accounts" screen; a signed-in parent sees their own children, a 30-day attendance snapshot, and their report cards (reusing the same `get_report_card()` RPC and report-card renderer the student portal uses — the RPC's authorization check was already extended in Phase 0's schema work to recognize a parent linked via `parent_links`). The capability-based staff permission redesign from Section 6 is still deferred — only the new Parent role itself shipped this phase, not a rework of admin/teacher permissions.
- **Exit criterion — met:** all three features have unit tests against a mocked Supabase client (attendance, messaging, parents API modules; the `send-message` and extended `admin-provision` Netlify functions), the full test suite (main `npm test`) is green, and the database layer (schema.sql + `supabase/migrations/0003a_add_parent_role.sql` / `0003b_phase1_attendance_messaging_parents.sql`) was verified against a real local Postgres instance replaying the exact production upgrade path (old single-tenant schema → seed data → Phase 0's migration → this migration) before being handed over, confirming cross-tenant isolation and parent-specific read scoping both hold on the real upgrade path, not just a fresh install. (One real bug was caught in this verification pass after an initial hand-off attempt: the original single-file migration added the new `parent` enum value and used it in the same script, which Postgres rejects when the Supabase SQL Editor runs a paste as one transaction — error 55P04. Splitting the enum-add into its own file, run first and separately, fixed it; both files are now verified end-to-end, including a live RLS check that a parent account can only ever see their own linked child's data.)

### Phase 2 — Exam Workflow Maturity
- Exam types (Summative/Formative/CAT/Mock), minimum-subjects-for-ranking rule, subject papers (Paper 1/2 weighting).
- The publishing workflow itself (Subject Teacher → Class Teacher → Supervisor → Admin), built directly on Phase 0's capability model.
- Richer student/staff profiles (photos, UPI/assessment numbers, TSC numbers, guardian/medical/previous-school detail, employment metadata) and a proper "move students" + "removed students archive" flow instead of hard deletes.
- Printouts expansion: merit lists, transcripts, leaving/transfer certificates, batch generation.

### Phase 3 — CBC Differentiation
- Learning Area strands/sub-strands, the real CBC four-level rubric (EE/ME/AE/BE) for formative assessment, Departments (HOD/HOS), Subject Groupings.
- This is where we can plausibly claim to be *better* than Zeraki for CBC-specific schools rather than just "caught up" — CBC compliance is a genuine, growing pain point for Kenyan primary/junior-secondary schools right now.

### Phase 4 — Retention & Governance
- Behaviour module (merits/infractions, CBC-rubric-tagged).
- BOM/PA management.
- Calendar/events.
- Trend analytics (multi-term performance trends, subject/department comparisons) — deferred until Phase 1–3 schools actually have multiple terms of real data to trend against.
- This is also the natural point to introduce MFA and audit logging, timed to when we're actually operating enough tenant accounts and support staff for it to matter.

### Phase 5 — Scale Moat
- Timetable auto-generation, as its own module, once we understand real demand from Phase 1–4 customers.
- Fee management: start with read-only balance import + SMS reminders, evaluate two-way payment integration only once that's proven out.
- A dedicated mobile app (native or PWA) for parents/teachers, once the web parent portal has proven what parents actually want from it.
- Predictive analytics, once there's enough real multi-tenant, multi-term data for it to be trustworthy rather than decorative.

---

## 8. Technical Architecture Evolution

- **Data layer:** stays Postgres/Supabase; the only structural change through Phase 3 is the `school_id` tenancy column and the capability-based permissions table. No move to a different database is warranted at this scale.
- **Testing discipline:** every phase keeps the same two-part bar — unit tests against the mocked Supabase client for every new API module, Playwright browser verification for every new screen. This is not negotiable; it's the reason Phase 1–3 shipped with zero known defects, and a SaaS serving many schools has far less room for a bad deploy than a single-school pilot did.
- **SMS gateway:** Africa's Talking is the standard, well-documented choice for Kenyan bulk SMS with STK Push-style credit purchasing; this becomes a new Netlify function (privileged, same pattern as `admin-provision.js`) rather than a client-side integration.
- **Netlify Functions:** the privileged-server-side-action pattern established in Phase 2 (service-role key never touches the browser) extends naturally to messaging, attendance-triggered notifications, and the exam-publishing workflow's server-side authorization checks.
- **Frontend architecture:** stays a static, framework-free SPA. At the scale this roadmap targets (dozens of screens, multiple account kinds), this is worth revisiting once, but not before — the current pattern (shared `Db` facade, per-view modules, hash routing) has scaled cleanly from 4 screens to 18 without strain, and multi-tenancy doesn't change that calculus.
- **Deployment:** multi-tenancy collapses "one Netlify site per school" into one shared site serving every tenant — a significant *simplification* of our own operations, not an added complexity, once Phase 0 lands.

---

## 9. Competitive & Go-to-Market Notes (Product Owner Hat)

A few observations worth having on record, even though pricing/sales sit partly outside pure engineering scope:

- **A Zeraki-import wizard is a wedge worth building early** (Phase 1 or 2): a tool that ingests a school's existing Zeraki (or spreadsheet) exports — students, classes, historical results — directly into Shule. Switching cost is the incumbent's biggest moat; removing it for prospects is one of the highest-leverage things the product itself can do for sales.
- **Segment sequencing matters more than total-market messaging.** Realistically, the first wins are more likely to come from schools currently underserved or price-sensitive (smaller private/CBC-focused primary schools) than from large, entrenched national-exam-focused secondary schools already deep into Zeraki's workflow. The roadmap above (Attendance/Messaging/Parent Portal first, then CBC depth) is deliberately weighted toward that segment.
- **Pricing model follow-on question:** once Phase 0 (multi-tenancy) lands, we'll need an actual subscription/billing answer for ourselves (we don't monetize today). That's a real open decision — flat per-school fee vs. per-student vs. SMS-credit-funded — worth a dedicated conversation once we're closer to that phase rather than guessing now.

---

## 10. Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Multi-tenancy migration introduces a data-isolation bug (one school sees another's data) | Same RLS role-simulation testing discipline used in Phase 1, extended to simulate multiple tenants explicitly; this is treated as a launch-blocking test category, not a nice-to-have. |
| SMS costs/telco relationship become a bottleneck | Start with Africa's Talking's standard reseller terms; revisit direct telco relationship only once volume justifies it. |
| Scope creep re-litigates Section 5's "not now" list | This document is the reference point — any request to jump the queue gets weighed against it explicitly, not decided ad hoc. |
| 60% share target creates pressure to ship unverified features fast | Explicitly rejected as a strategy in this document (Section 1) — verification discipline is treated as competitive advantage, not overhead to cut under pressure. |
| Existing single-tenant deployment (your school) breaks during Phase 0 migration | Migration plan explicitly includes migrating your school's real data as the first tenant, verified before any second school is onboarded. |

---

## 11. Immediate Next Steps

1. **Answered:** no schools besides yours were live on the single-tenant setup, so Phase 0 shipped as the straightforward case — see the status note under Section 7 and `MULTI_TENANT_MIGRATION_GUIDE.md` for exactly what to run against your live project.
2. **Delivered:** Phase 1 (Communication & Presence Parity) — Attendance, Messaging, and Parent Portal, built and shipped together as one combined pass per your instruction to batch features and test/deploy once rather than incrementally. See the status note under Section 7 for exactly what shipped. Run `0003a_add_parent_role.sql` then `0003b_phase1_attendance_messaging_parents.sql` against your live project, in that order, as two separate SQL Editor queries — see `HOW_TO_DEPLOY_CHANGES.md`'s note on two-part SQL files for why.
3. **Up next: Phase 2 (Exam Workflow Maturity)** — exam types, the publishing workflow, richer student/staff profiles, and printouts expansion. I'll scope and build this the same way: verified in a sandbox (or simulated Postgres instance) before it touches your live data, real unit tests per module.
4. This document stays the living source of truth — each phase's section gets a status update like Phase 0 and Phase 1's above as it ships, rather than a separate changelog.

---

*This document will be updated at the end of every phase to reflect what actually shipped, what changed, and what the next phase's priorities are — treat it as the current source of truth for where Shule is headed, not a one-time plan.*
