-- ============================================================================
-- 0058_inventory_taxonomy_delete.sql
-- ----------------------------------------------------------------------------
-- POST-BUILD FEEDBACK item 7: "if a school doesn't use certain categories
-- or units of measure, can they actually delete them? Was this built with
-- real flexibility in mind, or with a fixed list?" Today they can't — no
-- DELETE policy exists on either table at all (RLS defaults to deny), so
-- inventory_bootstrap()'s 8 default units / 10 default categories are
-- permanently stuck. Unlike Accounting's Account Types/Vote Heads/Accounts
-- (deliberately deactivate-only, since real MONEY is posted against them
-- the moment they're used), a category or unit is plain taxonomy — the
-- existing `on delete restrict` on inventory_items.category_id/unit_id
-- already guarantees the DB itself refuses to delete one that's actually
-- in use, so a real hard delete is safe to expose here, matching the
-- "genuine flexibility" the review asked for.
-- ============================================================================

begin;

create policy inventory_categories_delete on public.inventory_categories for delete
  using (public.finance_can_manage() and school_id = public.current_school_id());
create policy inventory_units_delete on public.inventory_units for delete
  using (public.finance_can_manage() and school_id = public.current_school_id());

commit;
