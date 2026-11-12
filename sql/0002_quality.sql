-- Convik Terminal quality layer: independent peer review (Reppo) of what the
-- agent says and does, the lessons it learns from that review, a fixed
-- benchmark to measure the learning, and checks of its calls against the chain.
-- Raw SQL tables, additive and safe to re-run.

-- One Reppo evaluation. kind = answer (an Ask answer) | action (a mission trade
-- before it runs) | bench (a benchmark run) | claim. ref ties it to the ask id,
-- mission id or benchmark run; version counts drafts (1 = first, 2 = revised).
CREATE TABLE IF NOT EXISTS "terminal_evals" (
  "id" text PRIMARY KEY,
  "kind" text NOT NULL,
  "ref" text NOT NULL,
  "version" integer DEFAULT 1 NOT NULL,
  "input" text NOT NULL,
  "output" text,
  "status" text DEFAULT 'QUEUED' NOT NULL,
  "score" integer,
  "route" text,
  "confidence" text,
  "reason" text,
  "rubric" jsonb,
  "result" jsonb,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "completed_at" timestamptz
);
CREATE INDEX IF NOT EXISTS "terminal_evals_ref_idx" ON "terminal_evals" ("ref");
CREATE INDEX IF NOT EXISTS "terminal_evals_status_idx" ON "terminal_evals" ("status");
CREATE INDEX IF NOT EXISTS "terminal_evals_created_idx" ON "terminal_evals" ("created_at");

-- Rules the agent wrote for itself from reviewers' critiques. Active lessons
-- are appended to its instructions; from_evals are the critiques behind each.
CREATE TABLE IF NOT EXISTS "terminal_lessons" (
  "id" serial PRIMARY KEY,
  "lesson" text NOT NULL,
  "why" text,
  "from_evals" jsonb,
  "active" boolean DEFAULT true NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL
);

-- The fixed benchmark: the same questions answered and peer-reviewed each run,
-- so the score over time measures whether the lessons help.
CREATE TABLE IF NOT EXISTS "terminal_bench" (
  "run_id" text NOT NULL,
  "qid" text NOT NULL,
  "question" text NOT NULL,
  "answer" text,
  "eval_id" text,
  "score" integer,
  "lessons" integer DEFAULT 0 NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  PRIMARY KEY ("run_id", "qid")
);

-- The market as second judge: a checkable call the agent made, and what the
-- chain did after.
CREATE TABLE IF NOT EXISTS "terminal_calls" (
  "id" text PRIMARY KEY,
  "ask_id" text,
  "claim" text NOT NULL,
  "symbol" text,
  "wallet" text,
  "expect" text NOT NULL,
  "made_at" timestamptz DEFAULT now() NOT NULL,
  "check_at" timestamptz NOT NULL,
  "peer_score" integer,
  "outcome" jsonb,
  "verdict" text
);
CREATE INDEX IF NOT EXISTS "terminal_calls_check_idx" ON "terminal_calls" ("check_at");

-- Each answer's review state, shown on the answer card.
ALTER TABLE "terminal_asks" ADD COLUMN IF NOT EXISTS "review" jsonb;
