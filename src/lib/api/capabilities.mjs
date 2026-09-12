/**
 * capabilities.mjs — grant/revoke the small, purpose-built capability model
 * added in Phase 2a (see staff_capabilities in migrations/0005_exam_workflow.sql).
 * Today the only capability wired to anything is 'publish_results' — the
 * final step of the exam-results publishing workflow (Subject Teacher ->
 * Class Teacher -> Supervisor -> Admin). This product has no separate
 * "Supervisor" login — that role in the chain is simply an admin, or any
 * teacher an admin has explicitly granted this capability to.
 */
import { ok, err, createMemoCache, clearAllCaches } from './_util.mjs';

// Sprint: Finance module — two granular grants (see migrations/
// 0031_finance_module.sql's header comment): 'finance_record_collections'
// (record/reverse/transfer payments, view balances/statements/reports) and
// 'finance_manage_fees' (vote heads, fee structures, invoicing, routes,
// debit/credit notes — a superset for anything that changes what's owed
// rather than what's been paid). Brief scenario #20's "grant a bursar
// collections + statements only, not fee structures/notes" is exactly one
// of these two grants, not both.
//
// SignUp_Fixes §5 (REDO — "Module Access Should Use Existing Access
// Control, With Sensible Defaults"): Finance's own "hidden unless granted"
// behaviour above already IS the sensible default this brief asks for — it
// was never a separate toggle, it's these same capability rows. What was
// missing is the OTHER direction: a way to explicitly BLOCK a staff member
// from a module they'd otherwise see by default (e.g. a bursar who should
// see Finance but nothing else). DENIABLE_MODULES below adds exactly that,
// through this SAME grant/revoke mechanism — a 'deny_<module>' capability
// row means "this staff member does NOT see <module>", checked in app.js's
// buildNav()/allowedRoutes() and rendered as its own checkbox group in the
// staff-edit modal's Access Control section (staff.mjs). Every module a
// teacher gets by default (everything except Finance, which is opt-in) is
// deniable; Dashboard and My Profile are not — a teacher always needs
// somewhere to land and a way to manage their own account.
export const DENIABLE_MODULES = [
  { key: 'deny_students', route: 'students', label: 'Students' },
  { key: 'deny_attendance', route: 'attendance', label: 'Attendance' },
  { key: 'deny_messaging', route: 'messaging', label: 'Messaging' },
  { key: 'deny_exams', route: 'exams-hub', label: 'Exams' },
  { key: 'deny_reports', route: 'reports-hub', label: 'Reports' },
  { key: 'deny_timetable', route: 'my-timetable', label: 'My Timetable' }
];

// "Finance Clerk" (Kodi-comparison follow-up): a teacher whose ENTIRE
// sidebar becomes Finance's own sections (Dashboard/Collections/Invoicing/
// Reports/Transport) — no general school Dashboard, no Exams, no Students,
// nothing else, and they land straight on Finance at login. Deliberately
// its own single capability rather than reusing DENIABLE_MODULES one-by-one
// (an admin would otherwise have to remember to tick all six deny_* boxes,
// and a NEW deniable module added later would silently leak into a clerk's
// nav until someone remembered to also deny it there). Still independent
// of finance_manage_fees/finance_record_collections — this one only
// controls what the SIDEBAR looks like; those two still control what the
// clerk can actually do once inside Finance, exactly as for any bursar.
// Finance > Access (live feedback: "create access module in finance where
// the bursar can add other finance users eg accounts clerk and restrict
// some operations or modules from him or her"). Same shape as
// DENIABLE_MODULES above, just one level down: these gate Finance's OWN
// internal tab bar (financeHub.mjs's TABS) rather than the app's main
// sidebar, so a finance user can be a full bursar in every other module but
// blocked from, say, Payroll or Inventory inside Finance specifically. Only
// meaningful for a staff member who has finance access at all
// (finance_manage_fees/finance_record_collections/finance_clerk) — denying
// a Finance tab to someone with no Finance access to begin with is a no-op.
export const FINANCE_DENIABLE_TABS = [
  { key: 'deny_finance_students', route: 'students', label: 'Students' },
  { key: 'deny_finance_invoicing', route: 'invoicing', label: 'Invoicing' },
  { key: 'deny_finance_accounting', route: 'accounting', label: 'Accounting' },
  { key: 'deny_finance_expenses', route: 'expenses', label: 'Expenses' },
  { key: 'deny_finance_payroll', route: 'payroll', label: 'Staff Payroll' },
  { key: 'deny_finance_inventory', route: 'inventory', label: 'Inventory' },
  { key: 'deny_finance_reports', route: 'reports', label: 'Reports' },
  { key: 'deny_finance_transport', route: 'transport', label: 'Transport Mgnt' },
  { key: 'deny_finance_preferences', route: 'preferences', label: 'Preferences' }
];
// Everything that makes a staff member "a finance user" at all — used by
// financeAccess.mjs to list who currently has any kind of Finance access,
// and to know which rows to strip when someone is removed from Finance
// entirely. Deliberately does NOT include the deny_finance_* tab-level keys
// here — those only mean something IN ADDITION to one of these three, never
// on their own.
export const FINANCE_USER_CAPABILITIES = ['finance_manage_fees', 'finance_record_collections', 'finance_clerk'];

export const CAPABILITIES = [
  'publish_results', 'finance_record_collections', 'finance_manage_fees', 'finance_clerk',
  ...DENIABLE_MODULES.map((m) => m.key),
  ...FINANCE_DENIABLE_TABS.map((m) => m.key)
];
export const CAPABILITY_LABELS = {
  publish_results: 'Publish exam results',
  finance_record_collections: 'Finance: record collections & view statements',
  finance_manage_fees: 'Finance: manage fees, invoices & credit/debit notes',
  finance_clerk: 'Finance Clerk — sidebar shows ONLY Finance, nothing else',
  ...Object.fromEntries(DENIABLE_MODULES.map((m) => [m.key, `Block access to ${m.label}`])),
  ...Object.fromEntries(FINANCE_DENIABLE_TABS.map((m) => [m.key, `Block access to Finance's ${m.label} tab`]))
};

export function createCapabilitiesApi(supabase) {
  // Same short-window in-memory memoization pattern as the rest of the app
  // (see _util.mjs's createMemoCache header comment for the app-wide
  // invalidation bus this shares). Scoped per createCapabilitiesApi() CALL,
  // not module-level — see the same note in academics.mjs/students.mjs.
  const { cached } = createMemoCache(20000);
  function clearCache() { clearAllCaches(); }
  return {
    async listForStaff(staffId) {
      if (!staffId) return ok([]);
      return cached('capabilities.listForStaff', staffId, async () => {
        const { data, error } = await supabase.from('staff_capabilities').select('*').eq('staff_id', staffId);
        if (error) return err(error.message);
        return ok((data || []).map((r) => r.capability));
      });
    },

    async grant(staffId, capability) {
      if (!staffId) return err('Missing staff member.');
      if (CAPABILITIES.indexOf(capability) === -1) return err('Unknown capability.');
      const { data: existing } = await supabase.from('staff_capabilities').select('id')
        .eq('staff_id', staffId).eq('capability', capability).maybeSingle();
      if (existing) return ok(true);
      const { error } = await supabase.from('staff_capabilities').insert({ staff_id: staffId, capability });
      if (error) return err(error.message);
      clearCache();
      return ok(true);
    },

    async revoke(staffId, capability) {
      if (!staffId) return err('Missing staff member.');
      const { error } = await supabase.from('staff_capabilities').delete().eq('staff_id', staffId).eq('capability', capability);
      if (error) return err(error.message);
      clearCache();
      return ok(true);
    },

    // Finance > Access's own list screen: every staff member who holds ANY
    // of the three "counts as a finance user" capabilities, one row per
    // staff member with all of their capabilities (finance + tab-level
    // denies) grouped together — not one row per capability, which the raw
    // table naturally returns since a bursar with 2-3 grants would otherwise
    // show up 2-3 times.
    async listFinanceUsers() {
      return cached('capabilities.listFinanceUsers', null, async () => {
        const { data, error } = await supabase.from('staff_capabilities')
          .select('staff_id, capability, staff(id, full_name, role, status)')
          .in('capability', FINANCE_USER_CAPABILITIES);
        if (error) return err(error.message);
        // A capability row for a staff member who's since been deleted has
        // no embedded `staff` — skip it rather than surface a blank name.
        const byStaff = {};
        (data || []).forEach((row) => {
          if (!row.staff) return;
          if (!byStaff[row.staff_id]) byStaff[row.staff_id] = { staff: row.staff, capabilities: [] };
          byStaff[row.staff_id].capabilities.push(row.capability);
        });
        // The tab-level deny_finance_* rows aren't part of the `.in()`
        // filter above (see FINANCE_USER_CAPABILITIES's own comment), but a
        // listed finance user's full capability set — deny rows included —
        // is what the Access screen needs to pre-check their restriction
        // boxes, so fetch those separately for exactly the staff already
        // found above rather than pulling every capability row in the
        // school.
        const staffIds = Object.keys(byStaff);
        if (staffIds.length) {
          const denyKeys = FINANCE_DENIABLE_TABS.map((m) => m.key);
          const { data: denyRows, error: denyErr } = await supabase.from('staff_capabilities')
            .select('staff_id, capability').in('staff_id', staffIds).in('capability', denyKeys);
          if (!denyErr) (denyRows || []).forEach((row) => {
            if (byStaff[row.staff_id]) byStaff[row.staff_id].capabilities.push(row.capability);
          });
        }
        return ok(Object.values(byStaff));
      });
    }
  };
}
