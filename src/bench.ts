/**
 * The benchmark that measures whether the lessons help. Each run answers the
 * same fixed questions twice at the same moment, once with the learned lessons
 * and once without, and sends every answer to Reppo's panel. Same data, same
 * questions: the score gap is the lessons' effect. Runs one answer per step so
 * a scheduler can drive it in short ticks.
 */
import { submitEval, getEval, reppoEnabled } from "./reppo";
import { reviewInput } from "./quality";
import { activeLessons } from "./lessons";
import { tdb, rowsOf, iso } from "./db";

/** Your agent: answers a question, with or without the learned lessons, and returns the evidence it used. */
export type Answerer = (question: string, opts: { lessons: boolean }) => Promise<{ answer: string; evidence: string }>;

export const QUESTIONS: Array<{ qid: string; q: string }> = [
  { qid: "nvda-buyers", q: "Which wallets bought the most NVDA this week?" },
  { qid: "whales", q: "What are whales accumulating right now?" },
  { qid: "net-buying", q: "Which stocks had the most net buying on chain in the last 24 hours?" },
  { qid: "tsla-why", q: "Why is TSLA moving today?" },
  { qid: "mints", q: "Which stocks is Robinhood minting the most of today?" },
  { qid: "smart-ai", q: "Is smart money buying AI stocks this week?" },
];
const ARMS = ["with", "without"] as const;
const runId = (day = new Date()) => `bench-${day.toISOString().slice(0, 10)}`;

/** Answer and submit the next unanswered (question, arm) of today's run. */
export async function benchStep(answer: Answerer): Promise<string> {
  if (!reppoEnabled()) return "reppo off";
  const { d, sql } = await tdb();
  const run = runId();
  const have = new Set(rowsOf(await d.execute(sql`select qid from terminal_bench where run_id = ${run}`)).map((r) => String(r.qid)));
  const lessons = (await activeLessons()).length;
  for (const { qid, q } of QUESTIONS) {
    for (const arm of ARMS) {
      const key = `${qid}:${arm}`;
      if (have.has(key)) continue;
      if (arm === "with" && lessons === 0) continue; // nothing to compare yet: the baseline runs alone
      // Claim the slot first so overlapping ticks never answer it twice.
      await d.execute(sql`insert into terminal_bench (run_id, qid, question, lessons) values (${run}, ${key}, ${q}, ${arm === "with" ? lessons : 0}) on conflict do nothing`);
      const r = await answer(q, { lessons: arm === "with" });
      const input = reviewInput(q, r.answer, r.evidence);
      const e = await submitEval("response", input);
      await d.execute(sql`insert into terminal_evals (id, kind, ref, version, input, output, status) values (${e.id}, 'bench', ${`${run}:${key}`}, 1, ${input}, ${r.answer}, ${e.status}) on conflict (id) do nothing`);
      await d.execute(sql`update terminal_bench set answer = ${r.answer}, eval_id = ${e.id} where run_id = ${run} and qid = ${key}`);
      return `asked ${key}`;
    }
  }
  return "run complete";
}

/** Read back finished benchmark evaluations. */
export async function benchCollect() {
  if (!reppoEnabled()) return 0;
  const { d, sql } = await tdb();
  const open = rowsOf(await d.execute(sql`select run_id, qid, eval_id from terminal_bench where eval_id is not null and score is null and created_at > now() - interval '3 days' limit 20`));
  let n = 0;
  for (const r of open) {
    const e = await getEval(String(r.eval_id)).catch(() => null);
    if (!e || (e.status !== "COMPLETED" && e.status !== "FAILED")) continue;
    await d.execute(sql`update terminal_evals set status = ${e.status}, score = ${e.score}, route = ${e.route}, confidence = ${e.confidence}, reason = ${e.reason}, rubric = ${e.rubric ? JSON.stringify(e.rubric) : null}::jsonb, result = ${JSON.stringify(e.raw)}::jsonb, completed_at = now() where id = ${e.id}`);
    if (e.status === "COMPLETED") await d.execute(sql`update terminal_bench set score = ${e.score} where run_id = ${r.run_id} and qid = ${r.qid}`);
    n++;
  }
  return n;
}

const avg = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);

/** Every run: average score with and without lessons, and each item. */
export async function benchHistory() {
  const { d, sql } = await tdb();
  const rows = rowsOf(await d.execute(sql`select run_id, qid, question, score, lessons, eval_id, created_at from terminal_bench order by run_id, qid`));
  const runs = new Map<string, { run: string; day: string; with: number[]; without: number[]; lessons: number; items: unknown[] }>();
  for (const r of rows) {
    const run = String(r.run_id);
    const g = runs.get(run) || { run, day: run.replace("bench-", ""), with: [], without: [], lessons: 0, items: [] };
    const [qid, arm] = String(r.qid).split(":");
    if (typeof r.score === "number") (arm === "with" ? g.with : g.without).push(r.score);
    if (arm === "with") g.lessons = Math.max(g.lessons, Number(r.lessons) || 0);
    g.items.push({ qid, arm, question: String(r.question), score: r.score ?? null, evalId: r.eval_id ? String(r.eval_id) : null, at: iso(r.created_at) });
    runs.set(run, g);
  }
  return [...runs.values()].map((g) => ({ run: g.run, day: g.day, lessons: g.lessons, withAvg: avg(g.with), withoutAvg: avg(g.without), nWith: g.with.length, nWithout: g.without.length, items: g.items }));
}
