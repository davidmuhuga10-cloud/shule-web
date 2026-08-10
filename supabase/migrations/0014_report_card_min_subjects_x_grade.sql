-- ============================================================================
-- 0014_report_card_min_subjects_x_grade.sql — Round 2 §10: "an exam cannot
-- be published unless the minimum required number of subjects has at least
-- one student's results uploaded; students who sat fewer subjects than the
-- set minimum should automatically receive an 'X' grade for that exam."
--
-- The publish-gate half of this rule and the class broadsheet's auto-"X"
-- overall_grade were already implemented in src/lib/api/results.mjs
-- (publishExam()/getBroadsheet(), via a new resolveMinSubjects() helper).
-- This migration brings the get_report_card() RPC — an individual student's
-- own report card view — into line with that same logic, which it had
-- drifted from:
--
--   1. v_min_subjects now resolves with the SAME precedence the JS uses: a
--      per-(exam,class) override on exam_classes.min_subjects wins when
--      set, otherwise falls back to the school-wide
--      settings.min_subjects_for_ranking row. Previously this RPC only ever
--      read the global setting and ignored any per-class override.
--   2. overall_grade is now forced to 'X' when the student's own subject
--      count for this exam is below the resolved minimum — previously this
--      RPC computed overall_grade purely from the numeric average with no
--      below-minimum branch at all, even though the exam_classes.min_subjects
--      column comment already documented the intent ("below this, a student
--      is excluded from ranking (shown as X)").
--   3. A new 'below_minimum' boolean is added to the returned jsonb, so
--      callers (e.g. report-card rendering) can style/flag it without
--      re-deriving the comparison themselves — matching the same field
--      already added to getBroadsheet()'s per-student rows.
--
-- Ranking behaviour (excluding below-minimum students from class position)
-- was already correct in this RPC and is unchanged here.
--
-- This is a full create-or-replace of the function — safe to re-run.
-- ============================================================================

create or replace function public.get_report_card(p_exam_id uuid, p_student_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role user_role;
  v_own_student_id uuid;
  v_caller_school uuid;
  v_student public.students%rowtype;
  v_exam public.exams%rowtype;
  v_class public.classes%rowtype;
  v_stream public.streams%rowtype;
  v_year public.academic_years%rowtype;
  v_term public.terms%rowtype;
  v_subjects jsonb;
  v_total numeric := 0;
  v_count int := 0;
  v_average numeric := 0;
  v_overall_grade text;
  v_position int;
  v_class_size int;
  v_authorized boolean := false;
  v_staff_view boolean;
  v_min_subjects int := 0;
  v_below_minimum boolean := false;
begin
  v_role := public.current_role();
  v_own_student_id := public.current_student_id();
  v_caller_school := public.current_school_id();

  if v_role is null or v_caller_school is null then
    raise exception 'Not authorized to view this report card' using errcode = '42501';
  end if;

  if v_role in ('admin', 'teacher') then
    v_authorized := true;
  elsif v_role = 'student' and v_own_student_id is not distinct from p_student_id then
    v_authorized := true;
  elsif v_role = 'parent' and p_student_id = any(public.current_parent_student_ids()) then
    v_authorized := true;
  end if;
  if not v_authorized then
    raise exception 'Not authorized to view this report card' using errcode = '42501';
  end if;
  v_staff_view := v_role in ('admin', 'teacher');

  select * into v_student from public.students where id = p_student_id and school_id = v_caller_school;
  if not found then raise exception 'Student not found'; end if;

  select * into v_exam from public.exams where id = p_exam_id and school_id = v_caller_school;
  if not found then raise exception 'Exam not found'; end if;

  select * into v_class from public.classes where id = v_student.class_id;
  select * into v_stream from public.streams where id = v_student.stream_id;
  select * into v_year from public.academic_years where id = v_exam.academic_year_id;
  select * into v_term from public.terms where id = v_exam.term_id;

  -- Resolve the minimum-subjects rule with the same precedence the JS
  -- broadsheet/publish-gate uses: a per-(exam,class) override on
  -- exam_classes.min_subjects wins when set; otherwise fall back to the
  -- school-wide settings row. Keeps this RPC's report card consistent with
  -- getBroadsheet()/resolveMinSubjects() in src/lib/api/results.mjs.
  select ec.min_subjects into v_min_subjects
    from public.exam_classes ec
    where ec.exam_id = p_exam_id and ec.class_id = v_student.class_id;

  if v_min_subjects is null then
    select coalesce(nullif(value, '')::int, 0) into v_min_subjects
      from public.settings where school_id = v_caller_school and key = 'min_subjects_for_ranking';
  end if;
  if v_min_subjects is null then v_min_subjects := 0; end if;

  with per_row as (
    select
      r.subject_id,
      coalesce(s.name, '(deleted)') as subject_name,
      r.score,
      coalesce(sp.weight, 1) as weight,
      coalesce(sp.out_of, v_exam.out_of, 100) as row_out_of
    from public.results r
    left join public.subjects s on s.id = r.subject_id
    left join public.subject_papers sp on sp.id = r.paper_id
    where r.exam_id = p_exam_id and r.student_id = p_student_id and r.school_id = v_caller_school
      and r.score is not null
      and (v_staff_view or exists (
        select 1 from public.result_submissions rs2
        where rs2.exam_id = r.exam_id and rs2.class_id = r.class_id and rs2.subject_id = r.subject_id
          and rs2.status = 'published'
      ))
  ),
  per_subject as (
    select subject_id, subject_name, sum(score * weight / row_out_of * v_exam.out_of) as effective_score
    from per_row
    group by subject_id, subject_name
  ),
  graded as (
    select ps.subject_id, ps.subject_name, ps.effective_score, gr.grade_label, gr.points, gr.remark
    from per_subject ps
    left join lateral (
      select gr.grade_label, gr.points, gr.remark
      from public.grade_ranges gr
      join public.grading_scales gs on gs.id = gr.grading_scale_id
      where gs.is_default = true and gs.school_id = v_caller_school
        and ps.effective_score >= gr.min_score and ps.effective_score <= gr.max_score
      limit 1
    ) gr on true
  )
  select
    coalesce(jsonb_agg(jsonb_build_object(
      'subject_id', subject_id, 'subject_name', subject_name,
      'score', round(effective_score, 2), 'grade_label', coalesce(grade_label, ''),
      'points', points, 'remark', coalesce(remark, '')
    ) order by subject_name), '[]'::jsonb),
    coalesce(sum(effective_score), 0),
    count(*)
  into v_subjects, v_total, v_count
  from graded;

  v_average := case when v_count > 0 then round(v_total / v_count, 2) else 0 end;

  select grade_label into v_overall_grade
    from public.grade_ranges gr
    join public.grading_scales gs on gs.id = gr.grading_scale_id and gs.is_default = true and gs.school_id = v_caller_school
    where v_average >= gr.min_score and v_average <= gr.max_score
    limit 1;


  -- Round 2 §10: a student who sat fewer subjects than the required minimum
  -- automatically gets an "X" overall grade for this exam, mirroring
  -- getBroadsheet()'s belowMinimum logic in src/lib/api/results.mjs.
  v_below_minimum := v_min_subjects > 0 and v_count < v_min_subjects;
  if v_below_minimum then
    v_overall_grade := 'X';
  end if;

  with cohort as (
    select
      st.id,
      coalesce((
        select sum(r2.score * coalesce(sp2.weight, 1) / coalesce(sp2.out_of, v_exam.out_of, 100) * v_exam.out_of)
        from public.results r2
        left join public.subject_papers sp2 on sp2.id = r2.paper_id
        where r2.exam_id = p_exam_id and r2.student_id = st.id and r2.school_id = v_caller_school
          and r2.score is not null
          and exists (
            select 1 from public.result_submissions rs3
            where rs3.exam_id = r2.exam_id and rs3.class_id = r2.class_id and rs3.subject_id = r2.subject_id
              and rs3.status = 'published'
          )
      ), 0) as total,
      (
        select count(distinct r3.subject_id)
        from public.results r3
        where r3.exam_id = p_exam_id and r3.student_id = st.id and r3.school_id = v_caller_school
          and r3.score is not null
          and exists (
            select 1 from public.result_submissions rs4
            where rs4.exam_id = r3.exam_id and rs4.class_id = r3.class_id and rs4.subject_id = r3.subject_id
              and rs4.status = 'published'
          )
      ) as subject_count
    from public.students st
    where st.class_id = v_student.class_id and st.status = 'active' and st.school_id = v_caller_school
  ),
  ranked as (
    select id, total, rank() over (order by total desc) as pos
    from cohort
    where total > 0 and subject_count >= v_min_subjects
  )
  select (select pos from ranked where id = p_student_id),
         (select count(*) from ranked)
    into v_position, v_class_size;

  return jsonb_build_object(
    'student', jsonb_build_object(
      'full_name', v_student.full_name, 'admission_no', v_student.admission_no,
      'class_name', coalesce(v_class.name, ''), 'stream_name', coalesce(v_stream.name, ''),
      'gender', v_student.gender
    ),
    'exam', jsonb_build_object('name', v_exam.name, 'out_of', v_exam.out_of, 'exam_type', v_exam.exam_type),
    'session_name', coalesce(v_year.name, ''), 'term_name', coalesce(v_term.name, ''),
    'subjects', v_subjects, 'total', v_total, 'average', v_average,
    'overall_grade', coalesce(v_overall_grade, ''), 'position', v_position,
    'class_size', coalesce(v_class_size, 0), 'below_minimum', v_below_minimum
  );
end;
$$;
grant execute on function public.get_report_card(uuid, uuid) to authenticated;
