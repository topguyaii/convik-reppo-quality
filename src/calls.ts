/**
 * The market as second judge. After an answer is reviewed, its checkable calls
 * ("this whale keeps accumulating NVDA", "net selling in SPY continues") are
 * pulled out and, a day later, checked against what the chain actually did.
 * Each call then carries two scores: the review panel's, and the market's.
 */
import { randomUUID } from "node:crypto";
import { chat } from "./llm";
import { tdb, rowsOf, num, iso } from "./db";

export type Expect = "wallet_buys" | "wallet_sells" | "net_buying" | "net_selling" | "price_up" | "price_down";
const EXPECTS: Expect[] = ["wallet_buys", "wallet_sells", "net_buying", "net_selling", "price_up", "price_down"];
const HORIZON_H = 24;

/** Pull at most three checkable calls from an answer. */
export async function extractCalls(askId: string, answer: string, peerScore: number | null) {
  const msg = await chat([
    { role: "system", content: "You extract checkable expectations from a market analyst's answer. Output JSON only." },
    { role: "user", content: `Answer:\n${answer.slice(0, 6000)}\n\nList up to 3 things this answer implies will continue or happen over the next ${HORIZON_H} hours that on-chain data can check. Allowed expect values: wallet_buys (a wallet keeps net buying a stock), wallet_sells, net_buying (a stock keeps net buying across wallets), net_selling, price_up, price_down. Only include calls the answer actually implies (often in "what to watch"); a stock symbol is required, a wallet only for wallet_*. Return {"calls":[{"claim":"short plain sentence","symbol":"NVDA","wallet":"0x... or null","expect":"..."}]} or {"calls":[]}.` },
  ], { maxTokens: 500 });
  let parsed: { calls?: Array<{ claim?: string; symbol?: string; wallet?: string | null; expect?: string }> } = {};
  try { parsed = JSON.parse(String(msg.content || "{}").replace(/^```json\s*|```$/g, "").trim()); } catch {}
  const { d, sql } = await tdb();
  const out = [];
  for (const c of (parsed.calls || []).slice(0, 3)) {
    const expect = c.expect as Expect;
    const symbol = String(c.symbol || "").toUpperCase().replace(/[^A-Z.]/g, "");
    const wallet = c.wallet && /^0x[0-9a-fA-F]{40}$/.test(c.wallet) ? c.wallet.toLowerCase() : null;
    if (!EXPECTS.includes(expect) || !symbol || (expect.startsWith("wallet") && !wallet)) continue;
    const id = randomUUID();
    await d.execute(sql`insert into terminal_calls (id, ask_id, claim, symbol, wallet, expect, check_at, peer_score) values (${id}, ${askId}, ${String(c.claim || "").slice(0, 300)}, ${symbol}, ${wallet}, ${expect}, now() + make_interval(hours => ${HORIZON_H}), ${peerScore})`);
    out.push({ id, symbol, expect });
  }
  return out;
}

/** Check every call whose window has closed. A move too small to call is "unclear", not right or wrong. */
export async function checkCalls(limit = 30) {
  const { d, sql } = await tdb();
  const due = rowsOf(await d.execute(sql`select * from terminal_calls where verdict is null and check_at <= now() order by check_at limit ${limit}`));
  for (const c of due) {
    const from = iso(c.made_at)!, to = iso(c.check_at)!;
    const expect = String(c.expect) as Expect;
    let outcome: Record<string, unknown> = {};
    let verdict: "right" | "wrong" | "unclear" = "unclear";
    if (expect.startsWith("price")) {
      const px = rowsOf(await d.execute(sql`select
        (select mark from terminal_minute where symbol = ${c.symbol} and minute <= ${from} and mark is not null order by minute desc limit 1) as a,
        (select mark from terminal_minute where symbol = ${c.symbol} and minute <= ${to} and mark is not null order by minute desc limit 1) as b`))[0];
      const a = num(px?.a), b = num(px?.b);
      const move = a > 0 && b > 0 ? (b / a - 1) * 100 : null;
      outcome = { fromPx: a, toPx: b, movePct: move };
      if (move !== null && Math.abs(move) >= 0.25) verdict = (move > 0) === (expect === "price_up") ? "right" : "wrong";
    } else {
      const who = expect.startsWith("wallet") ? sql`and wallet = ${c.wallet}` : sql``;
      const r = rowsOf(await d.execute(sql`select coalesce(sum(usd), 0) as net, count(*)::int as n from terminal_trades where kind = 'trade' and symbol = ${c.symbol} and ts > ${from} and ts <= ${to} ${who}`))[0];
      const net = num(r?.net);
      outcome = { netUsd: net, trades: num(r?.n) };
      const buys = expect === "wallet_buys" || expect === "net_buying";
      // A wallet that stopped trading did not keep accumulating.
      if (expect.startsWith("wallet") && num(r?.n) === 0) verdict = "wrong";
      else if (Math.abs(net) >= 1000) verdict = (net > 0) === buys ? "right" : "wrong";
    }
    await d.execute(sql`update terminal_calls set outcome = ${JSON.stringify(outcome)}::jsonb, verdict = ${verdict} where id = ${c.id}`);
  }
  return due.length;
}

/** Hit rate of checked calls overall, and split by how the review panel scored the answer. */
export async function callStats() {
  const { d, sql } = await tdb();
  const rows = rowsOf(await d.execute(sql`select id, ask_id, claim, symbol, expect, made_at, check_at, peer_score, outcome, verdict from terminal_calls order by made_at desc limit 300`));
  const decided = rows.filter((r) => r.verdict === "right" || r.verdict === "wrong");
  const rate = (xs: typeof rows) => (xs.length ? xs.filter((r) => r.verdict === "right").length / xs.length : null);
  const hi = decided.filter((r) => num(r.peer_score) >= 90), lo = decided.filter((r) => r.peer_score !== null && num(r.peer_score) < 90);
  return {
    made: rows.length, checked: decided.length, pending: rows.filter((r) => r.verdict === null).length,
    hitRate: rate(decided), hitRateHighScore: rate(hi), nHigh: hi.length, hitRateLowScore: rate(lo), nLow: lo.length,
    recent: rows.slice(0, 20).map((r) => ({ id: String(r.id), askId: r.ask_id ? String(r.ask_id) : null, claim: String(r.claim), symbol: String(r.symbol), expect: String(r.expect), at: iso(r.made_at), checkAt: iso(r.check_at), peerScore: r.peer_score === null ? null : num(r.peer_score), verdict: r.verdict ? String(r.verdict) : null, outcome: typeof r.outcome === "string" ? JSON.parse(r.outcome) : r.outcome ?? null })),
  };
}
