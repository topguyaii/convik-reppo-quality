import { describe, it, expect, vi, afterEach } from "vitest";
import { reviewInput, critiqueOf } from "../src/quality";
import { submitEval, waitEval } from "../src/reppo";

afterEach(() => { vi.unstubAllGlobals(); delete process.env.REPPO_API_KEY; });

describe("peer review input", () => {
  it("gives reviewers the question, the answer, the rules and the data", () => {
    const s = reviewInput("Who is buying NVDA?", "A whale bought +$500K.", '{"usd_fmt":"+$500K"}');
    expect(s.startsWith("User prompt: Who is buying NVDA?\n\nAI response: A whale bought +$500K.")).toBe(true);
    expect(s).toContain("no buy or sell advice");
    expect(s).toContain('Data the AI retrieved (JSON excerpts):\n{"usd_fmt":"+$500K"}');
  });

  it("caps the evidence so the submission stays under Reppo's limit", () => {
    expect(reviewInput("q", "a", "x".repeat(100_000)).length).toBeLessThan(32_000);
  });

  it("turns a verdict into a critique the agent can act on", () => {
    const c = critiqueOf({ id: "e1", status: "COMPLETED", score: 58, route: "review", confidence: "medium", reason: "Cites a figure not in the data.", rubric: { accuracy: 50, clarity: 80 }, routeReasons: ["accuracy below gate"], raw: { trace: { a: "the $2M figure is unsupported" } } });
    expect(c).toContain("Cites a figure not in the data.");
    expect(c).toContain("- accuracy below gate");
    expect(c).toContain("accuracy 50, clarity 80");
    expect(c).toContain("the $2M figure is unsupported");
  });
});

describe("reppo client", () => {
  it("submits and reads an evaluation", async () => {
    process.env.REPPO_API_KEY = "k";
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    let n = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (init?.method === "POST") return new Response(JSON.stringify({ id: "ev1", status: "QUEUED", score: null, route: null, result: null }), { status: 201 });
      n++;
      const done = n >= 2;
      return new Response(JSON.stringify({ id: "ev1", status: done ? "COMPLETED" : "PROCESSING", score: done ? 82 : null, route: done ? "ship" : null, result: done ? { score: 82, route: "ship", confidence: "high", reason: "Accurate.", rubric_scores: { accuracy: 85 }, explain: { route_reasons: ["meets bar"] } } : null }), { status: 200 });
    }));
    const e = await submitEval("response", "User prompt: q\n\nAI response: a");
    expect(e.id).toBe("ev1");
    expect(calls[0]!.url).toBe("https://eval.reppo.xyz/api/v1/agents/evals");
    expect(JSON.parse(String(calls[0]!.init!.body))).toEqual({ taskType: "response", input: "User prompt: q\n\nAI response: a" });
    expect((calls[0]!.init!.headers as Record<string, string>).authorization).toBe("Bearer k");
    const done = await waitEval("ev1", 10_000, 1);
    expect(done).toMatchObject({ status: "COMPLETED", score: 82, route: "ship", confidence: "high", reason: "Accurate.", rubric: { accuracy: 85 }, routeReasons: ["meets bar"] });
  });
});
