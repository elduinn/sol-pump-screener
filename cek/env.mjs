/**
 * /cek credentials and endpoints. Same rule as telegram.mjs: secrets come from this
 * project's .env (real process env wins), never from config.json.
 */

import { readEnvFile } from "../telegram.mjs";

// Public key shipped with every Meridian install (config.js in meridian-ev02).
const MERIDIAN_PUBLIC_KEY = "bWVyaWRpYW4taXMtdGhlLWJlc3QtYWdlbnRz";

let cached = null;

export function resolveCekEnv(cfg) {
  if (cached) return cached;
  const fileEnv = readEnvFile(cfg.cek?.envFile);
  const pick = (k) => (process.env[k] ?? fileEnv[k] ?? "").trim();
  const jupiterKey = pick("JUPITER_API_KEY");
  cached = {
    rpcUrl: pick("SOL_RPC_URL") || "https://api.mainnet-beta.solana.com",
    // Full chat-completions URL (OpenAI-compatible: OpenRouter, DeepSeek, ...).
    llmUrl: pick("CEK_LLM_URL") || "https://openrouter.ai/api/v1/chat/completions",
    llmKey: pick("CEK_LLM_KEY"),
    llmModel: pick("CEK_LLM_MODEL") || "deepseek-v4-flash",
    meridianUrl: (pick("MERIDIAN_API_URL") || "https://api.agentmeridian.xyz/api").replace(/\/+$/, ""),
    meridianKey: pick("MERIDIAN_API_KEY") || MERIDIAN_PUBLIC_KEY,
    // LP Agent open API — live open positions per DLMM pool (optional; 5 req/min free tier).
    lpagentKey: pick("LPAGENT_API_KEY"),
    jupiterKey,
    jupiterUrl: jupiterKey ? "https://api.jup.ag/swap/v1" : "https://lite-api.jup.ag/swap/v1",
  };
  return cached;
}
