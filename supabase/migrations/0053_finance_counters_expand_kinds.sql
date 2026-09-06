-- ============================================================================
-- 0053_finance_counters_expand_kinds.sql
-- ----------------------------------------------------------------------------
-- Found by live testing 0052 (rollback-wrapped, caught before it could ever
-- reach a real school): finance_counters.kind has a check constraint
-- allow-listing only 'receipt' and 'invoice'. finance_record_lpo/
-- _expense/_expense_payment (0052) all call finance_next_no() with new
-- kinds ('lpo', 'expense', 'voucher') that constraint didn't know about —
-- every one of those RPCs would have failed on its very first call.
-- Widening the allow-list, not dropping it, so a future typo'd kind still
-- gets caught the same way this one was.
-- ============================================================================

begin;

alter table public.finance_counters drop constraint finance_counters_kind_check;
alter table public.finance_counters add constraint finance_counters_kind_check
  check (kind in ('receipt', 'invoice', 'lpo', 'expense', 'voucher'));

commit;
