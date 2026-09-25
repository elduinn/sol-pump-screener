/**
 * LLM client. Supports two wire protocols:
 *
 *   "openai"    — POST {baseUrl}/chat/completions, Bearer auth.
 *                 Works with OpenAI, DeepSeek, Gemini's compat layer, OpenRouter,
 *                 LM Studio, and anything else speaking that shape.
 *
 *   "anthropic" — POST {baseUrl}/v1/messages, x-api-key + anthropic-version.
 *                 NOT OpenAI-compatible: different path, different auth header,
 *                 different request body, and the reply is an array of content
 *                 blocks rather than a single string.
 *
 * Credentials come from this project's own .env — see .env.example.
 */

import { readEnvFile } from "./telegram.mjs";

const ANTHROPIC_VERSION = "2023-06-01";

export function resolveAiCreds(cfg) {
  const a = cfg.ai ?? {};
  const fileEnv = readEnvFile(a.envFile);
  const pick = (k) => process.env[k] ?? fileEnv[k];

  const baseUrl = (a.baseUrl ?? pick(a.baseUrlEnvVar ?? "LLM_BASE_URL") ?? "https://api.anthropic.com")
    .replace(/\/+$/, "");

  // "auto" infers from the host so switching providers is a .env edit.
  let provider = a.provider ?? "auto";
  if (provider === "auto") provider = /anthropic\.com/i.test(baseUrl) ? "anthropic" : "openai";

  const apiKey = a.apiKey
    ?? pick(a.apiKeyEnvVar ?? "LLM_API_KEY")
    ?? pick(provider === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY");

  return {
    provider,
    baseUrl,
    apiKey,
    model: a.model ?? pick(a.modelEnvVar ?? "LLM_MODEL")
      ?? (provider === "anthropic" ? "claude-sonnet-5" : "gpt-4o-mini"),
    source: a.envFile,
  };
}

async function postJson(url, headers, body, timeoutMs) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    const json = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, json };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// OPENAI-COMPATIBLE
// ---------------------------------------------------------------------------

async function askOpenAi(cfg, prompt, creds) {
  const a = cfg.ai ?? {};
  const body = {
    model: creds.model,
    messages: [{ role: "user", content: prompt }],
    temperature: a.temperature ?? 0.2,
    max_tokens: a.maxTokens ?? 2000,
    // Thinking models bill hidden reasoning against max_tokens; "low" measured
    // 10.4s vs 47.1s unset on gemini-3.6-flash.
    ...(a.reasoningEffort ? { reasoning_effort: a.reasoningEffort } : {}),
  };

  const r = await postJson(`${creds.baseUrl}/chat/completions`,
    { authorization: `Bearer ${creds.apiKey}` }, body, a.timeoutMs ?? 120_000);
  if (!r.ok) throw new Error(r.json?.error?.message ?? `HTTP ${r.status}`);

  const choice = r.json?.choices?.[0];
  const text = choice?.message?.content;
  if (!text) {
    if (choice?.finish_reason === "length") {
      throw new Error(`model hit the token limit before answering (reasoning used ${r.json?.usage?.completion_tokens_details?.reasoning_tokens ?? "?"} tokens). Raise ai.maxTokens.`);
    }
    throw new Error("empty reply from model");
  }
  return { text, model: creds.model };
}

// ---------------------------------------------------------------------------
// ANTHROPIC MESSAGES API
// ---------------------------------------------------------------------------

/**
 * Notes that cost a 400 if ignored on Claude Sonnet 5 / Opus 5:
 *   - `temperature` / `top_p` / `top_k` are REJECTED at non-default values.
 *     We deliberately never send them.
 *   - Reasoning depth is `output_config.effort`, not `reasoning_effort`.
 *   - Thinking is adaptive by default; max_tokens caps thinking + text together.
 */
const EFFORT_LEVELS = new Set(["low", "medium", "high", "xhigh", "max"]);

async function askAnthropic(cfg, prompt, creds) {
  const a = cfg.ai ?? {};
  const headers = {
    "x-api-key": creds.apiKey,
    "anthropic-version": ANTHROPIC_VERSION,
  };

  const body = {
    model: creds.model,
    max_tokens: a.maxTokens ?? 4000,
    messages: [{ role: "user", content: prompt }],
  };
  if (a.reasoningEffort && EFFORT_LEVELS.has(a.reasoningEffort)) {
    body.output_config = { effort: a.reasoningEffort };
  }
  // Server-side web search — runs on Anthropic's side, no extra vendor, no
  // separate call. This is what claude.ai has and a bare API call does not.
  if (a.webSearch) {
    body.tools = [{
      type: "web_search_20260209",
      name: "web_search",
      ...(a.maxWebSearches ? { max_uses: a.maxWebSearches } : {}),
    }];
  }

  let json;
  // A server tool can pause the turn when its internal loop hits its cap;
  // resume by replaying the assistant turn rather than nudging with text.
  for (let hop = 0; ; hop++) {
    const r = await postJson(`${creds.baseUrl}/v1/messages`, headers, body, a.timeoutMs ?? 120_000);
    if (!r.ok) throw new Error(r.json?.error?.message ?? `HTTP ${r.status}`);
    json = r.json;

    if (json.stop_reason !== "pause_turn" || hop >= (a.maxPauseResumes ?? 3)) break;
    body.messages = [
      ...body.messages.filter((m) => m.role === "user" && typeof m.content === "string"),
      { role: "assistant", content: json.content },
    ];
  }

  if (json.stop_reason === "refusal") {
    throw new Error(`model declined this request${json.stop_details?.category ? ` (${json.stop_details.category})` : ""}`);
  }

  // content is an array of blocks; text lives in the text ones. Thinking blocks
  // and web-search results share the array and must be skipped.
  const text = (json.content ?? [])
    .filter((b) => b.type === "text" && b.text)
    .map((b) => b.text)
    .join("\n")
    .trim();

  if (!text) {
    if (json.stop_reason === "max_tokens") {
      throw new Error("model hit max_tokens before writing an answer. Raise ai.maxTokens.");
    }
    throw new Error("empty reply from model");
  }
  return { text, model: json.model ?? creds.model };
}

// ---------------------------------------------------------------------------

export async function askLlm(cfg, prompt) {
  const creds = resolveAiCreds(cfg);
  if (!creds.apiKey) {
    throw new Error(`no API key (looked for ${cfg.ai?.apiKeyEnvVar ?? "LLM_API_KEY"} in ${cfg.ai?.envFile ?? "process env"})`);
  }
  return creds.provider === "anthropic"
    ? askAnthropic(cfg, prompt, creds)
    : askOpenAi(cfg, prompt, creds);
}

/** Cheap credential check — lists models where the provider supports it. */
export async function listModels(cfg) {
  const creds = resolveAiCreds(cfg);
  if (!creds.apiKey) throw new Error("no API key");
  const url = creds.provider === "anthropic"
    ? `${creds.baseUrl}/v1/models?limit=100`
    : `${creds.baseUrl}/models`;
  const headers = creds.provider === "anthropic"
    ? { "x-api-key": creds.apiKey, "anthropic-version": ANTHROPIC_VERSION }
    : { authorization: `Bearer ${creds.apiKey}` };
  const res = await fetch(url, { headers });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json?.error?.message ?? `HTTP ${res.status}`);
  return (json.data ?? []).map((m) => String(m.id).replace(/^models\//, ""));
}
