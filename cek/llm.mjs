/**
 * /cek verdict LLM — any OpenAI-compatible chat-completions URL (OpenRouter, DeepSeek...),
 * ported from rh-lp-bot's radar/openrouter.ts. Separate from ai.mjs on purpose: ai.mjs is
 * tuned for long web-search narratives; /cek needs one short JSON object, fast.
 * Best-effort: null when no key or on any failure.
 */

// Reasoning models (deepseek-v4-flash, thinking ON) spend completion tokens thinking before
// the JSON. A data-heavy prompt sometimes burns the whole first budget (finish=length,
// empty content) -> retry ONCE with a bigger budget.
const TOKEN_BUDGETS = [4000, 8000];

export async function llmVerdict(env, system, user) {
  if (!env.llmKey) return null;
  const body = (maxTokens) => JSON.stringify({
    model: env.llmModel,
    messages: [{ role: "system", content: system }, { role: "user", content: user }],
    response_format: { type: "json_object" },
    stream: false,
    temperature: 0.2,
    max_tokens: maxTokens,
  });
  let budget = 0;
  let throttled = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    const maxTokens = TOKEN_BUDGETS[budget];
    try {
      const res = await fetch(env.llmUrl, {
        method: "POST",
        headers: { authorization: `Bearer ${env.llmKey}`, "content-type": "application/json", "x-title": "sol-pump-screener /cek" },
        body: body(maxTokens),
        signal: AbortSignal.timeout(budget === 0 ? 40_000 : 90_000),
      });
      if (res.status === 429 && !throttled) {
        throttled = true;
        const wait = Math.min(8000, (Number(res.headers.get("retry-after")) || 5) * 1000);
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }
      if (!res.ok) {
        console.warn(`  [cek] llm HTTP ${res.status}`);
        return null;
      }
      const j = await res.json();
      const ch = j?.choices?.[0] ?? {};
      const msg = ch.message ?? {};
      // reasoning models sometimes leave content null and put the answer in `reasoning`
      const v = parseVerdict(msg.content || msg.reasoning || "");
      if (v) return v;
      if (ch.finish_reason === "length" && budget < TOKEN_BUDGETS.length - 1) {
        budget++;
        continue;
      }
      console.warn(`  [cek] llm answer empty/not JSON — finish=${ch.finish_reason}`);
      return null;
    } catch (err) {
      console.warn(`  [cek] llm failed: ${err.message.slice(0, 80)}`);
      return null;
    }
  }
  return null;
}

function parseVerdict(content) {
  let obj;
  try {
    obj = JSON.parse(content);
  } catch {
    const m = content.match(/\{[\s\S]*\}/);   // some models wrap JSON in prose
    if (!m) return null;
    try {
      obj = JSON.parse(m[0]);
    } catch {
      return null;
    }
  }
  const score = Math.max(0, Math.min(100, Number(obj.score) || 0));
  const action = ["ape", "watch", "skip"].includes(obj.action) ? obj.action : score >= 70 ? "ape" : score >= 40 ? "watch" : "skip";
  return { score, action, summary: String(obj.summary ?? "").slice(0, 240) };
}
