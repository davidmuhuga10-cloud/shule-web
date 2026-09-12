-- ============================================================================
-- 0064_finance_access_module.sql
-- ----------------------------------------------------------------------------
-- Finance > Access (live feedback: "create access module in finance where
-- the school bursar maybe can add other finance users eg accounts clerk and
-- be able to restrict some operations or modules from him or her, also be
-- able to delete the finance user when needed").
--
-- No new tables, no new RPCs — this reuses the EXACT same staff_capabilities
-- grant/revoke mechanism every other capability in this app already uses
-- (see src/lib/api/capabilities.mjs). Two things widen here:
--
--   1. Nine new 'deny_finance_<tab>' keys, one per optional Finance tab
--      (Students/Invoicing/Accounting/Expenses/Payroll/Inventory/Reports/
--      Transport/Preferences). Same "sensible default is see everything,
--      deny_* blocks one specific thing" pattern 0039_module_access_control
--      already established for the app's TOP-LEVEL modules (deny_students,
--      deny_attendance, ...) — this is that same idea, one level down,
--      scoped to Finance's own internal tab bar instead of the main sidebar.
--      Deliberately its own prefix (not reusing the top-level deny_students
--      key for Finance > Students) since a staff member could reasonably be
--      blocked from the main Students module but still need Finance's own
--      Students tab (fee/invoice work), or vice versa — the two are
--      genuinely independent screens sharing only a name.
--
--      No app.js changes needed to read these: state.profile.deniedModules
--      (app.js bootApp()) already collects EVERY 'deny_'-prefixed capability
--      a staff member holds into one Set, regardless of whether app.js's own
--      DENIABLE_MODULES list recognises the specific key — financeHub.mjs
--      just checks that same Set for its own tab keys directly.
--
--   2. Nothing else — 'finance_manage_fees'/'finance_record_collections'/
--      'finance_clerk' (who counts as "a finance user" and what they can DO)
--      already existed; this module is a UI for granting/revoking exactly
--      those, plus the nine new tab-level denies, without needing to leave
--      Finance to reach Teachers and Staff. That matters most for a Finance
--      Clerk bursar — NAV.financeOnly means they have no route to Teachers
--      and Staff at all today, so they had no way to bring on an Accounts
--      Clerk themselves; a plain bursar (finance_manage_fees, full nav)
--      could already do this from Teachers and Staff, just not from inside
--      Finance itself.
-- ============================================================================

begin;

alter table public.staff_capabilities drop constraint staff_capabilities_capability_check;
alter table public.staff_capabilities add constraint staff_capabilities_capability_check
  check (capability in (
    'publish_results', 'finance_manage_fees', 'finance_record_collections', 'finance_clerk',
    'deny_students', 'deny_attendance', 'deny_messaging', 'deny_exams', 'deny_reports', 'deny_timetable',
    'deny_finance_students', 'deny_finance_invoicing', 'deny_finance_accounting', 'deny_finance_expenses',
    'deny_finance_payroll', 'deny_finance_inventory', 'deny_finance_reports', 'deny_finance_transport',
    'deny_finance_preferences'
  ));

commit;
