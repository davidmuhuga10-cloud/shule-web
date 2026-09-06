/**
 * inventory.mjs — Finance Expansion brief item 4 ("Inventory Management
 * Module"). See migrations/0056_inventory.sql for the schema and why
 * receive/issue/adjustment/stocktake are one signed-quantity ledger
 * (inventory_transactions) rather than four separate tables, and why
 * permissions reuse finance_can_manage() instead of a new capability.
 *
 * A standalone module (not folded into finance.mjs) because it's a
 * separate concern with its own tables — it only ever REACHES INTO Finance
 * for suppliers (finance_suppliers), never the other way around.
 */
import { ok, err, fromResult, createMemoCache, clearAllCaches } from './_util.mjs';

export function createInventoryApi(supabase) {
  const { cached } = createMemoCache(20000);
  function clearCache() { clearAllCaches(); }

  const categories = {
    async list() {
      return cached('inventory.categories', null, async () => {
        const { data, error } = await supabase.from('inventory_categories').select('*').order('name');
        if (error) return err(error.message);
        return ok(data || []);
      });
    },
    async save(payload) {
      payload = payload || {};
      if (!String(payload.name || '').trim()) return err('Category name is required.');
      const row = { id: payload.id || undefined, name: payload.name.trim(), active: payload.active !== false };
      const res = fromResult(await supabase.from('inventory_categories').upsert(row).select().single());
      if (res.ok) clearCache();
      return res;
    },
    // POST-BUILD FEEDBACK item 7: a real hard delete — the DB's own
    // `on delete restrict` (migrations/0056) already guarantees this fails
    // loudly instead of orphaning items, so the only job here is turning
    // that into a friendly message rather than a raw Postgres error.
    async remove(id) {
      const { error } = await supabase.from('inventory_categories').delete().eq('id', id);
      if (error) {
        if (error.code === '23503') return err('This category is used by at least one inventory item — deactivate it instead, or move those items to a different category first.');
        return err(error.message);
      }
      clearCache();
      return ok(true);
    }
  };

  const units = {
    async list() {
      return cached('inventory.units', null, async () => {
        const { data, error } = await supabase.from('inventory_units').select('*').order('name');
        if (error) return err(error.message);
        return ok(data || []);
      });
    },
    async save(payload) {
      payload = payload || {};
      if (!String(payload.name || '').trim()) return err('Unit name is required.');
      const row = { id: payload.id || undefined, name: payload.name.trim(), active: payload.active !== false };
      const res = fromResult(await supabase.from('inventory_units').upsert(row).select().single());
      if (res.ok) clearCache();
      return res;
    },
    async remove(id) {
      const { error } = await supabase.from('inventory_units').delete().eq('id', id);
      if (error) {
        if (error.code === '23503') return err('This unit is used by at least one inventory item — deactivate it instead, or update those items to a different unit first.');
        return err(error.message);
      }
      clearCache();
      return ok(true);
    }
  };

  const items = {
    async list() {
      const { data, error } = await supabase.from('inventory_items')
        .select('*, inventory_categories(name), inventory_units(name), finance_suppliers(name)')
        .order('name');
      if (error) return err(error.message);
      return ok(data || []);
    },
    async save(payload) {
      payload = payload || {};
      if (!String(payload.name || '').trim()) return err('Item name is required.');
      const row = {
        id: payload.id || undefined, name: payload.name.trim(), sku: payload.sku || null,
        category_id: payload.category_id || null, unit_id: payload.unit_id || null,
        reorder_level: Number(payload.reorder_level) || 0, unit_cost: Number(payload.unit_cost) || 0,
        supplier_id: payload.supplier_id || null, storage_location: payload.storage_location || null,
        active: payload.active !== false
      };
      const res = fromResult(await supabase.from('inventory_items').upsert(row).select().single());
      if (res.ok) clearCache();
      return res;
    }
  };

  const transactions = {
    /** filters: { item_id?, type?, from?, to? } — brief §4.6/§4.10's
     *  movement-history and per-report filtering. */
    async list(filters) {
      filters = filters || {};
      let q = supabase.from('inventory_transactions').select('*, inventory_items(name), staff:created_by(full_name)').order('created_at', { ascending: false });
      if (filters.item_id) q = q.eq('item_id', filters.item_id);
      if (filters.type) q = q.eq('type', filters.type);
      if (filters.from) q = q.gte('created_at', filters.from);
      if (filters.to) q = q.lte('created_at', filters.to + 'T23:59:59');
      const { data, error } = await q.limit(500);
      if (error) return err(error.message);
      return ok(data || []);
    }
  };

  return {
    async bootstrap() {
      const { error } = await supabase.rpc('inventory_bootstrap');
      if (error) return err(error.message);
      return ok(true);
    },
    categories, units, items, transactions,
    async receive(payload) {
      payload = payload || {};
      const { data, error } = await supabase.rpc('inventory_receive', {
        p_item_id: payload.item_id, p_quantity: Number(payload.quantity), p_unit_cost: payload.unit_cost === '' || payload.unit_cost == null ? null : Number(payload.unit_cost),
        p_supplier_id: payload.supplier_id || null, p_reference: payload.reference || null,
        p_location: payload.location || null, p_notes: payload.notes || null, p_date: payload.date || null
      });
      if (error) return err(error.message);
      clearCache();
      return ok(data);
    },
    async issue(payload) {
      payload = payload || {};
      const { data, error } = await supabase.rpc('inventory_issue', {
        p_item_id: payload.item_id, p_quantity: Number(payload.quantity), p_destination: payload.destination || null,
        p_person: payload.person || null, p_reason: payload.reason || null, p_notes: payload.notes || null, p_date: payload.date || null
      });
      if (error) return err(error.message);
      clearCache();
      return ok(data);
    },
    async adjust(payload) {
      payload = payload || {};
      if (!String(payload.reason || '').trim()) return err('A reason is required for a stock adjustment.');
      const { data, error } = await supabase.rpc('inventory_adjust', {
        p_item_id: payload.item_id, p_quantity_delta: Number(payload.quantity_delta), p_reason: payload.reason, p_notes: payload.notes || null, p_date: payload.date || null
      });
      if (error) return err(error.message);
      clearCache();
      return ok(data);
    },
    async stocktake(payload) {
      payload = payload || {};
      const { data, error } = await supabase.rpc('inventory_stocktake', {
        p_item_id: payload.item_id, p_physical_quantity: Number(payload.physical_quantity), p_reason: payload.reason || null, p_notes: payload.notes || null, p_date: payload.date || null
      });
      if (error) return err(error.message);
      clearCache();
      return ok(data);
    },
    clearCache
  };
}
