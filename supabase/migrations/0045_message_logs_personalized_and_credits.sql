-- ---------------------------------------------------------------------------
-- 0045_message_logs_personalized_and_credits.sql
-- Messaging_Overhaul.docx support:
--
--  * item 4 (fee balance messages) and item 6 (personalized exam results,
--    one guardian's own child's marks) both need a SINGLE request that
--    queues many recipients who each get DIFFERENT text — the existing
--    scopes (class/individual_student/individual_staff/broadcast) all
--    assume one shared body for the whole batch. Adds 'personalized' as a
--    recognised recipient_scope for exactly that shape of send.
--  * item 7/8 (SMS History table + per-recipient batch detail) want a
--    "Credits Used" figure per message and per batch. That was previously
--    only ever computed in-memory at debit time and thrown away — stored
--    now on each row itself so history can just sum/display it.
-- ---------------------------------------------------------------------------
alter table public.message_logs add column if not exists credits integer not null default 1;

alter table public.message_logs drop constraint if exists message_logs_scope_check;
alter table public.message_logs add constraint message_logs_scope_check
  check (recipient_scope in ('class', 'individual_student', 'individual_staff', 'broadcast', 'personalized'));
