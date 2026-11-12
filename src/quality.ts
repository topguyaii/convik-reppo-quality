/**
 * Peer review of Ask answers. Each answer goes to Reppo's independent panel with
 * the evidence the agent retrieved. Below the bar, the agent rewrites it from
 * the panel's critique (same evidence, no new data) and the rewrite is reviewed
 * again. The better-scoring draft becomes the answer people see.
 */
import { submitEval, getEval, reppoEnabled, type Evaluation } from "./reppo";
import { tdb, rowsOf, iso } from "./db";

/** At or above this the first draft ships as is: 90 is where the house standard counts as fully met. */
export const SHIP_SCORE = 90;
const MAX_VERSIONS = 2;

export interface Version { v: number; evalId: string; status: string; score: number | null; route: string | null; reason: string | null; answer: string; engine?: string }
export interface Review { status: "reviewing" | "revising" | "done" | "failed"; versions: Version[]; final: number | null; improved: boolean }

const REVIEW_BRIEF = `Context for reviewers: the AI is Convik Terminal, an analyst for tokenized stocks on Robinhood Chain, writing for a smart non-trader. Score strictly against this house standard and name every point that falls short:
1. Accuracy: every figure appears in the data below; nothing is computed, rounded or invented.
2. Direct answer: the first sentence answers the question.
3. Evidence: 2 to 5 short bullets; where the data includes wallets or transactions, cite them as [wallet:0x...] or [tx:0x...]. Aggregate data (totals by stock) needs no citation; don't penalise its absence.
4. Wallets are described by their behaviour label when the data gives one (the "who" field, e.g. "an AI-bull whale"), not as a bare address.
5. Readable to a non-trader: plain English, times written like "Nov 10, 21:18 UTC" (never raw ISO timestamps), no markdown bold, no jargon or field names.
6. Fact vs interpretation: "the data shows" for facts, "possibly" for interpretation; it says what the data can't tell.
7. One line on what to watch; no buy or sell advice, no price predictions.
An answer that meets 1 to 7 fully scores 90 or more; each clear miss should cost points.`;

export function reviewInput(question: string, answer: string, evidence: string) {
  return `User prompt: ${question}\n\nAI response: ${answer}\n\n${REVIEW_BRIEF}\n\nData the AI retrieved (JSON excerpts):\n${evidence.slice(0, 30_000)}`;
}

/** The panel's critique as one block the agent can act on. */
export function critiqueOf(e: Evaluation): string {
  const parts: string[] = [];
  if (e.reason) parts.push(e.reason);
  if (e.routeReasons.length) parts.push(...e.routeReasons.map((r) => `- ${r}`));
  if (e.rubric) parts.push("Scores: " + Object.entries(e.rubric).map(([k, v]) => `${k} ${v}`).join(", "));
  // Each evaluator's own reasoning, trimmed: that is where the specific fixes are.
  const trace = (e.raw as { trace?: unknown })?.trace;
  if (trace) parts.push("Evaluator notes: " + JSON.stringify(trace).slice(0, 4000));
  return parts.join("\n");
}

async function saveEval(e: Evaluation, kind: string, ref: string, version: number, input: string, output: string | null) {
  const { d, sql } = await tdb();
  await d.execute(sql`insert into terminal_evals (id, kind, ref, version, input, output, status, score, route, confidence, reason, rubric, result)
    values (${e.id}, ${kind}, ${ref}, ${version}, ${input}, ${output}, ${e.status}, ${e.score}, ${e.route}, ${e.confidence}, ${e.reason}, ${e.rubric ? JSON.stringify(e.rubric) : null}::jsonb, ${JSON.stringify(e.raw)}::jsonb)
    on conflict (id) do update set status = excluded.status, score = excluded.score, route = excluded.route, confidence = excluded.confidence, reason = excluded.reason, rubric = excluded.rubric, result = excluded.result,
      completed_at = case when excluded.status in ('COMPLETED','FAILED') then coalesce(terminal_evals.completed_at, now()) else terminal_evals.completed_at end`);
}

async function setReview(askId: string, review: Review, answer?: string) {
  const { d, sql } = await tdb();
  if (answer !== undefined) await d.execute(sql`update terminal_asks set review = ${JSON.stringify(review)}::jsonb, answer = ${answer} where id = ${askId}`);
  else await d.execute(sql`update terminal_asks set review = ${JSON.stringify(review)}::jsonb where id = ${askId}`);
}

/** jsonb arrives as an object from some drivers and as a string from others. */
const asReview = (v: unknown): Review | null => (typeof v === "string" ? (JSON.parse(v) as Review) : ((v as Review) ?? null));

export async function getReview(askId: string): Promise<Review | null> {
  const { d, sql } = await tdb();
  const r = rowsOf(await d.execute(sql`select review from terminal_asks where id = ${askId}`))[0];
  return asReview(r?.review);
}

/** Send an answer for review. Returns the starting review state, or null when Reppo isn't configured. */
export async function startReview(askId: string, question: string, answer: string, evidence: string, engine?: string): Promise<Review | null> {
  if (!reppoEnabled() || !evidence) return null;
  // Reviews cost Reppo credits: cap how many answers a day go to the panel.
  const cap = Number(process.env.REPPO_DAILY_REVIEWS || 40);
  const { d, sql } = await tdb();
  const today = rowsOf(await d.execute(sql`select count(*)::int as n from terminal_evals where kind = 'answer' and created_at > date_trunc('day', now())`))[0];
  if (Number(today?.n || 0) >= cap) return null;
  const input = reviewInput(question, answer, evidence);
  try {
    const e = await submitEval("response", input);
    await saveEval(e, "answer", askId, 1, input, answer);
    const review: Review = { status: "reviewing", versions: [{ v: 1, evalId: e.id, status: e.status, score: null, route: null, reason: null, answer, engine }], final: null, improved: false };
    await setReview(askId, review);
    return review;
  } catch (err) {
    console.error("[terminal] review submit", (err as Error).message);
    return null;
  }
}

/**
 * Move one answer's review forward: read the latest evaluation; if it finished
 * below the bar, rewrite from the critique and send the rewrite for review.
 * Safe to call repeatedly from the request and from the cron.
 */
export async function advanceReview(askId: string): Promise<Review | null> {
  const review = await getReview(askId);
  if (!review || review.status === "done" || review.status === "failed") return review;
  const cur = review.versions[review.versions.length - 1]!;
  const e = await getEval(cur.evalId).catch(() => null);
  if (!e) return review;
  const { d, sql } = await tdb();
  const row = rowsOf(await d.execute(sql`select input from terminal_evals where id = ${cur.evalId}`))[0];
  await saveEval(e, "answer", askId, cur.v, String(row?.input || ""), cur.answer);
  Object.assign(cur, { status: e.status, score: e.score, route: e.route, reason: e.reason });
  if (e.status !== "COMPLETED" && e.status !== "FAILED") { await setReview(askId, review); return review; }

  if (e.status === "FAILED") {
    review.status = review.versions.some((v) => v.score !== null) ? "done" : "failed";
    return finish(askId, review);
  }
  // Reppo routes a high score to review when its panel's confidence is only medium; the score is the bar (90).
  const good = (e.score ?? 0) >= SHIP_SCORE;
  if (good || review.versions.length >= MAX_VERSIONS) return finish(askId, review);

  // Below the bar: rewrite from the panel's critique and review the rewrite.
  review.status = "revising";
  await setReview(askId, review);
  const q = rowsOf(await d.execute(sql`select question from terminal_asks where id = ${askId}`))[0];
  const question = String(q?.question || "");
  const input0 = String(row?.input || "");
  const evidence = input0.split("Data the AI retrieved (JSON excerpts):\n")[1] || "";
  const { revise } = await import("./revise");
  const { text: next, engine } = await revise(question, cur.answer, critiqueOf(e), evidence);
  const { engineLabel } = await import("./llm");
  const input = reviewInput(question, next, evidence);
  const e2 = await submitEval("response", input);
  await saveEval(e2, "answer", askId, cur.v + 1, input, next);
  review.versions.push({ v: cur.v + 1, evalId: e2.id, status: e2.status, score: null, route: null, reason: null, answer: next, engine: engineLabel(engine) });
  review.status = "reviewing";
  await setReview(askId, review);
  return review;
}

/** Keep the best-scoring draft as the answer people see. */
async function finish(askId: string, review: Review) {
  const scored = review.versions.filter((v) => v.score !== null);
  const best = scored.sort((a, b) => (b.score ?? 0) - (a.score ?? 0))[0];
  review.status = "done";
  review.final = best?.score ?? null;
  review.improved = Boolean(best && best.v > 1 && (best.score ?? 0) > (review.versions[0]!.score ?? 0));
  await setReview(askId, review, best?.answer);
  // Hand the answer's checkable calls to the second judge: the market, a day from now.
  if (best) {
    const { extractCalls } = await import("./calls");
    await extractCalls(askId, best.answer, best.score).catch((e) => console.error("[terminal] calls", (e as Error).message));
  }
  return review;
}

/** Cron: advance every review still open from the last day. */
export async function advanceOpenReviews(limit = 20) {
  if (!reppoEnabled()) return { advanced: 0 };
  const { d, sql } = await tdb();
  const rows = rowsOf(await d.execute(sql`select id from terminal_asks where review is not null and review->>'status' in ('reviewing','revising') and created_at > now() - interval '1 day' order by created_at limit ${limit}`));
  let n = 0;
  for (const r of rows) { await advanceReview(String(r.id)).catch((e) => console.error("[terminal] review advance", (e as Error).message)); n++; }
  return { advanced: n };
}

/** Public quality numbers: every completed review, the share that needed a rewrite, and the lift. */
export async function qualityStats(days = 30) {
  const { d, sql } = await tdb();
  const asks = rowsOf(await d.execute(sql`select id, created_at, question, review from terminal_asks where review is not null and created_at > now() - make_interval(days => ${days}) order by created_at desc limit 400`)).map((a) => ({ ...a, review: asReview(a.review) }) as Record<string, unknown> & { review: Review | null });
  const done = asks.filter((a) => (a.review as Review)?.status === "done");
  const first = done.map((a) => (a.review as Review).versions[0]?.score).filter((x): x is number => typeof x === "number");
  const fin = done.map((a) => (a.review as Review).final).filter((x): x is number => typeof x === "number");
  const revised = done.filter((a) => (a.review as Review).versions.length > 1);
  const lifts = revised.map((a) => { const r = a.review as Review; return (r.final ?? 0) - (r.versions[0]!.score ?? 0); });
  const avg = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);
  const byDay = new Map<string, number[]>();
  for (const a of done) { const k = String(iso(a.created_at)).slice(0, 10); const f = (a.review as Review).final; if (typeof f === "number") byDay.set(k, [...(byDay.get(k) || []), f]); }
  return {
    reviewed: done.length,
    open: asks.length - done.length,
    firstDraftAvg: avg(first),
    finalAvg: avg(fin),
    revisedShare: done.length ? revised.length / done.length : null,
    avgLift: avg(lifts),
    shipped: done.filter((a) => ((a.review as Review).final ?? 0) >= SHIP_SCORE).length,
    daily: [...byDay.entries()].sort().map(([day, xs]) => ({ day, avg: avg(xs), n: xs.length })),
    recent: asks.slice(0, 25).map((a) => {
      const r = a.review as Review;
      return { id: String(a.id), at: iso(a.created_at), question: String(a.question), status: r.status, first: r.versions[0]?.score ?? null, final: r.final, versions: r.versions.map((v) => ({ v: v.v, score: v.score, route: v.route, evalId: v.evalId })) };
    }),
  };
}
