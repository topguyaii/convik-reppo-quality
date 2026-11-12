/**
 * The agents' playbooks, written from feedback and pruned by results.
 *
 * Three loops live here:
 *  - From reviewers: once a day the critiques of drafts that scored under the
 *    house bar are distilled into a few short, general rules.
 *  - From the market: calls the chain proved wrong a day later become rules too,
 *    so the agent stops making the kind of call that fails.
 *  - Pruning: a rule whose problem keeps showing up in critiques after it went
 *    live isn't working, so it is retired, with the reason on the record.
 * Each rule has a scope: "answers" (the Ask agent) or "notes" (the Live tab's
 * note writer). Active rules are appended to that agent's instructions; the
 * benchmark (bench.ts) measures whether they help.
 */
import { tdb, rowsOf, iso } from "./db";
import { chat } from "./llm";

export type Scope = "answers" | "notes";
const MAX_ACTIVE = 12;
const cache = new Map<Scope, { at: number; lessons: string[] }>();

export async function activeLessons(scope: Scope = "answers"): Promise<string[]> {
  const hit = cache.get(scope);
  if (hit && Date.now() - hit.at < 5 * 60_000) return hit.lessons;
  const { d, sql } = await tdb();
  const rows = rowsOf(await d.execute(sql`select lesson from terminal_lessons where active and scope = ${scope} order by id limit ${MAX_ACTIVE}`));
  const lessons = rows.map((r) => String(r.lesson));
  cache.set(scope, { at: Date.now(), lessons });
  return lessons;
}

const parseList = (v: unknown): string[] => (typeof v === "string" ? JSON.parse(v) : (v as string[])) || [];

export async function listLessons() {
  const { d, sql } = await tdb();
  const rows = rowsOf(await d.execute(sql`select id, lesson, why, from_evals, active, created_at, scope, source, retired_at, retired_reason from terminal_lessons order by id`));
  return rows.map((r) => ({
    id: Number(r.id), lesson: String(r.lesson), why: r.why ? String(r.why) : null, fromEvals: parseList(r.from_evals),
    active: Boolean(r.active), at: iso(r.created_at), scope: String(r.scope || "answers"), source: String(r.source || "reviewers"),
    retiredAt: iso(r.retired_at), retiredReason: r.retired_reason ? String(r.retired_reason) : null,
  }));
}

function parseJson<T>(content: unknown): T | null {
  try { return JSON.parse(String(content || "").replace(/^```json\s*|```$/g, "").trim()) as T; } catch { return null; }
}

async function addLessons(scope: Scope, source: "reviewers" | "market", out: Array<{ lesson?: string; why?: string; evals?: string[] }>, valid: Set<string>, max: number) {
  const { d, sql } = await tdb();
  const added: string[] = [];
  for (const l of out.slice(0, max)) {
    const lesson = String(l.lesson || "").replace(/\s*\u2014\s*/g, ", ").trim();
    if (lesson.length < 12 || lesson.length > 240) continue;
    const from = (l.evals || []).filter((id) => valid.has(id));
    await d.execute(sql`insert into terminal_lessons (lesson, why, from_evals, scope, source) values (${lesson}, ${l.why || null}, ${JSON.stringify(from.length ? from : [...valid])}::jsonb, ${scope}, ${source})`);
    added.push(lesson);
  }
  cache.delete(scope);
  return added;
}

const WHO: Record<Scope, string> = {
  answers: "an AI analyst that answers questions about tokenized-stock flow on Robinhood Chain from on-chain data",
  notes: "an AI that writes one-sentence market notes for a live dashboard of tokenized-stock flow on Robinhood Chain",
};

/** Loop: reviewers' critiques of drafts under the house bar become new rules. */
export async function learnLessons(opts: { days?: number; maxNew?: number; scope?: Scope } = {}) {
  const scope = opts.scope ?? "answers";
  const kinds = scope === "notes" ? ["note"] : ["answer", "bench"];
  const { d, sql } = await tdb();
  const used = new Set((await listLessons()).flatMap((l) => l.fromEvals));
  const rows = rowsOf(await d.execute(sql`select id, score, reason, rubric, result->'result'->'explain'->'route_reasons' as rr from terminal_evals
    where kind in (${sql.join(kinds.map((k) => sql`${k}`), sql`, `)}) and status = 'COMPLETED' and score is not null and score < 90 and created_at > now() - make_interval(days => ${opts.days ?? 3})
    order by created_at desc limit 40`)).filter((r) => !used.has(String(r.id)));
  if (rows.length < 3) return { added: [], considered: rows.length };
  const existing = await activeLessons(scope);
  const critiques = rows.map((r) => `[${r.id}] score ${r.score}: ${String(r.reason || "").slice(0, 600)} ${JSON.stringify(r.rr || [])} ${JSON.stringify(r.rubric || {})}`).join("\n");
  const msg = await chat([
    { role: "system", content: "You improve an AI's instructions from independent reviewers' critiques. Output JSON only." },
    { role: "user", content: `The AI is ${WHO[scope]}. Reviewers scored these outputs below the bar:\n${critiques}\n\nRules it already follows:\n${existing.map((l) => `- ${l}`).join("\n") || "(none)"}\n\nWrite at most ${opts.maxNew ?? 3} NEW rules that would have prevented the most common problems. Each rule: one imperative sentence under 30 words, general (not about one stock), testable, not already covered. Return {"lessons":[{"lesson":"...","why":"the pattern in the critiques, under 20 words","evals":["ids it came from"]}]}. Return {"lessons":[]} if nothing general stands out.` },
  ], { maxTokens: 900, engine: "serv" });
  const parsed = parseJson<{ lessons?: Array<{ lesson: string; why?: string; evals?: string[] }> }>(msg.content);
  const added = await addLessons(scope, "reviewers", parsed?.lessons || [], new Set(rows.map((r) => String(r.id))), opts.maxNew ?? 3);
  return { added, considered: rows.length };
}

/** Loop: calls the chain proved wrong become rules, so the agent stops making that kind of call. */
export async function learnFromMarket(opts: { days?: number; maxNew?: number } = {}) {
  const { d, sql } = await tdb();
  const used = new Set((await listLessons()).flatMap((l) => l.fromEvals));
  const wrong = rowsOf(await d.execute(sql`select id, claim, symbol, expect, outcome, peer_score from terminal_calls
    where verdict = 'wrong' and check_at > now() - make_interval(days => ${opts.days ?? 7}) order by check_at desc limit 30`))
    .filter((r) => !used.has(`call:${r.id}`));
  if (wrong.length < 2) return { added: [], considered: wrong.length };
  const right = rowsOf(await d.execute(sql`select claim, expect from terminal_calls where verdict = 'right' and check_at > now() - make_interval(days => ${opts.days ?? 7}) limit 15`));
  const existing = await activeLessons("answers");
  const msg = await chat([
    { role: "system", content: "You improve a market analyst's instructions from how its calls turned out. Output JSON only." },
    { role: "user", content: `The analyst is ${WHO.answers}. A day after each answer, its implied calls were checked against what the chain actually did.\n\nWrong:\n${wrong.map((r) => `[call:${r.id}] "${r.claim}" (${r.expect}, ${r.symbol}) outcome ${JSON.stringify(r.outcome)}`).join("\n")}\n\nRight:\n${right.map((r) => `"${r.claim}" (${r.expect})`).join("\n") || "(none yet)"}\n\nRules it already follows:\n${existing.map((l) => `- ${l}`).join("\n") || "(none)"}\n\nWrite at most ${opts.maxNew ?? 2} NEW rules about how it should phrase or qualify calls so it stops implying the kind of thing that turned out wrong (for example, not implying a wallet will keep buying from a single burst). One imperative sentence each, under 30 words, general, not already covered. Return {"lessons":[{"lesson":"...","why":"the pattern, under 20 words","evals":["call:ids it came from"]}]} or {"lessons":[]}.` },
  ], { maxTokens: 700, engine: "serv" });
  const parsed = parseJson<{ lessons?: Array<{ lesson: string; why?: string; evals?: string[] }> }>(msg.content);
  const added = await addLessons("answers", "market", parsed?.lessons || [], new Set(wrong.map((r) => `call:${r.id}`)), opts.maxNew ?? 2);
  return { added, considered: wrong.length };
}

/**
 * Loop: retire rules that don't fix their problem. A rule live for at least
 * `minHours` is checked against the critiques written since it went live; if
 * the problem it targets still shows up in most of them, it's retired with the
 * reason. Also keeps each playbook to MAX_ACTIVE rules, oldest out first.
 */
export async function pruneLessons(opts: { minHours?: number } = {}) {
  const { d, sql } = await tdb();
  const all = (await listLessons()).filter((l) => l.active);
  const retired: Array<{ id: number; reason: string }> = [];
  for (const l of all) {
    if (!l.at || Date.now() - Date.parse(l.at) < (opts.minHours ?? 36) * 3600_000) continue;
    const kinds = l.scope === "notes" ? ["note"] : ["answer", "bench"];
    // Only outputs written WITH the rule count: the benchmark's "without" arm never saw it.
    const since = rowsOf(await d.execute(sql`select reason from terminal_evals where kind in (${sql.join(kinds.map((k) => sql`${k}`), sql`, `)}) and status = 'COMPLETED' and created_at > ${l.at} and reason is not null and ref not like '%:without' order by created_at desc limit 20`));
    if (since.length < 4) continue;
    const msg = await chat([
      { role: "system", content: "You check whether a rule is fixing the problem it targets. Output JSON only." },
      { role: "user", content: `Rule: "${l.lesson}" (why it was added: ${l.why || "n/a"}).\n\nReviewers' critiques written after the rule went live:\n${since.map((r, i) => `${i + 1}. ${String(r.reason).slice(0, 400)}`).join("\n")}\n\nIn how many of these critiques does the problem this rule targets still appear? Return {"recurring": <count>, "total": ${since.length}, "note": "under 20 words"}.` },
    ], { maxTokens: 200 });
    const v = parseJson<{ recurring?: number; note?: string }>(msg.content);
    if (v && typeof v.recurring === "number" && v.recurring / since.length >= 0.5) {
      const reason = `Problem still in ${v.recurring} of ${since.length} critiques after it went live${v.note ? `: ${v.note}` : ""}`;
      await d.execute(sql`update terminal_lessons set active = false, retired_at = now(), retired_reason = ${reason.slice(0, 300)} where id = ${l.id}`);
      retired.push({ id: l.id, reason });
    }
  }
  for (const scope of ["answers", "notes"] as Scope[]) {
    const live = rowsOf(await d.execute(sql`select id from terminal_lessons where active and scope = ${scope} order by id`));
    for (const r of live.slice(0, Math.max(0, live.length - MAX_ACTIVE))) {
      await d.execute(sql`update terminal_lessons set active = false, retired_at = now(), retired_reason = 'Oldest rule retired to keep the playbook short' where id = ${Number(r.id)}`);
      retired.push({ id: Number(r.id), reason: "playbook cap" });
    }
    cache.delete(scope);
  }
  return { checked: all.length, retired };
}
