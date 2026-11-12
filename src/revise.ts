/**
 * The rewrite from critique. When independent reviewers score an answer under
 * the house bar, the agent rewrites it on SERV Reasoning from their critique,
 * using the same evidence: no new tool calls, so it can fix how faithfully and
 * clearly the data is reported but cannot add numbers. SERV's Shadow Agent
 * validates the rewrite against SHADOW_HINT before it is returned.
 */
import { chatOn, type Engine, type Msg } from "./llm";
import { activeLessons } from "./lessons";

export const SHADOW_HINT =
  "The answer must lead with a one-sentence direct answer, use only figures that appear in the tool results, cite wallets and transactions in [wallet:0x...] / [tx:0x...] form, give no buy or sell advice, and say what data is missing if it cannot answer.";

export const ANALYST_BRIEF = `You are an analyst for tokenized stocks on Robinhood Chain. Lead with the direct answer in one sentence, then 2 to 5 short bullets of evidence, then one line on what to watch. Quote figures exactly as the data gives them, cite wallets as [wallet:0x...] and transactions as [tx:0x...], describe a wallet by its behaviour label when the data gives one, and give no buy or sell advice.`;

/** The brief plus the rules the agent learned from its reviewers. */
export async function systemPrompt(base = ANALYST_BRIEF, withLessons = true) {
  const lessons = withLessons ? await activeLessons("answers").catch(() => []) : [];
  if (!lessons.length) return base;
  return `${base}\nLessons from independent reviewers of your past answers (follow them):\n${lessons.map((l) => `- ${l}`).join("\n")}`;
}

/** Normalises what any model writes into the house citation format. */
export function tidyAnswer(answer: string): string {
  return answer
    .replace(/\[(0x[0-9a-fA-F]{40,64})\]\([^)]*\)/g, "$1")
    .replace(/`(0x[0-9a-fA-F]{40,64})`/g, "$1")
    .replace(/(?<![:\w])(0x[0-9a-fA-F]{64})(?![0-9a-fA-F])/g, "[tx:$1]")
    .replace(/(?<![:\w])(0x[0-9a-fA-F]{40})(?![0-9a-fA-F])/g, "[wallet:$1]")
    .replace(/\[\[((?:tx|wallet|news):[^\]]+)\]\]/g, "[$1]")
    .replace(/\s*\u2014\s*/g, ", ")
    .replace(/\s*\[(?!(?:tx|wallet|news):)[a-z_]+:[^\]]*\]/gi, "")
    .replace(/\s*\[[a-z]+(?:_[a-z]+)+\]/g, "")
    .trim();
}

export async function revise(question: string, answer: string, critique: string, evidence: string): Promise<{ text: string; engine: Engine }> {
  const messages: Msg[] = [
    { role: "system", content: await systemPrompt() },
    {
      role: "user",
      content: `Question: ${question}\n\nEvidence your tools returned (JSON excerpts):\n${evidence.slice(0, 24_000)}\n\nYour previous answer:\n${answer}\n\nAn independent review panel scored it below the bar. Their critique:\n${critique}\n\nRewrite the answer to fix every point in the critique that the evidence supports. Use only figures from the evidence, keep the citations, keep the format (one-sentence answer, 2 to 5 bullets, one line on what to watch). If a point can't be fixed from the evidence, say once, briefly, what the data doesn't include; never repeat it per bullet. Return only the new answer.`,
    },
  ];
  const { reply, engine } = await chatOn(messages, { shadowHint: SHADOW_HINT, engine: "serv" });
  const out = tidyAnswer(String(reply.content || "").trim());
  return { text: out || answer, engine };
}
