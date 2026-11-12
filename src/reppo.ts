/**
 * Reppo Eval Router: an independent panel scores what the agent says or does,
 * 0-100, and routes it ship / review / block. Evaluations queue and finish in
 * 30-90 seconds, so callers submit, keep the id, and poll.
 * Docs: https://eval.reppo.xyz/agents.md
 */
const BASE = "https://eval.reppo.xyz/api/v1/agents/evals";

export type TaskType = "claim" | "response" | "action";
export type Route = "ship" | "review" | "block";
export interface Evaluation {
  id: string;
  status: "QUEUED" | "PROCESSING" | "COMPLETED" | "FAILED";
  score: number | null;
  route: Route | null;
  confidence: string | null;
  reason: string | null;
  rubric: Record<string, number> | null;
  routeReasons: string[];
  raw: unknown;
}

export const reppoEnabled = () => Boolean(process.env.REPPO_API_KEY);

function headers() {
  const key = process.env.REPPO_API_KEY;
  if (!key) throw new Error("REPPO_API_KEY not set");
  return { authorization: `Bearer ${key}`, "content-type": "application/json" };
}

function shape(j: Record<string, any>): Evaluation {
  const r = j.result || {};
  return {
    id: String(j.id),
    status: j.status,
    score: typeof (j.score ?? r.score) === "number" ? (j.score ?? r.score) : null,
    route: (j.route ?? r.route) || null,
    confidence: r.confidence || null,
    reason: r.reason || null,
    rubric: r.rubric_scores || null,
    routeReasons: Array.isArray(r.explain?.route_reasons) ? r.explain.route_reasons : [],
    raw: j,
  };
}

/** Queue an evaluation. Input is capped well under Reppo's 50 KB limit. */
export async function submitEval(taskType: TaskType, input: string): Promise<Evaluation> {
  const res = await fetch(BASE, {
    method: "POST",
    headers: headers(),
    signal: AbortSignal.timeout(20_000),
    body: JSON.stringify({ taskType, input: input.slice(0, 45_000) }),
  });
  if (!res.ok) throw new Error(`reppo submit ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return shape((await res.json()) as Record<string, any>);
}

export async function getEval(id: string): Promise<Evaluation> {
  const res = await fetch(`${BASE}/${encodeURIComponent(id)}`, { headers: headers(), signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`reppo read ${res.status}`);
  return shape((await res.json()) as Record<string, any>);
}

const done = (e: Evaluation) => e.status === "COMPLETED" || e.status === "FAILED";

/** Poll until the evaluation finishes or `budgetMs` runs out; returns its latest state. */
export async function waitEval(id: string, budgetMs: number, everyMs = 4000): Promise<Evaluation> {
  const until = Date.now() + budgetMs;
  let e = await getEval(id);
  while (!done(e) && Date.now() + everyMs < until) {
    await new Promise((r) => setTimeout(r, everyMs));
    e = await getEval(id).catch(() => e);
  }
  return e;
}

/** Public page for an evaluation on Reppo's network feed. */
export const evalUrl = (id: string) => `https://eval.reppo.xyz/evals/${id}`;
