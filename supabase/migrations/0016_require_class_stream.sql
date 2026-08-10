-- ============================================================================
-- 0016_require_class_stream.sql — Round 3 §17: "no class should ever be
-- allowed to exist without at least one stream (arm)... this removes the
-- zero-stream state from the system entirely, rather than needing to handle
-- it as an edge case."
--
-- Reported bug: "Managing a class with no stream set currently shows a
-- confusing 'no stream yet' message, despite the class actually having
-- enrolled students." Going forward, the app layer (academics.mjs) now
-- refuses to create a class without at least one stream, and refuses to
-- delete a class's last remaining stream (see classes.save()/streams.remove()
-- in src/lib/api/academics.mjs) — but that only prevents NEW violations. Any
-- school that already has a class with zero streams (very plausible, since
-- this is exactly the bug that was reported) needs a one-time fix so the
-- invariant is actually true everywhere, not just from here on.
--
-- Fix: give every existing class that currently has zero streams a single
-- "Main" stream. Purely additive — no existing data (students, results,
-- subject assignments) is touched or moved; a class that already has one or
-- more streams is left completely alone.
--
-- Idempotent / safe to re-run: the `where not exists (...)` guard means a
-- class that already got its "Main" stream from a previous run of this
-- script (or that gained a real stream through the app in the meantime) is
-- simply skipped on subsequent runs.
-- ============================================================================

insert into public.streams (id, school_id, class_id, name, description)
select gen_random_uuid(), c.school_id, c.id, 'Main', ''
from public.classes c
where not exists (
  select 1 from public.streams s where s.class_id = c.id
);
