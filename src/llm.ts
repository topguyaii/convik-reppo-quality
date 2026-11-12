/**
 * The Terminal's model call, on one of two engines. Kimi carries everyday
 * traffic (every Ask answer). SERV Reasoning (OpenServ) does the low-volume
 * work where its reasoning layer and Shadow Agent validator matter most:
 * rewriting an answer from the review panel's critique, and writing lessons.
 * If SERV fails or runs out of credit, the call falls back to Kimi.
 * TERMINAL_LLM=serv sends everything to SERV; =kimi keeps SERV off entirely.
 */
export type Msg = { role: "system" | "user" | "assistant" | "tool"; content: string | null; tool_calls?: unknown[]; tool_call_id?: string; name?: string };
export type ToolDef = { name: string; description: string; parameters: unknown };
export type Reply = { content?: string | null; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> };

export type Engine = "kimi" | "serv";
const servAvailable = () => Boolean(process.env.SERV_API_KEY) && process.env.TERMINAL_LLM !== "kimi";
/** The engine a call actually uses: everything on SERV only when TERMINAL_LLM=serv. */
export const engineFor = (want: Engine = "kimi"): Engine => (servAvailable() && (want === "serv" || process.env.TERMINAL_LLM === "serv") ? "serv" : "kimi");
export const usingServ = () => engineFor("kimi") === "serv";
export const servModel = () => process.env.SERV_MODEL || "gpt-5.6-terra";
export const kimiModel = () => process.env.TERMINAL_MODEL || process.env.UNDERWRITE_MODEL || "kimi-k2.6";
export const engineLabel = (e: Engine) => (e === "serv" ? `SERV Reasoning · ${servModel()}` : `Kimi · ${kimiModel()}`);
export const providerName = (want: Engine = "kimi") => engineLabel(engineFor(want));

type Opts = { tools?: ToolDef[]; maxTokens?: number; shadowHint?: string; timeoutMs?: number; engine?: Engine };

/** One completion. Returns the reply and the engine that produced it. */
export async function chatOn(messages: Msg[], opts: Opts = {}): Promise<{ reply: Reply; engine: Engine }> {
  const engine = engineFor(opts.engine);
  if (engine === "serv") {
    try { return { reply: await call(messages, opts, true), engine }; }
    catch (e) { console.warn("[terminal] SERV call failed, using Kimi:", (e as Error).message.slice(0, 160)); }
  }
  return { reply: await call(messages, opts, false), engine: "kimi" };
}

export async function chat(messages: Msg[], opts: Opts = {}): Promise<Reply> {
  return (await chatOn(messages, opts)).reply;
}

async function call(messages: Msg[], opts: Opts, serv: boolean): Promise<Reply> {
  const url = serv ? "https://inference-api.openserv.ai/v1/chat/completions" : "https://api.moonshot.ai/v1/chat/completions";
  const apiKey = serv ? process.env.SERV_API_KEY : process.env.MOONSHOT_API_KEY || process.env.BRAIN_API_KEY;
  if (!apiKey) throw new Error("no model API key set");
  const tools: unknown[] = (opts.tools || []).map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));
  // SERV's Shadow Agent: a validator judges the draft against the hint and asks for revisions.
  if (serv && opts.shadowHint) tools.push({ type: "function", function: { name: "serv_shadow_agent", parameters: { type: "object", properties: { hint: { type: "string", default: opts.shadowHint }, max_iterations: { type: "integer", default: 2 } } } } });
  const body: Record<string, unknown> = {
    model: serv ? servModel() : kimiModel(),
    messages,
    // tool_choice only with app tools: SERV strips its own tools before the upstream call.
    ...(tools.length ? { tools } : {}),
    ...(opts.tools?.length ? { tool_choice: "auto" } : {}),
  };
  // OpenAI-family models on SERV take max_completion_tokens; Kimi takes max_tokens.
  if (serv && /^gpt|^o\d/.test(String(body.model))) {
    body.max_completion_tokens = opts.maxTokens ?? 1400;
    // Function tools (ours and SERV's validator) need the model's own reasoning off; SERV's reasoning layer still runs.
    if (tools.length) body.reasoning_effort = "none";
  } else body.max_tokens = opts.maxTokens ?? 1400;
  if (!serv) body.thinking = { type: "disabled" };
  const res = await fetch(url, {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    signal: AbortSignal.timeout(opts.timeoutMs ?? 60_000),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`model call failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
  const j = (await res.json()) as { choices?: Array<{ message?: Reply }> };
  const msg = (j.choices?.[0]?.message || {}) as Reply;
  // SERV handles its own tools server side; never hand them back as app tool calls.
  if (msg.tool_calls) msg.tool_calls = msg.tool_calls.filter((c) => !c.function.name.startsWith("serv_"));
  return msg;
}
