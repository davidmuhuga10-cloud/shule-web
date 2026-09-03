-- ---------------------------------------------------------------------------
-- 0046_perf_indexes.sql — full-app performance audit (see PRODUCT_ROADMAP.md
-- history for prior perf fixes: classes.list()/streams.list() batching,
-- getBroadsheet() hardening). Three columns that get filtered/joined on
-- constantly across the app never had a supporting index:
--
--  * results(exam_id, class_id) — getBroadsheet() and every screen built on
--    it (Mark List, Exam Board, Exam Analysis, exam-results messaging) reads
--    `results` filtered by exam_id AND class_id together. The two existing
--    unique indexes on this table both lead with (exam_id, student_id, ...),
--    which doesn't help a class_id-only filter within an exam — this table
--    only grows (one row per student × subject × exam, forever), so the
--    gap gets worse as a school accumulates terms.
--  * students(class_id) and students(stream_id) — the class roster, the
--    Classes & Streams page's per-stream/per-class counts, and Report
--    Forms/Report Cards all filter students by one or the other on every
--    load. No index existed anywhere in the migration history; only
--    idx_students_admission_numeric (school_id + admission number) does.
--
-- All three are purely additive (CREATE INDEX IF NOT EXISTS) — safe to run
-- on a live database with existing data, no table rewrite, no risk to
-- existing queries or RLS policies.
-- ---------------------------------------------------------------------------
begin;

create index if not exists idx_results_exam_class on public.results(exam_id, class_id);
create index if not exists idx_students_class_id on public.students(class_id);
create index if not exists idx_students_stream_id on public.students(stream_id);

commit;
