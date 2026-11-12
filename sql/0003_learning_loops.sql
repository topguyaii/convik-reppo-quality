-- Convik Terminal learning loops: lessons from two judges (reviewers and the
-- market), lessons for the note writer as well as the answer agent, a playbook
-- that retires rules that don't work, and peer review of the Live tab's notes.
-- Additive and safe to re-run.

-- scope = answers (the Ask agent) | notes (the Live tab's note writer).
-- source = reviewers (Reppo critiques) | market (calls the chain proved wrong).
ALTER TABLE "terminal_lessons" ADD COLUMN IF NOT EXISTS "scope" text DEFAULT 'answers' NOT NULL;
ALTER TABLE "terminal_lessons" ADD COLUMN IF NOT EXISTS "source" text DEFAULT 'reviewers' NOT NULL;
ALTER TABLE "terminal_lessons" ADD COLUMN IF NOT EXISTS "retired_at" timestamptz;
ALTER TABLE "terminal_lessons" ADD COLUMN IF NOT EXISTS "retired_reason" text;

-- A note's peer review; a note the panel scores low is hidden from the Live tab.
ALTER TABLE "terminal_notes" ADD COLUMN IF NOT EXISTS "review" jsonb;
ALTER TABLE "terminal_notes" ADD COLUMN IF NOT EXISTS "hidden" boolean DEFAULT false NOT NULL;
