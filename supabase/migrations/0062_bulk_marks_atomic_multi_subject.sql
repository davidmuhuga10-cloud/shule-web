-- ============================================================================
-- 0062_bulk_marks_atomic_multi_subject.sql
--
-- BUG (reported live, 120 students x 11 subjects — reproduced at 200 x 15):
-- Bulk Upload Marks' import button (marksEntry.mjs renderBulkPreview) saves
-- one subject/paper column at a time, in a client-side loop, awaiting
-- Db.results.saveResultsEntry() (the existing save_results_batch() RPC) once
-- per column:
--
--     for (const c of columns) {
--       const r = await Db.results.saveResultsEntry({ ...subject_id: c.subject_id, scores });
--       if (r.ok) saved += r.saved;
--     }
--     toast(`Imported ${saved} mark(s).`, 'ok');
--     ...  "Import complete" ...  (unconditionally — see marksEntry.mjs fix)
--
-- With 11-15 separate sequential network round trips (one per subject), any
-- one of them can fail — a dropped connection, a timeout, a transient RLS/
-- server hiccup — and the loop's `if (r.ok) saved += r.saved` silently
-- SKIPS a failed column and keeps going to the next one, never recording
-- that anything went wrong. The final screen then unconditionally shows a
-- green "Import complete" regardless of how many of the 11-15 calls actually
-- failed. That's the exact bug reported: "it told me all results uploaded,
-- yet some subjects were still missing some results, and some came empty."
--
-- The client-side half of the fix (track/report per-column failures instead
-- of silently swallowing them) is in marksEntry.mjs. But that alone still
-- leaves a class half-imported if the connection drops midway — subjects
-- already saved stay saved, subjects not yet reached never run, matching
-- "if network is lost nothing should be uploaded" only by luck of timing.
--
-- Real fix: collapse the whole multi-subject import into ONE RPC call
-- (save_results_batch_multi), covering every subject/paper column's scores
-- in a single jsonb payload. A single PL/pgSQL function body is one implicit
-- transaction — if it raises partway through (or the connection drops before
-- the single request completes), EVERYTHING it did rolls back automatically;
-- there is no way for 6 of 15 subjects to end up committed while the other 9
-- silently vanish, because there is now only one atomic unit of work, not 15
-- independent ones. This also means "network is lost" now surfaces as one
-- clear failed request (caller sees r.ok === false) rather than N partial
-- results scattered across N round trips.
--
-- Per-row logic is copied verbatim from save_results_batch() (same
-- exists-check, same range validation, same default-scale grading, same
-- "blank clears the row" behaviour) — this only changes WHERE the
-- subject-level loop runs (nested inside one function instead of driven by
-- N client-side calls), same kind of change 0008_bulk_marks_rpc.sql already
-- made one level up.
--
-- Deliberately SECURITY INVOKER (the default) for the same reason
-- 0008_bulk_marks_rpc.sql gives: results_staff_write/update/admin_delete RLS
-- policies apply exactly as they do for manual entry, no duplicated
-- authorization logic.
-- ============================================================================

create or replace function public.save_results_batch_multi(
  p_exam_id uuid, p_class_id uuid, p_entries jsonb
)
returns table(subject_id uuid, paper_id uuid, saved int, cleared int)
language plpgsql
as $$
declare
  v_exam public.exams%rowtype;
  v_entry jsonb;
  v_subject_id uuid;
  v_paper_id uuid;
  v_scores jsonb;
  v_paper public.subject_papers%rowtype;
  v_out_of numeric;
  v_row jsonb;
  v_student_id uuid;
  v_raw text;
  v_score numeric;
  v_existing_id uuid;
  v_saved int;
  v_cleared int;
  v_grade_label text;
  v_points numeric;
  v_remark text;
begin
  if p_exam_id is null then raise exception 'Missing exam.'; end if;
  if p_class_id is null then raise exception 'Missing class.'; end if;

  select * into v_exam from public.exams where id = p_exam_id;
  if v_exam.id is null then raise exception 'Exam not found.'; end if;

  for v_entry in select * from jsonb_array_elements(coalesce(p_entries, '[]'::jsonb))
  loop
    v_subject_id := nullif(v_entry->>'subject_id', '')::uuid;
    if v_subject_id is null then continue; end if;
    v_paper_id := nullif(v_entry->>'paper_id', '')::uuid;
    v_scores := coalesce(v_entry->'scores', '[]'::jsonb);

    v_out_of := coalesce(v_exam.out_of, 100);
    v_paper := null;
    if v_paper_id is not null then
      select * into v_paper from public.subject_papers where id = v_paper_id;
      if v_paper.id is null then raise exception 'Paper not found for one of the uploaded subjects.'; end if;
      v_out_of := coalesce(v_paper.out_of, 100);
    end if;

    v_saved := 0; v_cleared := 0;

    for v_row in select * from jsonb_array_elements(v_scores)
    loop
      v_student_id := nullif(v_row->>'student_id', '')::uuid;
      if v_student_id is null then continue; end if;
      v_raw := trim(both from coalesce(v_row->>'score', ''));

      -- Table alias + qualified columns: the function's own OUT parameters
      -- are named subject_id/paper_id (same names as the results table's
      -- columns), which PL/pgSQL resolves ambiguously against an
      -- unqualified column reference here — qualifying via "res." avoids
      -- that "column reference is ambiguous" error entirely.
      select res.id into v_existing_id from public.results res
        where res.exam_id = p_exam_id and res.subject_id = v_subject_id and res.student_id = v_student_id
          and ((v_paper_id is null and res.paper_id is null) or res.paper_id = v_paper_id)
        limit 1;

      if v_raw = '' then
        if v_existing_id is not null then
          delete from public.results where id = v_existing_id;
          v_cleared := v_cleared + 1;
        end if;
        continue;
      end if;

      begin
        v_score := v_raw::numeric;
      exception when others then
        continue;
      end;
      if v_score < 0 or v_score > v_out_of then continue; end if;

      v_grade_label := null; v_points := null; v_remark := null;
      if v_paper_id is null then
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
          (p_exam_id, v_student_id, v_subject_id, v_exam.academic_year_id, v_exam.term_id, p_class_id, v_paper_id, v_score, v_grade_label, v_points, v_remark);
      end if;
      v_saved := v_saved + 1;
    end loop;

    subject_id := v_subject_id; paper_id := v_paper_id; saved := v_saved; cleared := v_cleared;
    return next;
  end loop;
end;
$$;

grant execute on function public.save_results_batch_multi(uuid, uuid, jsonb) to authenticated;
