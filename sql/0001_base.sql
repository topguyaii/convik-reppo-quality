-- The tables the quality layer reads from your own agent. Shapes only: any
-- indexer or Q&A store with these columns works.

-- Questions and answers; review holds the panel's verdicts (quality.ts).
CREATE TABLE IF NOT EXISTS "terminal_asks" (
  "id" text PRIMARY KEY,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "question" text NOT NULL,
  "answer" text,
  "status" text DEFAULT 'done' NOT NULL
);

-- Short market notes written by an agent (note-review.ts).
CREATE TABLE IF NOT EXISTS "terminal_notes" (
  "id" bigserial PRIMARY KEY,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "symbol" text,
  "text" text NOT NULL
);

-- On-chain trades and per-minute marks, used to check calls a day later (calls.ts).
CREATE TABLE IF NOT EXISTS "terminal_trades" (
  "id" bigserial PRIMARY KEY,
  "tx_hash" text NOT NULL,
  "ts" timestamptz NOT NULL,
  "symbol" text NOT NULL,
  "kind" text NOT NULL,
  "wallet" text NOT NULL,
  "usd" numeric(20, 2) NOT NULL
);
CREATE TABLE IF NOT EXISTS "terminal_minute" (
  "symbol" text NOT NULL,
  "minute" timestamptz NOT NULL,
  "mark" numeric(20, 6),
  PRIMARY KEY ("symbol", "minute")
);
