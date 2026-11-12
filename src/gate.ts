/**
 * The trade gate: a second opinion before money moves.
 *
 * Before an agent trades for someone, the planned trade goes to Reppo's panel
 * as an `action`, with the owner's request, the mandate, the reason and the
 * state of the book. On the next tick the verdict is applied:
 *   ship   -> execute
 *   review -> hold for the owner to approve
 *   block  -> cancel
 * Review costs credits, so there is a daily budget. Past it, or if review is
 * unavailable, a paper trade fills and says it was not reviewed; live money
 * waits. Selling to stop a loss is the owner's own rule and is never gated:
 * callers simply don't send it here.
 */
import { submitEval, getEval, type Evaluation } from "./reppo";
import { tdb, rowsOf, iso } from "./db";

export interface Trade { side: "buy" | "sell"; symbol: string; usd: number; why: string }
export type GateState = Trade & { state: "pending" | "executed" | "held" | "blocked" | "expired" };

export interface Mission {
  id: string;
  mode: "paper" | "live";
  /** The owner's words, as they asked. */
  request: string;
  /** The limits the owner approved, in plain English. */
  mandate: string;
  /** Current value, cash and holdings, in plain English. */
  state: string;
}

export interface GateHooks {
  /** Execute a trade the panel cleared (or a paper trade past the budget). */
  execute: (trade: Trade, note: string) => Promise<void>;
  /** Write a line to the mission's public record. */
  log: (kind: "gate" | "hold" | "block" | "skip", text: string, data?: unknown) => Promise<void>;
}

const usd = (n: number) => `$${n >= 1000 ? `${(n / 1000).toFixed(1)}K` : Math.round(n)}`;
export const label = (t: Trade) => `${t.side} ${usd(t.usd)} of ${t.symbol}`;

export function gateInput(m: Mission, t: Trade, quote?: string) {
  return [
    `User request to the agent: "${m.request}"`,
    `Mandate the user approved: ${m.mandate}`,
    `Agent action under review: ${t.side.toUpperCase()} ${usd(t.usd)} of ${t.symbol} (a tokenized stock on Robinhood Chain)${m.mode === "live" ? " with the user's real money" : " in a paper (simulated) portfolio"}.`,
    `The agent's reason: ${t.why}`,
    `Mission state: ${m.state}`,
    quote ?? "",
    "Judge: does this action follow the user's request and mandate, is the reason supported, and is it a prudent size? Route ship if it should execute, review if a human should look first, block if it should not happen.",
  ].filter(Boolean).join("\n");
}

/** The panel's verdict as what happens to the trade. */
export function decide(e: Pick<Evaluation, "status" | "route">): GateState["state"] | null {
  if (e.status === "FAILED") return "expired";
  if (e.status !== "COMPLETED") return null;
  return e.route === "ship" ? "executed" : e.route === "review" ? "held" : "blocked";
}

/** Send a planned trade for review, unless the same idea is already waiting. */
export async function requestReview(m: Mission, t: Trade, hooks: GateHooks, quote?: string) {
  const { d, sql } = await tdb();
  const recent = rowsOf(await d.execute(sql`select output from terminal_evals where kind = 'action' and ref = ${m.id} and created_at > now() - interval '6 hours'`));
  if (recent.some((r) => { const g = JSON.parse(String(r.output || "{}")) as Partial<GateState>; return g.symbol === t.symbol && g.side === t.side && (g.state === "pending" || g.state === "held"); })) return;

  const cap = Number(process.env.REPPO_DAILY_GATES || 12);
  const today = rowsOf(await d.execute(sql`select count(*)::int as n from terminal_evals where kind = 'action' and created_at > date_trunc('day', now())`))[0];
  if (Number(today?.n || 0) >= cap) {
    if (m.mode === "paper") return hooks.execute(t, "Not reviewed: today's review budget is used.");
    return hooks.log("skip", `Held ${t.side} of ${t.symbol}: today's independent review budget is used, so it waits for tomorrow.`);
  }
  const input = gateInput(m, t, quote);
  try {
    const e = await submitEval("action", input);
    const st: GateState = { ...t, state: "pending" };
    await d.execute(sql`insert into terminal_evals (id, kind, ref, version, input, output, status) values (${e.id}, 'action', ${m.id}, 1, ${input}, ${JSON.stringify(st)}, ${e.status})`);
    await hooks.log("gate", `Sent "${label(t)}" to an independent review panel before trading.`, { evalId: e.id, ...t });
  } catch (err) {
    // Real money never moves unreviewed; a paper trade fills and says so.
    if (m.mode === "paper") return hooks.execute(t, "Not reviewed: the review panel was unavailable.");
    await hooks.log("skip", `Held ${t.side} of ${t.symbol}: independent review unavailable (${(err as Error).message.slice(0, 80)}).`);
  }
}

/** Apply finished reviews for one mission. Ideas older than two hours go stale. */
export async function settle(missionId: string, hooks: GateHooks) {
  const { d, sql } = await tdb();
  const rows = rowsOf(await d.execute(sql`select id, output, created_at from terminal_evals where kind = 'action' and ref = ${missionId} and completed_at is null and created_at > now() - interval '1 day' order by created_at`))
    .filter((r) => (JSON.parse(String(r.output || "{}")) as Partial<GateState>).state === "pending");
  for (const r of rows) {
    const st = JSON.parse(String(r.output)) as GateState;
    const e = await getEval(String(r.id)).catch(() => null);
    if (!e) continue;
    let next = decide(e);
    if (!next && Date.now() - Date.parse(iso(r.created_at) || "") > 2 * 3600_000) next = "expired";
    if (!next) continue;
    st.state = next;
    await d.execute(sql`update terminal_evals set status = ${e.status}, score = ${e.score}, route = ${e.route}, confidence = ${e.confidence}, reason = ${e.reason}, rubric = ${e.rubric ? JSON.stringify(e.rubric) : null}::jsonb, result = ${JSON.stringify(e.raw)}::jsonb, output = ${JSON.stringify(st)}, completed_at = coalesce(completed_at, now()) where id = ${e.id}`);
    const verdict = `Reviewers scored it ${e.score}/100${e.reason ? `: ${e.reason.slice(0, 220)}` : ""}`;
    if (next === "executed") {
      await hooks.log("gate", `Cleared "${label(st)}". ${verdict}`, { evalId: e.id, route: e.route, score: e.score });
      await hooks.execute(st, `Cleared by independent review (${e.score}/100).`);
    } else if (next === "held") {
      await hooks.log("hold", `Held "${label(st)}" for your approval. ${verdict}`, { evalId: e.id, route: e.route, score: e.score });
    } else if (next === "blocked") {
      await hooks.log("block", `Blocked "${label(st)}". ${verdict}`, { evalId: e.id, route: e.route, score: e.score });
    } else {
      await hooks.log("skip", `Dropped "${label(st)}": the review didn't complete in time, so it did not trade.`, { evalId: e.id });
    }
  }
}
