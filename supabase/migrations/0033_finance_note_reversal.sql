-- 0033_finance_note_reversal.sql
-- ----------------------------------------------------------------------------
-- Next Sprint 2 §12 (BUG): "No audit trail for debit/credit notes — no way
-- to see or reverse/correct a wrong entry."
--
-- A wrongly-entered debit/credit note is reversed by inserting a NEW,
-- opposite-type note (same student/vote head/year/term) rather than
-- deleting or editing the original in place — so both the mistake and its
-- correction stay on permanent, dated, attributed record, and every one of
-- the several existing balance/report/statement queries that sum these two
-- tables keeps working completely unchanged (a reversed note still counts
-- normally; its opposite note is what brings the balance back to where it
-- should be).
-- ----------------------------------------------------------------------------

alter table public.finance_debit_notes add column reversed_at timestamptz;
alter table public.finance_debit_notes add column reversed_by uuid references public.profiles(id) on delete set null;
alter table public.finance_debit_notes add column reverses_credit_note_id uuid references public.finance_credit_notes(id) on delete set null;
alter table public.finance_credit_notes add column reversed_at timestamptz;
alter table public.finance_credit_notes add column reversed_by uuid references public.profiles(id) on delete set null;
alter table public.finance_credit_notes add column reverses_debit_note_id uuid references public.finance_debit_notes(id) on delete set null;

create or replace function public.finance_reverse_debit_note(p_note_id uuid, p_reason text)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_school uuid := public.current_school_id();
  v_note public.finance_debit_notes%rowtype;
  v_credit_id uuid;
begin
  if not public.finance_can_manage() then raise exception 'Not authorized' using errcode = '42501'; end if;
  select * into v_note from public.finance_debit_notes where id = p_note_id and school_id = v_school;
  if not found then raise exception 'Debit note not found'; end if;
  if v_note.reversed_at is not null then raise exception 'This note has already been reversed'; end if;

  insert into public.finance_credit_notes (school_id, student_id, academic_year_id, term_id, vote_head_id, amount, reason, created_by, reverses_debit_note_id)
    values (v_school, v_note.student_id, v_note.academic_year_id, v_note.term_id, v_note.vote_head_id, v_note.amount,
      trim('Reversal of debit note' || case when coalesce(p_reason, '') <> '' then ': ' || p_reason else '' end),
      auth.uid(), v_note.id)
    returning id into v_credit_id;

  update public.finance_debit_notes set reversed_at = now(), reversed_by = auth.uid() where id = p_note_id;
  return v_credit_id;
end;
$$;

create or replace function public.finance_reverse_credit_note(p_note_id uuid, p_reason text)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_school uuid := public.current_school_id();
  v_note public.finance_credit_notes%rowtype;
  v_debit_id uuid;
begin
  if not public.finance_can_manage() then raise exception 'Not authorized' using errcode = '42501'; end if;
  select * into v_note from public.finance_credit_notes where id = p_note_id and school_id = v_school;
  if not found then raise exception 'Credit note not found'; end if;
  if v_note.reversed_at is not null then raise exception 'This note has already been reversed'; end if;

  insert into public.finance_debit_notes (school_id, student_id, academic_year_id, term_id, vote_head_id, amount, reason, created_by, reverses_credit_note_id)
    values (v_school, v_note.student_id, v_note.academic_year_id, v_note.term_id, v_note.vote_head_id, v_note.amount,
      trim('Reversal of credit note' || case when coalesce(p_reason, '') <> '' then ': ' || p_reason else '' end),
      auth.uid(), v_note.id)
    returning id into v_debit_id;

  update public.finance_credit_notes set reversed_at = now(), reversed_by = auth.uid() where id = p_note_id;
  return v_debit_id;
end;
$$;

grant execute on function public.finance_reverse_debit_note(uuid, text) to authenticated;
grant execute on function public.finance_reverse_credit_note(uuid, text) to authenticated;
