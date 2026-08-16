-- 0029_grade_report_card_rounded.sql
-- Sprint Review bug: "Combined Subjects Sometimes Missing Performance
-- Level" — the SST/CRE-style combined-subject column would sometimes show
-- a raw number with no grade letter while every other student in that
-- column had one. Root cause: a Subject Combination's score is a weighted
-- sum and very often lands on a decimal (e.g. 84.6); this function graded
-- that RAW fraction against integer grade-range bands (…73-84, 85-100…),
-- which have no band covering the fractional gap between adjacent
-- boundaries, so some students fell through with no grade at all — while
-- a classmate whose combo score happened to round to a whole number was
-- fine. Fix: grade off round(effective_score), the same whole number this
-- function already displays, instead of the raw fraction. Same bug/fix
-- applied on the JS side (src/lib/api/results.mjs's getBroadsheet, for
-- the Mark List) in this same round.
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
  -- Round 5 §3: Subject Combination — fold 2+ member subjects' effective
  -- scores into ONE combined entry, exactly like getBroadsheet() does.
  combo_defs as (
    select sc.id as combo_id, sc.name as combo_name, scm.subject_id, scm.weight
    from public.subject_combinations sc
    join public.subject_combination_members scm on scm.combination_id = sc.id
    where sc.exam_id = p_exam_id
  ),
  combo_member_count as (
    select combo_id, count(*) as n_members from combo_defs group by combo_id
  ),
  -- A combo only activates here when EVERY one of its members is present in
  -- per_subject (i.e. actually visible to this caller — see the comment at
  -- the top of this migration) AND it has at least 2 members configured.
  combo_active as (
    select cd.combo_id, min(cd.combo_name) as combo_name
    from combo_defs cd
    join combo_member_count cmc on cmc.combo_id = cd.combo_id
    join per_subject ps on ps.subject_id = cd.subject_id
    group by cd.combo_id
    having count(*) = min(cmc.n_members) and min(cmc.n_members) >= 2
  ),
  combo_scores as (
    select ca.combo_id, ca.combo_name, sum(ps.effective_score * coalesce(cd.weight, 0)) as effective_score
    from combo_active ca
    join combo_defs cd on cd.combo_id = ca.combo_id
    join per_subject ps on ps.subject_id = cd.subject_id
    group by ca.combo_id, ca.combo_name
  ),
  combo_member_ids as (
    select distinct cd.subject_id
    from combo_defs cd
    join combo_active ca on ca.combo_id = cd.combo_id
  ),
  final_subjects as (
    select ps.subject_id::text as subject_id, ps.subject_name, ps.effective_score
    from per_subject ps
    where not exists (select 1 from combo_member_ids cmi where cmi.subject_id = ps.subject_id)
    union all
    select 'combo:' || cs.combo_id::text, cs.combo_name, cs.effective_score
    from combo_scores cs
  ),
  graded as (
    select fs.subject_id, fs.subject_name, fs.effective_score, gr.grade_label, gr.points, gr.remark
    from final_subjects fs
    left join lateral (
      -- Sprint Review bug fix: grade off round(fs.effective_score), not the
      -- raw fraction — a Subject Combination's weighted-sum score very
      -- often lands on a decimal (e.g. 84.6), and integer grade-range
      -- bands (…73-84, 85-100…) have no band covering that fraction, so
      -- some students silently got no Performance Level at all while a
      -- classmate whose combo score happened to round to a whole number
      -- was fine. Grading off the same whole number this function already
      -- displays ('score', round(effective_score) below) closes the gap.
      select gr.grade_label, gr.points, gr.remark
      from public.grade_ranges gr
      join public.grading_scales gs on gs.id = gr.grading_scale_id
      where gs.is_default = true and gs.school_id = v_caller_school
        and round(fs.effective_score) >= gr.min_score and round(fs.effective_score) <= gr.max_score
      limit 1
    ) gr on true
  )
  select
    coalesce(jsonb_agg(jsonb_build_object(
      'subject_id', subject_id, 'subject_name', subject_name,
      'score', round(effective_score), 'grade_label', coalesce(grade_label, ''),
      'points', points, 'remark', coalesce(remark, '')
    ) order by subject_name), '[]'::jsonb),
    coalesce(sum(effective_score), 0),
    count(*)
  into v_subjects, v_total, v_count
  from graded;

  v_average := case when v_count > 0 then round(v_total / v_count) else 0 end;

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

  -- Round 5 §3: ranking totals must fold Subject Combinations exactly the
  -- same way the viewed student's own subject list was folded above —
  -- otherwise a classmate's ranking total would count a combo's member
  -- subjects individually (unweighted) while the viewed student's own
  -- total/average uses the weighted combined figure, producing a position
  -- that doesn't actually match either number shown on screen. Re-derives
  -- the same combo_defs/combo_active/combo_member_ids sets used above (a
  -- separate `with` statement can't see the earlier one's CTEs) — combo
  -- activation is evaluated against the VIEWED student's own subjects
  -- (matches "this combo is configured and showing for this class/exam" in
  -- the overwhelmingly common case where every student in a class sits the
  -- same subjects) and applied uniformly to every classmate's total below.
  with combo_defs as (
    select sc.id as combo_id, scm.subject_id, scm.weight
    from public.subject_combinations sc
    join public.subject_combination_members scm on scm.combination_id = sc.id
    where sc.exam_id = p_exam_id
  ),
  combo_member_count as (
    select combo_id, count(*) as n_members from combo_defs group by combo_id
  ),
  combo_active as (
    select cd.combo_id
    from combo_defs cd
    join combo_member_count cmc on cmc.combo_id = cd.combo_id
    join public.results vr on vr.subject_id = cd.subject_id and vr.exam_id = p_exam_id and vr.student_id = p_student_id
      and vr.school_id = v_caller_school and vr.score is not null
      and exists (
        select 1 from public.result_submissions vrs
        where vrs.exam_id = vr.exam_id and vrs.class_id = vr.class_id and vrs.subject_id = vr.subject_id and vrs.status = 'published'
      )
    group by cd.combo_id
    having count(*) = min(cmc.n_members) and min(cmc.n_members) >= 2
  ),
  combo_member_ids as (
    select distinct cd.subject_id
    from combo_defs cd
    join combo_active ca on ca.combo_id = cd.combo_id
  ),
  cohort as (
    select st.id, coalesce(agg.total, 0) as total, coalesce(agg.subject_count, 0) as subject_count
    from public.students st
    left join lateral (
      with per_row2 as (
        select r2.subject_id,
               sum(r2.score * coalesce(sp2.weight, 1) / coalesce(sp2.out_of, v_exam.out_of, 100) * v_exam.out_of) as effective_score
        from public.results r2
        left join public.subject_papers sp2 on sp2.id = r2.paper_id
        where r2.exam_id = p_exam_id and r2.student_id = st.id and r2.school_id = v_caller_school
          and r2.score is not null
          and exists (
            select 1 from public.result_submissions rs3
            where rs3.exam_id = r2.exam_id and rs3.class_id = r2.class_id and rs3.subject_id = r2.subject_id
              and rs3.status = 'published'
          )
        group by r2.subject_id
      ),
      folded as (
        select subject_id, effective_score from per_row2
        where subject_id not in (select subject_id from combo_member_ids)
        union all
        select ca.combo_id, sum(pr.effective_score * coalesce(cd.weight, 0))
        from combo_active ca
        join combo_defs cd on cd.combo_id = ca.combo_id
        join per_row2 pr on pr.subject_id = cd.subject_id
        group by ca.combo_id
      )
      select coalesce(sum(effective_score), 0) as total, count(*) as subject_count from folded
    ) agg on true
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
    'subjects', v_subjects, 'total', round(v_total), 'average', v_average,
    'overall_grade', coalesce(v_overall_grade, ''), 'position', v_position,
    'class_size', coalesce(v_class_size, 0), 'below_minimum', v_below_minimum
  );
end;
$$;
grant execute on function public.get_report_card(uuid, uuid) to authenticated;
