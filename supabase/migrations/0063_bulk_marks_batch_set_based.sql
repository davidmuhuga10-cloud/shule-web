-- ============================================================================
-- 0063_bulk_marks_batch_set_based.sql
--
-- PERF FIX (found while investigating "Reports and Exams feel slower after
-- recent changes"): 0062_bulk_marks_atomic_multi_subject.sql's
-- save_results_batch_multi() is correct (it IS atomic — see that migration's
-- own verification notes) but processes every cell ONE AT A TIME inside a
-- pair of nested PL/pgSQL loops: for each of up to ~15 subject/paper
-- columns, for each of up to ~200 students, it runs one SELECT (does a row
-- already exist?) and then one INSERT or UPDATE — up to ~6000 individual
-- statement executions for one 200-student x 15-subject import. Measured
-- live against this project: a 200x15 (3000-cell) import took 2.9 seconds,
-- the single slowest endpoint logged anywhere in the project.
--
-- This redefines the SAME function (same name, same signature, same return
-- shape, same grant — no caller changes needed in results.mjs/marksEntry.mjs)
-- to do the whole import as a handful of SET-BASED statements instead:
--   1. Flatten the incoming jsonb payload into one row per (subject, paper,
--      student, raw score) in a single temp table — one statement instead
--      of a nested loop.
--   2. Validate every referenced paper up front (same "raise -> the whole
--      batch rolls back" guarantee the row-by-row version had).
--   3. Normalize each row's out_of and parsed numeric score in one more
--      set-based pass.
--   4. Bulk-delete the "blank cell -> clear this student's existing mark"
--      rows in ONE statement (matched via `paper_id IS NOT DISTINCT FROM`,
--      a null-safe equality — no unique-constraint gymnastics needed for
--      this half, since DELETE doesn't need an ON CONFLICT arbiter).
--   5. Look up each valid row's grade (subject-level rows only) in one
--      set-based LATERAL join instead of a correlated subquery run once per
--      cell.
--   6. Bulk upsert the valid rows in exactly two INSERT ... ON CONFLICT
--      statements — one for paper_id IS NULL rows, one for paper_id IS NOT
--      NULL rows, because a single INSERT's ON CONFLICT can only target one
--      arbiter index, and paper-less vs paper-scoped rows are uniquely
--      constrained by two DIFFERENT partial unique indexes that already
--      exist on `results` (idx_results_unique_no_paper /
--      idx_results_unique_with_paper — see 0046_perf_indexes.sql lineage),
--      so no new schema/constraint changes are needed here at all.
--
-- Per-row validation/behaviour is unchanged from 0062: a blank cell clears
-- any existing mark, a value outside [0, out_of] is silently skipped (not
-- saved, not an error), a nonexistent paper_id aborts the WHOLE batch (same
-- atomicity the original migration verified live), and only paper-less
-- (subject-level) rows get auto-graded against the school's default scale.
-- The one deliberately-accepted behaviour narrowing: the row-by-row version
-- accepted anything Postgres' `::numeric` cast would parse (so a stray
-- trailing-dot value like "5." or scientific notation would parse before
-- being range-checked); this version pattern-matches plain unsigned
-- decimals (e.g. "84", "84.5") up front, which is what every real marks
-- sheet actually contains — anything else is treated as garbage input and
-- skipped, exactly as an out-of-range value already was.
-- ============================================================================

create or replace function public.save_results_batch_multi(
  p_exam_id uuid, p_class_id uuid, p_entries jsonb
)
returns table(subject_id uuid, paper_id uuid, saved int, cleared int)
language plpgsql
as $$
declare
  v_exam public.exams%rowtype;
begin
  if p_exam_id is null then raise exception 'Missing exam.'; end if;
  if p_class_id is null then raise exception 'Missing class.'; end if;

  select * into v_exam from public.exams where id = p_exam_id;
  if v_exam.id is null then raise exception 'Exam not found.'; end if;

  -- Defensive: each of these is declared `on commit drop` below, which only
  -- actually cleans them up once the CALLER'S transaction commits. A normal
  -- PostgREST/Supabase RPC call is its own transaction, so that's the usual
  -- case — but two calls to this function inside one longer-lived
  -- transaction (a future caller batching several RPCs, a test harness,
  -- etc.) would otherwise hit "relation already exists" on the second call.
  -- Dropping up front makes the function correct either way.
  drop table if exists t_flat, t_all_entries, t_norm, t_cleared, t_valid, t_saved;

  -- One row per (subject, paper, student, raw score) — a single set-based
  -- unnest of the whole payload instead of a nested loop.
  create temporary table t_flat on commit drop as
  select
    (e->>'subject_id')::uuid as subject_id,
    nullif(e->>'paper_id', '')::uuid as paper_id,
    (r->>'student_id')::uuid as student_id,
    trim(both from coalesce(r->>'score', '')) as raw_score
  from jsonb_array_elements(coalesce(p_entries, '[]'::jsonb)) as e
  cross join lateral jsonb_array_elements(coalesce(e->'scores', '[]'::jsonb)) as r
  where nullif(e->>'subject_id', '') is not null and nullif(r->>'student_id', '') is not null;

  -- Same atomicity guarantee 0062 verified live: any one bad paper_id in
  -- the whole sheet raises here, before anything is written, rolling back
  -- the entire call.
  -- Table alias + qualified columns: the function's own OUT parameters are
  -- named subject_id/paper_id (same names as several tables' own columns
  -- here), which PL/pgSQL resolves ambiguously against an unqualified
  -- column reference — same lesson 0062 already learned the hard way,
  -- applied everywhere below too.
  if exists (
    select 1 from (select distinct tf.paper_id from t_flat tf where tf.paper_id is not null) d
    where not exists (select 1 from public.subject_papers sp where sp.id = d.paper_id)
  ) then
    raise exception 'Paper not found for one of the uploaded subjects.';
  end if;

  -- Every entry the caller sent, even a column with zero scores — kept
  -- separate from t_flat (which only has rows that actually carry a
  -- student+score) so the returned summary still has a row for every
  -- column, matching the original per-entry `return next` behaviour.
  create temporary table t_all_entries on commit drop as
  select distinct (e->>'subject_id')::uuid as subject_id, nullif(e->>'paper_id', '')::uuid as paper_id
  from jsonb_array_elements(coalesce(p_entries, '[]'::jsonb)) as e
  where nullif(e->>'subject_id', '') is not null;

  -- Normalize: each row's applicable out_of (paper's own, else the exam's,
  -- else 100 — same fallback chain 0062 used) and its parsed numeric score
  -- (null for a blank cell or anything that isn't a plain decimal).
  create temporary table t_norm on commit drop as
  select
    f.subject_id, f.paper_id, f.student_id, f.raw_score,
    case when f.paper_id is not null then coalesce(sp.out_of, 100) else coalesce(v_exam.out_of, 100) end as out_of,
    case
      when f.raw_score = '' then null
      when f.raw_score ~ '^[0-9]+(\.[0-9]+)?$' then f.raw_score::numeric
      else null
    end as v_score
  from t_flat f
  left join public.subject_papers sp on sp.id = f.paper_id;

  -- Clear: a blank cell deletes any existing mark for that (subject/paper,
  -- student) — one bulk statement instead of one DELETE per blanked cell.
  -- `paper_id IS NOT DISTINCT FROM` is the null-safe equality DELETE needs
  -- here (it has no ON CONFLICT arbiter to worry about, unlike the upserts
  -- below).
  create temporary table t_cleared on commit drop as
  with c as (
    delete from public.results res
    using t_norm t
    where t.raw_score = ''
      and res.exam_id = p_exam_id
      and res.subject_id = t.subject_id
      and res.student_id = t.student_id
      and res.paper_id is not distinct from t.paper_id
    returning res.subject_id, res.paper_id
  )
  select c.subject_id, c.paper_id, count(*)::int as cleared from c group by c.subject_id, c.paper_id;

  -- Valid rows to save: a parsed score within [0, out_of]. Subject-level
  -- (paper_id is null) rows also get graded against the school's default
  -- scale here, in one set-based LATERAL join instead of a correlated
  -- subquery re-run for every single cell.
  create temporary table t_valid on commit drop as
  select
    t.subject_id, t.paper_id, t.student_id, t.v_score,
    gr.grade_label, gr.points, gr.remark
  from t_norm t
  left join lateral (
    select gr2.grade_label, gr2.points, gr2.remark
    from public.grade_ranges gr2
    join public.grading_scales gs on gs.id = gr2.grading_scale_id
    where t.paper_id is null
      and gs.is_default = true and gs.school_id = public.current_school_id()
      and t.v_score >= gr2.min_score and t.v_score <= gr2.max_score
    limit 1
  ) gr on true
  where t.v_score is not null and t.v_score >= 0 and t.v_score <= t.out_of;

  create temporary table t_saved on commit drop as
  select v.subject_id, v.paper_id, count(*)::int as saved from t_valid v group by v.subject_id, v.paper_id;

  -- Bulk upsert, paper-less rows — matched against idx_results_unique_no_paper.
  -- Run via EXECUTE (dynamic SQL): the ON CONFLICT column list AND its
  -- arbiter predicate both need a bare, unqualified `subject_id`/`paper_id`
  -- (no table-alias workaround is possible in either position — unlike a
  -- plain WHERE clause elsewhere in this function), which collides with
  -- this function's own subject_id/paper_id OUT parameters. A dynamic
  -- EXECUTE string is opaque to PL/pgSQL's static variable resolution, so
  -- inside it those names unambiguously mean the `results` table's columns
  -- — the standard workaround for this exact class of Postgres ambiguity.
  execute
    'insert into public.results
       (exam_id, student_id, subject_id, academic_year_id, term_id, class_id, paper_id, score, grade_label, points, remark)
     select $1, v.student_id, v.subject_id, $2, $3, $4, null, v.v_score, v.grade_label, v.points, v.remark
     from t_valid v
     where v.paper_id is null
     on conflict (exam_id, student_id, subject_id) where paper_id is null
     do update set
       score = excluded.score, grade_label = excluded.grade_label, points = excluded.points, remark = excluded.remark,
       class_id = excluded.class_id, academic_year_id = excluded.academic_year_id, term_id = excluded.term_id'
    using p_exam_id, v_exam.academic_year_id, v_exam.term_id, p_class_id;

  -- Bulk upsert, paper-scoped rows — matched against idx_results_unique_with_paper.
  execute
    'insert into public.results
       (exam_id, student_id, subject_id, academic_year_id, term_id, class_id, paper_id, score, grade_label, points, remark)
     select $1, v.student_id, v.subject_id, $2, $3, $4, v.paper_id, v.v_score, v.grade_label, v.points, v.remark
     from t_valid v
     where v.paper_id is not null
     on conflict (exam_id, student_id, subject_id, paper_id) where paper_id is not null
     do update set
       score = excluded.score, grade_label = excluded.grade_label, points = excluded.points, remark = excluded.remark,
       class_id = excluded.class_id, academic_year_id = excluded.academic_year_id, term_id = excluded.term_id'
    using p_exam_id, v_exam.academic_year_id, v_exam.term_id, p_class_id;

  return query
  select e.subject_id, e.paper_id,
    coalesce(sv.saved, 0) as saved,
    coalesce(cl.cleared, 0) as cleared
  from t_all_entries e
  left join t_saved sv on sv.subject_id = e.subject_id and sv.paper_id is not distinct from e.paper_id
  left join t_cleared cl on cl.subject_id = e.subject_id and cl.paper_id is not distinct from e.paper_id;
end;
$$;

grant execute on function public.save_results_batch_multi(uuid, uuid, jsonb) to authenticated;
