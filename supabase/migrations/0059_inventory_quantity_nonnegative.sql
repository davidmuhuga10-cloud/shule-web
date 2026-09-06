-- ============================================================================
-- 0059_inventory_quantity_nonnegative.sql
-- ----------------------------------------------------------------------------
-- POST-BUILD FEEDBACK item 7: "what happens when stock hits exactly zero?
-- Can it go negative by mistake?" Every RPC path (receive/issue/adjust/
-- stocktake) already guards this correctly. But inventory_items has a
-- client-facing UPDATE policy (gated on finance_can_manage(), for editing
-- name/SKU/category/reorder level/etc. — see financeInventory.mjs's Edit
-- Item form), and nothing at the column level stops a direct API call from
-- setting quantity to a negative number outside those RPCs. A CHECK
-- constraint closes that for good, at zero cost to the normal flows (none
-- of them can ever produce a negative result anyway).
-- ============================================================================

begin;

alter table public.inventory_items
  add constraint inventory_items_quantity_nonneg check (quantity >= 0);

commit;
