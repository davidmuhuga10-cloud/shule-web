/**
 * finance.mjs — data-access layer for the Finance module (Finance_Module_
 * Brief.docx). Thin wrappers around plain RLS-scoped reads/writes for the
 * simple config tables (vote heads, routes, fee structures) and the
 * security-definer RPCs in migrations/0031_finance_module.sql for anything
 * that has to be atomic (recording/reversing/transferring a collection,
 * assigning a route, generating invoices, issuing notes, carrying balances
 * forward) — see that migration's header comment for the full reasoning.
 *
 * Caching (brief: "optimize for low infrastructure/server cost... strong
 * caching, especially on read-heavy screens like the dashboard and balances
 * views"): rather than standing up a cache server, the dashboard/vote-head-
 * collections/trial-balance/cashbook reads are memoized in memory for a
 * short window (CACHE_MS) keyed by their arguments — a school's bursar
 * clicking between Finance tabs within a few seconds doesn't re-run the
 * same aggregate query, but a `clearCache()` call after anything that
 * changes money (record/reverse/transfer collection, generate invoices,
 * issue a note) guarantees the next read is never stale.
 */
import { ok, err, fromResult } from './_util.mjs';

const CACHE_MS = 20000;
const cache = new Map();
function cacheKey(name, args) { return name + '|' + JSON.stringify(args || []); }
async function cached(name, args, fn) {
  const key = cacheKey(name, args);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const value = await fn();
  if (value && value.ok) cache.set(key, { at: Date.now(), value });
  return value;
}
function clearCache() { cache.clear(); }

export function createFinanceApi(supabase) {
  const voteHeads = {
    async list() {
      const { data, error } = await supabase.from('finance_vote_heads').select('*').order('priority').order('name');
      if (error) return err(error.message);
      return ok(data || []);
    },
    async save(payload) {
      payload = payload || {};
      if (!String(payload.name || '').trim()) return err('Vote head name is required.');
      const row = {
        id: payload.id || undefined, name: payload.name.trim(), code: payload.code || null,
        priority: Number.isFinite(Number(payload.priority)) ? Number(payload.priority) : 100,
        active: payload.active !== false
      };
      const res = fromResult(await supabase.from('finance_vote_heads').upsert(row).select().single());
      if (res.ok) clearCache();
      return res;
    },
    async reorder(idsInPriorityOrder) {
      const updates = (idsInPriorityOrder || []).map((id, i) => supabase.from('finance_vote_heads').update({ priority: (i + 1) * 10 }).eq('id', id));
      const results = await Promise.all(updates);
      const failed = results.find((r) => r.error);
      if (failed) return err(failed.error.message);
      clearCache();
      return ok(true);
    }
  };

  const routes = {
    async list() {
      const { data, error } = await supabase.from('finance_routes').select('*').order('name');
      if (error) return err(error.message);
      return ok(data || []);
    },
    async save(payload) {
      payload = payload || {};
      if (!String(payload.name || '').trim()) return err('Route name is required.');
      const row = {
        id: payload.id || undefined, name: payload.name.trim(), pickup_point: payload.pickup_point || null,
        one_way_amount: Number(payload.one_way_amount) || 0, two_way_amount: Number(payload.two_way_amount) || 0,
        active: payload.active !== false
      };
      return fromResult(await supabase.from('finance_routes').upsert(row).select().single());
    },
    async assign(studentId, routeId, direction, academicYearId, termId) {
      const { data, error } = await supabase.rpc('finance_assign_route', {
        p_student_id: studentId, p_route_id: routeId, p_direction: direction,
        p_academic_year_id: academicYearId, p_term_id: termId
      });
      if (error) return err(error.message);
      clearCache();
      return ok(data);
    },
    async forStudent(studentId, academicYearId, termId) {
      const { data, error } = await supabase.from('finance_student_routes').select('*')
        .eq('student_id', studentId).eq('academic_year_id', academicYearId).eq('term_id', termId).maybeSingle();
      if (error) return err(error.message);
      return ok(data || null);
    }
  };

  const feeStructures = {
    async list(academicYearId, termId) {
      let q = supabase.from('finance_fee_structures').select('*, finance_fee_structure_classes(class_id), finance_fee_structure_items(vote_head_id, amount)').order('created_at', { ascending: false });
      if (academicYearId) q = q.eq('academic_year_id', academicYearId);
      if (termId) q = q.eq('term_id', termId);
      const { data, error } = await q;
      if (error) return err(error.message);
      return ok(data || []);
    },
    /** payload: { id?, academic_year_id, term_id, name, class_ids: [], items: [{vote_head_id, amount}] } */
    async save(payload) {
      payload = payload || {};
      if (!String(payload.name || '').trim()) return err('Fee structure name is required.');
      if (!payload.academic_year_id || !payload.term_id) return err('Choose an academic year and term.');
      if (!payload.class_ids || !payload.class_ids.length) return err('Choose at least one class this fee structure applies to.');
      if (!payload.items || !payload.items.length) return err('Add at least one vote head amount.');

      let structureId = payload.id;
      if (structureId) {
        const upd = await supabase.from('finance_fee_structures').update({ name: payload.name.trim(), academic_year_id: payload.academic_year_id, term_id: payload.term_id }).eq('id', structureId);
        if (upd.error) return err(upd.error.message);
        await supabase.from('finance_fee_structure_classes').delete().eq('fee_structure_id', structureId);
        await supabase.from('finance_fee_structure_items').delete().eq('fee_structure_id', structureId);
      } else {
        const ins = await supabase.from('finance_fee_structures').insert({
          name: payload.name.trim(), academic_year_id: payload.academic_year_id, term_id: payload.term_id
        }).select().single();
        if (ins.error) return err(ins.error.message);
        structureId = ins.data.id;
      }

      const classRows = payload.class_ids.map((class_id) => ({ fee_structure_id: structureId, class_id }));
      const itemRows = payload.items.filter((it) => it.vote_head_id && Number(it.amount) >= 0).map((it) => ({ fee_structure_id: structureId, vote_head_id: it.vote_head_id, amount: Number(it.amount) }));
      const [c1, c2] = await Promise.all([
        supabase.from('finance_fee_structure_classes').insert(classRows),
        supabase.from('finance_fee_structure_items').insert(itemRows)
      ]);
      if (c1.error) return err(c1.error.message);
      if (c2.error) return err(c2.error.message);
      clearCache();
      return ok({ id: structureId });
    },
    /** Bulk-invoices this structure into its tagged classes (all active
     *  students), or just the given student_ids when passed — same RPC
     *  covers both "new term, invoice Grade 1/2" and "new mid-term joiner". */
    async generateInvoices(feeStructureId, studentIds) {
      const { data, error } = await supabase.rpc('finance_generate_invoices', { p_fee_structure_id: feeStructureId, p_student_ids: studentIds || null });
      if (error) return err(error.message);
      clearCache();
      return ok(data);
    }
  };

  const invoices = {
    async forStudent(studentId) {
      const { data, error } = await supabase.from('finance_invoices')
        .select('*, finance_invoice_items(*, finance_vote_heads(name))')
        .eq('student_id', studentId).order('created_at');
      if (error) return err(error.message);
      return ok(data || []);
    },
    /** Direct correction of a non-transport invoice line (e.g. a wrong fee
     *  amount) — transport lines should go through routes.assign() instead
     *  so the student_routes assignment and the invoice line never drift
     *  apart (see migrations/0031's header note). */
    async updateItem(itemId, amount, description) {
      const row = { amount: Number(amount) };
      if (description !== undefined) row.description = description;
      const res = fromResult(await supabase.from('finance_invoice_items').update(row).eq('id', itemId).select().single());
      if (res.ok) clearCache();
      return res;
    }
  };

  const debitNotes = {
    async issue(studentId, voteHeadId, amount, reason, academicYearId, termId) {
      const { data, error } = await supabase.rpc('finance_issue_debit_note', {
        p_student_id: studentId, p_vote_head_id: voteHeadId, p_amount: Number(amount), p_reason: reason || null,
        p_academic_year_id: academicYearId, p_term_id: termId
      });
      if (error) return err(error.message);
      clearCache();
      return ok(data);
    },
    async forStudent(studentId) {
      const { data, error } = await supabase.from('finance_debit_notes').select('*, finance_vote_heads(name)').eq('student_id', studentId).order('created_at');
      if (error) return err(error.message);
      return ok(data || []);
    }
  };

  const creditNotes = {
    async issue(studentId, voteHeadId, amount, reason, academicYearId, termId) {
      const { data, error } = await supabase.rpc('finance_issue_credit_note', {
        p_student_id: studentId, p_vote_head_id: voteHeadId, p_amount: Number(amount), p_reason: reason || null,
        p_academic_year_id: academicYearId, p_term_id: termId
      });
      if (error) return err(error.message);
      clearCache();
      return ok(data);
    },
    async forStudent(studentId) {
      const { data, error } = await supabase.from('finance_credit_notes').select('*, finance_vote_heads(name)').eq('student_id', studentId).order('created_at');
      if (error) return err(error.message);
      return ok(data || []);
    }
  };

  const collections = {
    async list(opts) {
      opts = opts || {};
      let q = supabase.from('finance_collections')
        .select('*, students(full_name, admission_no, class_id, classes(name)), created_by_profile:profiles!finance_collections_created_by_fkey(name)')
        .order('created_at', { ascending: false }).limit(opts.limit || 300);
      if (opts.student_id) q = q.eq('student_id', opts.student_id);
      if (opts.status) q = q.eq('status', opts.status);
      const { data, error } = await q;
      if (error) return err(error.message);
      return ok(data || []);
    },
    async record(studentId, amount, mode, reference, notes) {
      const { data, error } = await supabase.rpc('finance_record_collection', {
        p_student_id: studentId, p_amount: Number(amount), p_mode: mode, p_reference: reference || null, p_notes: notes || null
      });
      if (error) return err(error.message);
      clearCache();
      return ok(data);
    },
    async reverse(collectionId, reason) {
      const { data, error } = await supabase.rpc('finance_reverse_collection', { p_collection_id: collectionId, p_reason: reason || null });
      if (error) return err(error.message);
      clearCache();
      return ok(data);
    },
    async transfer(collectionId, toStudentId) {
      const { data, error } = await supabase.rpc('finance_transfer_collection', { p_collection_id: collectionId, p_to_student_id: toStudentId });
      if (error) return err(error.message);
      clearCache();
      return ok(data);
    },
    /** Allocations for one collection — the vote-head breakdown printed on
     *  its receipt, and reprinted identically for any past receipt. */
    async allocations(collectionId) {
      const { data, error } = await supabase.from('finance_collection_allocations').select('*, finance_vote_heads(name)').eq('collection_id', collectionId);
      if (error) return err(error.message);
      return ok(data || []);
    }
  };

  const students = {
    async search(query) {
      const q = String(query || '').trim();
      if (!q) return ok([]);
      const { data, error } = await supabase.from('students')
        .select('id, admission_no, full_name, gender, class_id, stream_id, guardian_name, guardian_contact, classes(name), streams(name)')
        .or(`full_name.ilike.%${q}%,admission_no.ilike.%${q}%`)
        .eq('status', 'active').order('full_name').limit(30);
      if (error) return err(error.message);
      return ok(data || []);
    },
    async balance(studentId) {
      const { data, error } = await supabase.rpc('finance_student_balance', { p_student_id: studentId });
      if (error) return err(error.message);
      return ok(data);
    },
    async openingBalance(studentId, academicYearId) {
      const { data, error } = await supabase.from('finance_opening_balances').select('*').eq('student_id', studentId).eq('academic_year_id', academicYearId).maybeSingle();
      if (error) return err(error.message);
      return ok(data || null);
    },
    /** Bulk-upserts opening balances (brief scenario #9) — rows: [{student_id, amount, notes?}]. */
    async bulkOpeningBalances(rows, academicYearId) {
      const payload = (rows || []).filter((r) => r.student_id && Number.isFinite(Number(r.amount))).map((r) => ({
        student_id: r.student_id, academic_year_id: academicYearId, amount: Number(r.amount), notes: r.notes || null
      }));
      if (!payload.length) return err('No valid rows to upload — each row needs a matched student and a numeric amount.');
      const { data, error } = await supabase.from('finance_opening_balances').upsert(payload, { onConflict: 'student_id,academic_year_id' }).select();
      if (error) return err(error.message);
      clearCache();
      return ok(data || []);
    }
  };

  const reports = {
    async dashboard(academicYearId, termId) {
      return cached('dashboard', [academicYearId, termId], async () => {
        const { data, error } = await supabase.rpc('finance_dashboard', { p_academic_year_id: academicYearId || null, p_term_id: termId || null });
        if (error) return err(error.message);
        return ok(data);
      });
    },
    async classBalances(classId, minBalance) {
      const { data, error } = await supabase.rpc('finance_class_balances', { p_class_id: classId || null, p_min_balance: minBalance === undefined || minBalance === null || minBalance === '' ? null : Number(minBalance) });
      if (error) return err(error.message);
      return ok(data || []);
    },
    async voteHeadCollections(academicYearId, termId) {
      return cached('voteHeadCollections', [academicYearId, termId], async () => {
        const { data, error } = await supabase.rpc('finance_vote_head_collections', { p_academic_year_id: academicYearId || null, p_term_id: termId || null });
        if (error) return err(error.message);
        return ok(data || []);
      });
    },
    async cashbook(from, to) {
      return cached('cashbook', [from, to], async () => {
        const { data, error } = await supabase.rpc('finance_cashbook', { p_from: from, p_to: to });
        if (error) return err(error.message);
        return ok(data || []);
      });
    },
    async trialBalance(academicYearId, termId) {
      return cached('trialBalance', [academicYearId, termId], async () => {
        const { data, error } = await supabase.rpc('finance_trial_balance', { p_academic_year_id: academicYearId || null, p_term_id: termId || null });
        if (error) return err(error.message);
        return ok(data || []);
      });
    }
  };

  return {
    /** Idempotent — call once when the Finance module is first opened;
     *  cheap no-op on every subsequent call (see migrations/0031). */
    async bootstrap() {
      const { error } = await supabase.rpc('finance_bootstrap');
      if (error) return err(error.message);
      return ok(true);
    },
    async carryForwardBalances(fromYearId, toYearId) {
      const { data, error } = await supabase.rpc('finance_carry_forward_balances', { p_from_year_id: fromYearId, p_to_year_id: toYearId });
      if (error) return err(error.message);
      clearCache();
      return ok(data);
    },
    voteHeads, routes, feeStructures, invoices, debitNotes, creditNotes, collections, students, reports,
    clearCache
  };
}
