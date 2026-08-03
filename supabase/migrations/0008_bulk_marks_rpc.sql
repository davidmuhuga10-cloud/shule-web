-- ============================================================================
-- 0008_bulk_marks_rpc.sql — Phase 2f: fixes the "marks import takes 4-5
-- minutes" bug.
--
-- Root cause: saveResultsEntry() in src/lib/api/results.mjs saves one
-- student's score at a time — for every entry it awaits a separate
-- select-then-insert-or-update round trip to Supabase before moving to the
-- next. For a single subject that's already ~1 network round trip per
-- student (40 students = 40 sequential round trips); the new Bulk Upload
-- Marks feature (Phase 2e) calls that same function once per subject/paper
-- column, so a class of 40 students across 10 subjects was issuing ~400
-- SEQUENTIAL awaited round trips in a row. At a typical 100-300ms per round
-- trip, that alone accounts for the reported 4-5 minutes — this was never a
-- database performance problem, it was a network-latency-times-N problem.
--
-- Fix: one new RPC, save_results_batch(), that takes the whole scores array
-- in a single call and does the per-student insert/update/delete/grade
-- logic in a server-side PL/pgSQL loop instead of a client-side JS loop —
-- collapsing N round trips into 1 regardless of class size. The per-row
-- logic itself is UNCHANGED (same exists-check, same range validation, same
-- default-scale grading, same "blank clears the row" behaviour) — only
-- WHERE that loop runs has changed, which is what actually fixes the
-- reported slowness without touching what gets saved or how it's graded.
--
-- Deliberately SECURITY INVOKER (the default — no `security definer`
-- clause): the function's own insert/update/delete statements run as the
-- calling user, so the exact same results_staff_write / results_staff_update
-- / results_admin_delete RLS policies that already govern manual marks
-- entry apply here automatically, with zero duplicated authorization logic
-- to keep in sync. school_id is still auto-stamped by the existing
-- trg_results_school_id trigger on the table, same as any other insert.
--
-- Safe to paste as a single script — this adds one function, nothing else.
-- ============================================================================

create or replace function public.save_results_batch(
  p_exam_id uuid, p_class_id uuid, p_subject_id uuid, p_paper_id uuid, p_scores jsonb
)
returns table(saved int, cleared int)
language plpgsql
as $$
declare
  v_exam public.exams%rowtype;
  v_paper public.subject_papers%rowtype;
  v_out_of numeric;
  v_row jsonb;
  v_student_id uuid;
  v_raw text;
  v_score numeric;
  v_existing_id uuid;
  v_saved int := 0;
  v_cleared int := 0;
  v_grade_label text;
  v_points numeric;
  v_remark text;
begin
  if p_exam_id is null then raise exception 'Missing exam.'; end if;
  if p_subject_id is null then raise exception 'Missing subject.'; end if;
  if p_class_id is null then raise exception 'Missing class.'; end if;

  select * into v_exam from public.exams where id = p_exam_id;
  if v_exam.id is null then raise exception 'Exam not found.'; end if;
  v_out_of := coalesce(v_exam.out_of, 100);

  if p_paper_id is not null then
    select * into v_paper from public.subject_papers where id = p_paper_id;
    if v_paper.id is null then raise exception 'Paper not found.'; end if;
    v_out_of := coalesce(v_paper.out_of, 100);
  end if;

  for v_row in select * from jsonb_array_elements(coalesce(p_scores, '[]'::jsonb))
  loop
    v_student_id := nullif(v_row->>'student_id', '')::uuid;
    if v_student_id is null then continue; end if;
    v_raw := trim(both from coalesce(v_row->>'score', ''));

    select id into v_existing_id from public.results
      where exam_id = p_exam_id and subject_id = p_subject_id and student_id = v_student_id
        and ((p_paper_id is null and paper_id is null) or paper_id = p_paper_id)
      limit 1;

    if v_raw = '' then
      if v_existing_id is not null then
        delete from public.results where id = v_existing_id;
        v_cleared := v_cleared + 1;
      end if;
      continue;
    end if;

    -- Same "skip invalid silently" behaviour as the client-side version —
    -- the UI already validates before calling this, this is just the
    -- server-side backstop against a malformed row slipping through.
    begin
      v_score := v_raw::numeric;
    exception when others then
      continue;
    end;
    if v_score < 0 or v_score > v_out_of then continue; end if;

    v_grade_label := null; v_points := null; v_remark := null;
    if p_paper_id is null then
      select gr.grade_label, gr.points, gr.remark into v_grade_label, v_points, v_remark
      from public.grade_ranges gr
      join public.grading_scales gs on gs.id = gr.grading_scale_id
      where gs.is_default = true and gs.school_id = public.current_school_id()
        and v_score >= gr.min_score and v_score <= gr.max_score
      limit 1;
    end if;

    if v_existing_id is not null then
      update public.results set
        score = v_score, grade_label = v_grade_label, points = v_points, remark = v_remark,
        class_id = p_class_id, academic_year_id = v_exam.academic_year_id, term_id = v_exam.term_id
      where id = v_existing_id;
    else
      insert into public.results
        (exam_id, student_id, subject_id, academic_year_id, term_id, class_id, paper_id, score, grade_label, points, remark)
      values
        (p_exam_id, v_student_id, p_subject_id, v_exam.academic_year_id, v_exam.term_id, p_class_id, p_paper_id, v_score, v_grade_label, v_points, v_remark);
    end if;
    v_saved := v_saved + 1;
  end loop;

  return query select v_saved, v_cleared;
end;
$$;

grant execute on function public.save_results_batch(uuid, uuid, uuid, uuid, jsonb) to authenticated;
