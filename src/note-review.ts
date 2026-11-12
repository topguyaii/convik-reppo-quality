/**
 * Peer review of short market notes. A few notes a day go to Reppo's panel as
 * claims, with the figures they were written from. A note the panel scores
 * under 70 is hidden; the critiques teach the note writer its own rules
 * (lessons.ts, scope "notes").
 */
import { reppoEnabled, submitEval, getEval } from "./reppo";
import { tdb, rowsOf } from "./db";

export const HIDE_BELOW = 70;

export function noteInput(text: string, figures: string) {
  return `Claim: ${text}\n\nContext for reviewers: a one-sentence note on a live dashboard of tokenized-stock flow on Robinhood Chain, written by an AI for a smart non-trader. It must use only figures from the data below, be accurate and not misleading, separate fact from interpretation, and give no buy or sell advice. Judge it against this data:\n${figures.slice(0, 8000)}`;
}

export async function reviewNote(note: { id: number | string; text: string }, figures: string) {
  if (!reppoEnabled()) return null;
  const { d, sql } = await tdb();
  const cap = Number(process.env.REPPO_DAILY_NOTES || 4);
  const today = rowsOf(await d.execute(sql`select count(*)::int as n from terminal_evals where kind = 'note' and created_at > date_trunc('day', now())`))[0];
  if (Number(today?.n || 0) >= cap) return null;
  const input = noteInput(note.text, figures);
  const e = await submitEval("claim", input);
  await d.execute(sql`insert into terminal_evals (id, kind, ref, version, input, output, status) values (${e.id}, 'note', ${String(note.id)}, 1, ${input}, ${note.text}, ${e.status}) on conflict (id) do nothing`);
  return e.id;
}

/** Read finished note reviews and hide the notes the panel scored low. */
export async function advanceNoteReviews() {
  if (!reppoEnabled()) return 0;
  const { d, sql } = await tdb();
  const open = rowsOf(await d.execute(sql`select id, ref from terminal_evals where kind = 'note' and completed_at is null and created_at > now() - interval '1 day' limit 10`));
  let n = 0;
  for (const r of open) {
    const e = await getEval(String(r.id)).catch(() => null);
    if (!e || (e.status !== "COMPLETED" && e.status !== "FAILED")) continue;
    await d.execute(sql`update terminal_evals set status = ${e.status}, score = ${e.score}, route = ${e.route}, confidence = ${e.confidence}, reason = ${e.reason}, rubric = ${e.rubric ? JSON.stringify(e.rubric) : null}::jsonb, result = ${JSON.stringify(e.raw)}::jsonb, completed_at = now() where id = ${e.id}`);
    if (e.status === "COMPLETED") {
      await d.execute(sql`update terminal_notes set review = ${JSON.stringify({ evalId: e.id, score: e.score, route: e.route, reason: e.reason })}::jsonb, hidden = ${(e.score ?? 0) < HIDE_BELOW} where id = ${Number(r.ref)}`);
    }
    n++;
  }
  return n;
}
