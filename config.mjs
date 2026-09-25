/**
 * Config loading, validation and gmgn-cli argument construction.
 *
 * Everything gmgn-cli accepts is driven by the tables below, which were
 * extracted from gmgn-cli v1.5.7's own source (dist/commands/market.js,
 * RANK_RANGE_FIELDS) rather than hand-typed — so the config surface cannot
 * drift from what the binary actually supports.
 *
 * Why validation is strict: the openapi service SILENTLY IGNORES unknown range
 * metrics. A typo like `min_market_cap` (instead of `min_marketcap`) would not
 * error — it would just quietly stop filtering and you would never notice.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Directory this project lives in — NOT the caller's cwd. */
const PROJECT_DIR = path.dirname(fileURLToPath(import.meta.url));

/**
 * Resolve a configured path. Relative paths are anchored to the project
 * directory, so `./.env` means the same file whether you run from here, from
 * `/`, or from cron — where cwd is the user's home.
 */
export function resolveProjectPath(p) {
  if (!p) return p;
  return path.isAbsolute(p) ? p : path.resolve(PROJECT_DIR, p);
}

// ---------------------------------------------------------------------------
// PARAMETER TABLES (from gmgn-cli v1.5.7)
// ---------------------------------------------------------------------------

/** All 38 server-side range filters `market trending` accepts. */
export const RANGE_PARAMS = {
  min_volume: "float", max_volume: "float",
  min_liquidity: "float", max_liquidity: "float",
  min_marketcap: "float", max_marketcap: "float",
  min_history_highest_marketcap: "float", max_history_highest_marketcap: "float",
  min_swaps: "int", max_swaps: "int",
  min_holder_count: "int", max_holder_count: "int",
  min_gas_fee: "float", max_gas_fee: "float",
  min_renowned_count: "int", max_renowned_count: "int",
  min_smart_degen_count: "int", max_smart_degen_count: "int",
  min_bot_degen_count: "int", max_bot_degen_count: "int",
  min_visiting_count: "int", max_visiting_count: "int",
  min_price_change_percent: "float", max_price_change_percent: "float",
  min_insider_rate: "float", max_insider_rate: "float",
  min_bundler_rate: "float", max_bundler_rate: "float",
  min_entrapment_ratio: "float", max_entrapment_ratio: "float",
  min_top10_holder_rate: "float", max_top10_holder_rate: "float",
  min_top70_sniper_hold_rate: "float", max_top70_sniper_hold_rate: "float",
  min_dev_team_hold_rate: "float", max_dev_team_hold_rate: "float",
  min_created: "duration", max_created: "duration",
};

/**
 * Range params whose meaning is tied to --interval. The 5-minute enrichment
 * pass queries --interval 5m, so these MUST be dropped there: a 1h-sized
 * volume floor or a 1h pump threshold applied to a 5m window would wrongly
 * discard almost everything.
 *   volume  -> "Trading volume for the queried interval"
 *   swaps   -> "Total swap count in the queried interval"
 *   price_change_percent -> "Price change % for the queried interval"
 */
export const INTERVAL_SCOPED_PARAMS = new Set([
  "min_volume", "max_volume",
  "min_swaps", "max_swaps",
  "min_price_change_percent", "max_price_change_percent",
]);

/**
 * Parameters that are real gmgn-cli options but belong to a DIFFERENT command,
 * so they do nothing under `market trending`. Called out by name because the
 * failure mode is otherwise invisible: the service ignores what it doesn't
 * recognize rather than rejecting it.
 */
export const WRONG_COMMAND_PARAMS = {
  min_total_fee: "market trenches", max_total_fee: "market trenches",
  total_fee_min: "market signal", total_fee_max: "market signal",
  min_volume_24h: "market trenches", max_volume_24h: "market trenches",
  min_volume_1h: "market trenches", max_volume_1h: "market trenches",
  min_swaps_24h: "market trenches", max_swaps_24h: "market trenches",
  min_progress: "market trenches", max_progress: "market trenches",
  min_rug_ratio: "market trenches", max_rug_ratio: "market trenches",
  min_fresh_wallet_rate: "market trenches", max_fresh_wallet_rate: "market trenches",
  min_insider_ratio: "market trenches", max_insider_ratio: "market trenches",
  min_top_holder_rate: "market trenches", max_top_holder_rate: "market trenches",
  min_x_follower: "market trenches", max_x_follower: "market trenches",
  min_tg_call_count: "market trenches", max_tg_call_count: "market trenches",
  mc_min: "market signal", mc_max: "market signal",
};

/** Table columns the renderer knows about. Mirrors COLUMNS in screener.mjs. */
export const VALID_COLUMNS = [
  "symbol", "price", "mcap", "volume", "vol5m", "vol24h", "rvol", "liquidity",
  "pump1h", "pump5m", "swaps", "holders", "smartMoney",
  "age", "offHigh", "recentShare", "when",
];

export const VALID_CHAINS = ["sol", "bsc", "base", "eth", "robinhood", "arc", "stable"];
export const VALID_INTERVALS = ["1m", "5m", "1h", "6h", "24h"];
export const VALID_RESOLUTIONS = ["30s", "1m", "5m", "15m", "1h", "4h", "1d"];
export const VALID_DIRECTIONS = ["asc", "desc"];
export const VALID_ORDER_BY = [
  "default", "swaps", "marketcap", "history_highest_market_cap", "liquidity",
  "volume", "holder_count", "smart_degen_count", "renowned_count", "gas_fee",
  "price", "change1m", "change5m", "change1h", "creation_timestamp",
];
export const VALID_FILTER_TAGS = {
  evm: ["not_honeypot", "verified", "renounced", "locked", "token_burnt", "has_social",
        "not_social_dup", "not_image_dup", "dexscr_update_link", "is_internal_market", "is_out_market"],
  sol: ["renounced", "frozen", "burn", "token_burnt", "has_social", "not_social_dup",
        "not_image_dup", "dexscr_update_link", "not_wash_trading", "is_internal_market", "is_out_market"],
};
const EVM_CHAINS = new Set(["bsc", "base", "eth", "robinhood", "arc", "stable"]);

/**
 * Solana launchpad_platform values for `trending.platforms` (--platform).
 * GMGN's documented list (skills/gmgn-market/SKILL.md, gmgn-cli v1.5.7) plus
 * values seen live but missing from the docs — `stonkfun` works server-side
 * (verified 2026-09-14: 100/100 rows came back stonkfun) yet is undocumented.
 * Names are case-sensitive: "Pump.fun", not "pump.fun".
 */
export const SOL_PLATFORMS = [
  "Pump.fun", "pump_mayhem", "pump_mayhem_agent", "pump_agent", "letsbonk", "bonkers",
  "bags", "memoo", "liquid", "bankr", "zora", "surge", "anoncoin", "moonshot_app",
  "wendotdev", "heaven", "sugar", "token_mill", "believe", "trendsfun", "trends_fun",
  "jup_studio", "Moonshot", "boop", "xstocks", "ray_launchpad", "meteora_virtual_curve",
  "pool_ray", "pool_meteora", "pool_pump_amm", "pool_orca",
  // Observed live, not in GMGN's docs:
  "stonkfun",
];

// ---------------------------------------------------------------------------
// DEFAULTS
// ---------------------------------------------------------------------------
// Solana. config.json holds the live-calibrated values; these are fallbacks.
// Sampled 2026-09-14 (top 100 by 1h change): median mcap ~$22K, median 1h
// volume ~$5K, median liquidity ~$13K, median rug_ratio ~0.10.

export const DEFAULTS = {
  chain: "sol",

  cli: {
    bin: "gmgn-cli",
    timeoutMs: 60_000,
    maxBufferMB: 32,
  },

  trending: {
    interval: "1h",
    orderBy: "change1h",
    direction: "desc",
    limit: 100,
    // not_honeypot is EVM-only. Sol already applies renounced + frozen
    // server-side by default (verified: identical results with and without).
    // Do NOT use not_social_dup with stonkfun: ~31% of stonkfun tokens list
    // stonkfun.xyz as their website, so GMGN flags them all as duplicates
    // (website_dup in the thousands) and the tag drops genuine tokens.
    // Verified 2026-09-14: it removed every stonkfun candidate.
    filters: ["not_wash_trading", "not_image_dup"],
    // Launchpad filter, applied server-side across the whole chain. Empty =
    // every launchpad. See SOL_PLATFORMS for valid names.
    platforms: ["stonkfun"],
    range: {
      min_marketcap: 50_000,
      max_marketcap: 10_000_000,
      min_volume: 10_000,
      min_liquidity: 10_000,
      max_top10_holder_rate: 0.5,
      // PERCENT, not ratio — verified empirically against the live API.
      min_price_change_percent: 10,
    },
  },

  kline: {
    resolution: "5m",
    lookbackSec: 1800,
  },

  screen: {
    minPump1hPercent: 10,
    excludeTokenizedStocks: true,
    // Minimum USD volume in the trailing 5-minute window. Applied AFTER the
    // vol5m enrichment call, so the filter can only run when either
    // fiveMinute.enabled or freshness.enabled is true (both stages populate
    // vol5m). Tokens whose vol5m could not be measured are kept — a missing
    // measurement is not evidence of low volume. null = no filter.
    minVol5m: null,
    // Minimum USD volume over the trailing 24h. trending.range.min_volume is
    // scoped to trending.interval (1h), so this needs its own query: one extra
    // `market trending --interval 24h` call per pass, made only when at least
    // one token survived screen(), and before any kline call so dropped tokens
    // cost nothing further. null = no filter, no extra call.
    minVolume24h: null,
    // Show only rows whose freshness verdict is in this list.
    // Values: "live" | "warm" | "cooling" | "stale" | "unknown".
    // null or an empty array = show all (no filter).
    // Requires `freshness.enabled: true` — the verdict comes from the freshness
    // stage, so filtering by it does nothing when that stage is skipped.
    showVerdicts: null,
  },

  risk: {
    maxRugRatio: 0.3,
    maxTop10HolderRate: 0.5,
    rejectWashTrading: true,
    rejectHoneypot: true,
  },

  fiveMinute: {
    enabled: true,
    source: "hybrid",          // "rank" | "kline" | "hybrid"
    interval: "5m",
    orderBy: "volume",
    maxKlineCalls: 8,
  },

  // Is the pump actually happening NOW? The 1h change field is point-to-point
  // — price(now) vs price(1h ago) — so it cannot tell a live move from one
  // that spiked 50 minutes ago and has been fading since. This walks 1m
  // candles to locate WHEN the gain accrued.
  freshness: {
    enabled: true,
    resolution: "1m",
    lookbackMin: 70,
    recentWindowMin: 15,
    maxKlineCalls: 10,
    // Gates. null = report only, do not drop.
    minRecentSharePercent: null,   // e.g. 40 -> >=40% of the move in recentWindowMin
    maxOffHighPercent: null,       // e.g. 10 -> drop if more than 10% below the window high
    maxMoveAgeMin: null,           // e.g. 25 -> drop if the gain midpoint is older than this
  },

  watch: {
    intervalMs: 180_000,
    rateLimitBackoffMs: 300_000,
  },

  // Independent discovery path for newly created tokens doing exceptional
  // short-window volume. This does NOT inherit the 1h pump screener's gates.
  newTokenAlerts: {
    enabled: true,
    pollIntervalMs: 60_000,
    rateLimitBackoffMs: 300_000,
    cooldownMin: 30,
    minVolume5mUsd: 300_000,
    /** Ignore the first noisy minutes after launch. */
    minTokenAgeMin: 40,
    maxTokenAgeMin: 60,
    minMarketCapUsd: null,
    maxMarketCapUsd: null,
    minLiquidityUsd: null,
    maxResults: 30,
    stateFile: "./data/new-token-alerts.json",
  },

  // LLM prompt -> Telegram. Credentials come from this project's own .env.
  ai: {
    enabled: true,
    envFile: "./.env",
    baseUrlEnvVar: "LLM_BASE_URL",
    apiKeyEnvVar: "LLM_API_KEY",
    modelEnvVar: "LLM_MODEL",
    provider: "auto",        // "auto" | "openai" | "anthropic"
    baseUrl: null,
    apiKey: null,
    model: null,
    // Anthropic's server-side web search — same API call, no extra vendor.
    // This is the capability claude.ai has that a bare API call does not.
    webSearch: true,
    maxWebSearches: 5,
    maxPauseResumes: 3,
    // NOTE: ignored on the anthropic provider — Claude Sonnet 5 / Opus 5 reject
    // non-default temperature/top_p/top_k with a 400, so it is never sent there.
    temperature: 0.2,
    // Reasoning models (e.g. deepseek-v4-flash) spend most of this budget on
    // hidden reasoning tokens before writing a single visible character. At 900
    // the reply came back completely empty with finish_reason "length".
    // Covers hidden reasoning tokens plus the visible answer. Too low and the
    // model burns the whole budget thinking and returns nothing.
    maxTokens: 4000,
    // "low" | "medium" | "high" | null (omit). Caps hidden reasoning.
    reasoningEffort: "low",
    // Short prompts return in ~3s, but the analysis prompt varies. 120s is
    // generous headroom without hanging the bot for minutes.
    timeoutMs: 120_000,
    // {address} is substituted. Edit this freely — it is the whole prompt.
    promptTemplate:
      "You are an expert Solana memecoin analyst and on-chain sleuth. Your job is to " +
      "analyze the cultural narrative and background story of crypto tokens. " +
      "Please search the web for the token with the contract address: `{address}`. " +
      "Format your response for Telegram. Keep it concise, punchy, and use bullet " +
      "points. Please provide:\n\n" +
      "* Origin Story: How and why was this token created?\n" +
      "* The Narrative: What is the core meme or community driving this?\n" +
      "* Vibe Check: Is the sentiment bullish, cult-like, or fading?\n" +
      "* Red Flags: Any obvious warnings in the narrative or origin?",
  },

  // Telegram delivery. Credentials live in this project's own .env, never in
  // this config — config.json is the file you would share; .env is not.
  telegram: {
    enabled: false,
    envFile: "./.env",
    tokenEnvVar: "TELEGRAM_BOT_TOKEN",
    chatIdsEnvVar: "TELEGRAM_USER_IDS",
    chatIds: [],             // empty = use every id from chatIdsEnvVar
    parseMode: "Markdown",   // safe for the fenced table; prose is sent as plain
    silent: false,           // true = deliver without a notification sound
    sendWhenEmpty: false,    // true = still message when nothing matched
    includeAddresses: true,
    timeoutMs: 15_000,
    // Per-token repeat suppression for the MAIN screener alert. The same
    // tokens keep matching pass after pass, so without this a --watch run
    // repeats the same symbols every intervalMs until you stop reading them.
    // 0 = disabled. Applies to --watch / --serve only; a single manual pass is
    // never suppressed and never advances the clock.
    cooldownMin: 0,
    cooldownStateFile: "./data/screener-alerts.json",
  },

  // /cek <mint> — "should I LP this on Meteora DLMM?" verdict (cek/). Triggered by the
  // /cek command or the ⚖️ Cek button on alerts, so it needs the --listen/--serve loop.
  // Secrets (CEK_LLM_URL/KEY/MODEL, optional SOL_RPC_URL, MERIDIAN_API_KEY, JUPITER_API_KEY)
  // come from envFile, never from here.
  cek: {
    enabled: true,
    envFile: "./.env",
    // "meme" rewards memes · "neutral" ignores meme vs utility · "utility" penalises memes
    thesis: "meme",
    // Free-text rules appended to the LLM system prompt.
    thesisExtra: "",
    minFeePct: 0,          // hide DLMM pools with base fee below this %
    minTvlUsd: 100,        // hide dust pools below this TVL
    maxPools: 5,           // pools listed and sent to the LLM
    topLpPools: 2,         // busiest pools that get a Meridian top-LPer study (2 requests each)
    roundTripSol: 0.05,    // SOL in the simulated Jupiter buy->sell quote (no tx is sent)
    maxLossPct: 6,         // round-trip loss above this % is flagged
    chart: true,
    chartInterval: "15_MINUTE",
  },

  output: {
    showAddresses: true,
    json: false,
    columns: [
      "symbol", "price", "mcap", "volume", "vol5m", "rvol", "liquidity",
      "pump1h", "pump5m", "smartMoney", "age", "offHigh", "when",
    ],
  },
};

// ---------------------------------------------------------------------------
// LOADING
// ---------------------------------------------------------------------------

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** Deep-merge user config over defaults. Arrays replace wholesale. */
function merge(base, over) {
  if (!isPlainObject(over)) return over === undefined ? base : over;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) {
    out[k] = isPlainObject(v) && isPlainObject(base?.[k]) ? merge(base[k], v) : v;
  }
  return out;
}

class ConfigError extends Error {}

/** Levenshtein, for "did you mean" on misspelled parameter names. */
function editDistance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return d[a.length][b.length];
}

function suggest(name, candidates) {
  const best = candidates
    .map((c) => [c, editDistance(name, c)])
    .sort((x, y) => x[1] - y[1])
    .filter(([, d]) => d <= Math.max(3, Math.ceil(name.length * 0.35)));
  return best.length ? ` Did you mean "${best[0][0]}"?` : "";
}

// ---------------------------------------------------------------------------
// VALIDATION
// ---------------------------------------------------------------------------

function checkEnum(value, valid, label, errors) {
  if (value === undefined || value === null) return;
  if (!valid.includes(value)) {
    errors.push(`${label}: "${value}" is not valid. Allowed: ${valid.join(" / ")}`);
  }
}

const DURATION_RE = /^\d+(\.\d+)?[mhd]$/;

export function validate(cfg) {
  const errors = [];
  const warnings = [];

  checkEnum(cfg.chain, VALID_CHAINS, "chain", errors);
  checkEnum(cfg.trending?.interval, VALID_INTERVALS, "trending.interval", errors);
  checkEnum(cfg.trending?.orderBy, VALID_ORDER_BY, "trending.orderBy", errors);
  checkEnum(cfg.trending?.direction, VALID_DIRECTIONS, "trending.direction", errors);
  checkEnum(cfg.kline?.resolution, VALID_RESOLUTIONS, "kline.resolution", errors);
  checkEnum(cfg.fiveMinute?.interval, VALID_INTERVALS, "fiveMinute.interval", errors);
  checkEnum(cfg.fiveMinute?.orderBy, VALID_ORDER_BY, "fiveMinute.orderBy", errors);
  checkEnum(cfg.fiveMinute?.source, ["rank", "kline", "hybrid"], "fiveMinute.source", errors);

  const limit = cfg.trending?.limit;
  if (limit != null && (!Number.isInteger(limit) || limit < 1 || limit > 100)) {
    errors.push(`trending.limit: must be an integer 1–100 (gmgn-cli caps it at 100), got ${limit}`);
  }

  // Range params — the important one. Unknown keys are silently ignored by the
  // API, so we refuse to run rather than let a typo disable a filter.
  const range = cfg.trending?.range ?? {};
  for (const [key, value] of Object.entries(range)) {
    const type = RANGE_PARAMS[key];
    const unset = value === null || value === undefined;

    // The key name is checked even when the value is null. A null is harmless
    // today (it is skipped when building argv), but leaving an unrecognized key
    // sitting in the file is a trap: the day someone gives it a real number it
    // becomes a silent no-op instead of an error.
    if (!type) {
      const owner = WRONG_COMMAND_PARAMS[key];
      const msg = owner
        ? `trending.range.${key}: that is a "${owner}" parameter, not "market trending" — it has no effect here.`
        : `trending.range.${key}: not a gmgn-cli parameter.${suggest(key, Object.keys(RANGE_PARAMS))}`;
      // null => inert, so warn. A real value => silently ignored, so fail.
      (unset ? warnings : errors).push(unset ? msg + " Currently null, so nothing is lost." : msg);
      continue;
    }
    if (unset) continue;   // explicit "disabled"
    if (type === "duration") {
      if (typeof value !== "string" || !DURATION_RE.test(value)) {
        errors.push(`trending.range.${key}: must be a duration string with an m/h/d suffix (e.g. "30m", "6h", "7d"). A bare number is rejected by the CLI. Got ${JSON.stringify(value)}`);
      }
      continue;
    }
    if (typeof value !== "number" || !Number.isFinite(value)) {
      errors.push(`trending.range.${key}: must be a number, got ${JSON.stringify(value)}`);
      continue;
    }
    if (type === "int" && !Number.isInteger(value)) {
      errors.push(`trending.range.${key}: must be an integer, got ${value}`);
    }
  }

  // Cross-check min <= max.
  for (const key of Object.keys(RANGE_PARAMS)) {
    if (!key.startsWith("min_")) continue;
    const maxKey = "max_" + key.slice(4);
    const lo = range[key], hi = range[maxKey];
    if (typeof lo === "number" && typeof hi === "number" && lo > hi) {
      errors.push(`trending.range: ${key} (${lo}) is greater than ${maxKey} (${hi}) — this can never match.`);
    }
  }

  // Filter tags: warn, don't fail. An unrecognized tag can silently empty the
  // result rather than erroring, so surfacing it matters, but the published
  // vocabulary is chain-specific and may lag the service.
  const tags = cfg.trending?.filters ?? [];
  if (!Array.isArray(tags)) {
    errors.push(`trending.filters: must be an array of strings`);
  } else {
    const known = EVM_CHAINS.has(cfg.chain) ? VALID_FILTER_TAGS.evm : VALID_FILTER_TAGS.sol;
    for (const t of tags) {
      if (!known.includes(t)) {
        warnings.push(`trending.filters: "${t}" is not a documented tag for chain "${cfg.chain}". An unrecognized tag can silently empty the result.${suggest(t, known)}`);
      }
    }
  }

  if (!Array.isArray(cfg.trending?.platforms)) {
    errors.push(`trending.platforms: must be an array of strings`);
  } else if (cfg.chain === "sol") {
    // Warn, don't fail: GMGN's docs lag the service (stonkfun works but is
    // undocumented). But a typo returns ZERO tokens with no error — verified
    // live with a made-up name — so it must be surfaced.
    for (const p of cfg.trending.platforms) {
      if (!SOL_PLATFORMS.includes(p)) {
        warnings.push(`trending.platforms: "${p}" is not a known Solana launchpad. An unrecognized name returns zero tokens with no error.${suggest(p, SOL_PLATFORMS)}`);
      }
    }
  }

  // Consistency between the server-side pump gate and the client-side one.
  const serverPump = range.min_price_change_percent;
  const clientPump = cfg.screen?.minPump1hPercent;
  if (typeof serverPump === "number" && typeof clientPump === "number" && cfg.trending?.interval === "1h" && serverPump > clientPump) {
    warnings.push(`trending.range.min_price_change_percent (${serverPump}) is stricter than screen.minPump1hPercent (${clientPump}); the server gate wins and the client one will never bind.`);
  }
  if (typeof serverPump === "number" && cfg.trending?.interval !== "1h") {
    warnings.push(`trending.range.min_price_change_percent applies to the QUERIED interval ("${cfg.trending?.interval}"), not 1h. At this interval it is not a 1h pump filter.`);
  }

  if (cfg.fiveMinute?.maxKlineCalls != null) {
    const n = cfg.fiveMinute.maxKlineCalls;
    if (!Number.isInteger(n) || n < 0) errors.push(`fiveMinute.maxKlineCalls: must be a non-negative integer, got ${n}`);
  }

  checkEnum(cfg.freshness?.resolution, VALID_RESOLUTIONS, "freshness.resolution", errors);
  for (const k of ["lookbackMin", "recentWindowMin", "maxKlineCalls"]) {
    const v = cfg.freshness?.[k];
    if (v != null && (typeof v !== "number" || !(v > 0))) {
      errors.push(`freshness.${k}: must be a positive number, got ${JSON.stringify(v)}`);
    }
  }
  if (cfg.freshness?.recentWindowMin != null && cfg.freshness?.lookbackMin != null &&
      cfg.freshness.recentWindowMin >= cfg.freshness.lookbackMin) {
    errors.push(`freshness.recentWindowMin (${cfg.freshness.recentWindowMin}) must be smaller than freshness.lookbackMin (${cfg.freshness.lookbackMin}).`);
  }
  for (const k of ["minRecentSharePercent", "maxOffHighPercent", "maxMoveAgeMin"]) {
    const v = cfg.freshness?.[k];
    if (v != null && (typeof v !== "number" || !Number.isFinite(v))) {
      errors.push(`freshness.${k}: must be a number or null, got ${JSON.stringify(v)}`);
    }
  }
  if (cfg.freshness?.enabled && cfg.freshness?.maxKlineCalls > 0) {
    const res = cfg.freshness.resolution, look = cfg.freshness.lookbackMin;
    const bars = look / ({ "30s": 0.5, "1m": 1, "5m": 5, "15m": 15, "1h": 60, "4h": 240, "1d": 1440 }[res] ?? 1);
    if (bars < 10) {
      warnings.push(`freshness: ${look}min at ${res} resolution is only ~${Math.round(bars)} candles — too coarse to locate when the move happened. Use a finer resolution or a longer lookback.`);
    }
  }

  const mv5 = cfg.screen?.minVol5m;
  if (mv5 != null) {
    if (typeof mv5 !== "number" || !Number.isFinite(mv5) || mv5 < 0) {
      errors.push(`screen.minVol5m: must be a non-negative number or null, got ${JSON.stringify(mv5)}`);
    } else if (cfg.fiveMinute?.enabled === false && cfg.freshness?.enabled === false) {
      warnings.push(`screen.minVol5m is set but both fiveMinute.enabled and freshness.enabled are false — vol5m is never populated, so no filtering will occur.`);
    }
  }

  const mv24 = cfg.screen?.minVolume24h;
  if (mv24 != null && (typeof mv24 !== "number" || !Number.isFinite(mv24) || mv24 < 0)) {
    errors.push(`screen.minVolume24h: must be a non-negative number or null, got ${JSON.stringify(mv24)}`);
  }
  if (mv24 == null && (cfg.output?.columns ?? []).includes("vol24h")) {
    warnings.push(`output.columns includes "vol24h" but screen.minVolume24h is null — the 24h query only runs when the floor is set, so that column will read — on every row.`);
  }

  // screen.showVerdicts — validated against the four verdict values plus
  // "unknown" (the fallback when the freshness call failed). Same
  // strict-validation rationale as elsewhere: a typo silently drops every
  // row instead of filtering nothing.
  if (cfg.screen?.showVerdicts != null) {
    if (!Array.isArray(cfg.screen.showVerdicts)) {
      errors.push(`screen.showVerdicts: must be an array or null.`);
    } else {
      const valid = ["live", "warm", "cooling", "stale", "unknown"];
      for (const v of cfg.screen.showVerdicts) {
        if (!valid.includes(v)) {
          errors.push(`screen.showVerdicts: "${v}" is not a verdict.${suggest(v, valid)} Valid: ${valid.join(", ")}`);
        }
      }
      if (cfg.screen.showVerdicts.length && cfg.freshness?.enabled === false) {
        warnings.push(`screen.showVerdicts is set but freshness.enabled is false — no verdict will ever be computed, so every row would be dropped. Enable freshness or clear showVerdicts.`);
      }
    }
  }

  // output.columns — validated against the registry the renderer exports, so a
  // typo surfaces instead of silently dropping a column you wanted.
  if (cfg.output?.columns !== undefined) {
    if (!Array.isArray(cfg.output.columns)) {
      errors.push(`output.columns: must be an array of column names.`);
    } else {
      for (const k of cfg.output.columns) {
        if (!VALID_COLUMNS.includes(k)) {
          errors.push(`output.columns: "${k}" is not a column.${suggest(k, VALID_COLUMNS)} Valid: ${VALID_COLUMNS.join(", ")}`);
        }
      }
    }
  }

  const ai = cfg.ai ?? {};
  if (ai.provider != null && !["auto", "openai", "anthropic"].includes(ai.provider)) {
    errors.push(`ai.provider: must be auto / openai / anthropic, got ${JSON.stringify(ai.provider)}`);
  }
  if (ai.reasoningEffort != null && !["low", "medium", "high", "xhigh", "max"].includes(ai.reasoningEffort)) {
    errors.push(`ai.reasoningEffort: must be low / medium / high / xhigh / max (or null), got ${JSON.stringify(ai.reasoningEffort)}`);
  }

  const tg = cfg.telegram ?? {};
  if (tg.enabled) {
    if (tg.parseMode != null && !["Markdown", "MarkdownV2", "HTML"].includes(tg.parseMode)) {
      errors.push(`telegram.parseMode: must be Markdown / MarkdownV2 / HTML (or null), got ${JSON.stringify(tg.parseMode)}`);
    }
    if (!Array.isArray(tg.chatIds)) {
      errors.push(`telegram.chatIds: must be an array (empty = fall back to ${tg.chatIdsEnvVar}).`);
    }
    if (tg.envFile && !fs.existsSync(resolveProjectPath(tg.envFile))) {
      warnings.push(`telegram.envFile "${tg.envFile}" does not exist — the token must then come from the real environment.`);
    }
    if (!Number.isFinite(tg.cooldownMin) || tg.cooldownMin < 0) {
      errors.push(`telegram.cooldownMin: must be a non-negative number (0 = disabled), got ${JSON.stringify(tg.cooldownMin)}`);
    }
    if (tg.cooldownMin > 0 && !tg.cooldownStateFile) {
      errors.push(`telegram.cooldownMin > 0 requires telegram.cooldownStateFile.`);
    }
    // Sharing one state file would make the two alert paths silence each other.
    if (tg.cooldownMin > 0 && cfg.newTokenAlerts?.stateFile &&
        resolveProjectPath(tg.cooldownStateFile) === resolveProjectPath(cfg.newTokenAlerts.stateFile)) {
      errors.push(`telegram.cooldownStateFile must differ from newTokenAlerts.stateFile — a shared file would let each alert path suppress the other.`);
    }
  }

  const cek = cfg.cek ?? {};
  if (cek.enabled) {
    checkEnum(cek.thesis, ["meme", "neutral", "utility"], "cek.thesis", errors);
    checkEnum(cek.chartInterval, ["1_MINUTE", "5_MINUTE", "15_MINUTE", "30_MINUTE", "1_HOUR", "4_HOUR"], "cek.chartInterval", errors);
    if (typeof cek.thesisExtra !== "string") errors.push(`cek.thesisExtra: must be a string, got ${JSON.stringify(cek.thesisExtra)}`);
    for (const [key, min, max, int] of [
      ["minFeePct", 0, 100, false], ["minTvlUsd", 0, 1e12, false], ["maxPools", 1, 10, true],
      ["topLpPools", 0, 5, true], ["roundTripSol", 0.001, 10, false], ["maxLossPct", 0.1, 100, false],
    ]) {
      const v = cek[key];
      if (!Number.isFinite(v) || v < min || v > max || (int && !Number.isInteger(v))) {
        errors.push(`cek.${key}: must be ${int ? "an integer" : "a number"} ${min}–${max}, got ${JSON.stringify(v)}`);
      }
    }
    if (typeof cek.chart !== "boolean") errors.push(`cek.chart: must be true or false, got ${JSON.stringify(cek.chart)}`);
    if (cek.envFile && !fs.existsSync(resolveProjectPath(cek.envFile))) {
      warnings.push(`cek.envFile "${cek.envFile}" does not exist — /cek then runs without an LLM verdict.`);
    }
  }

  const wi = cfg.watch?.intervalMs;
  if (wi != null && wi < 60_000) {
    warnings.push(`watch.intervalMs is ${wi}ms. The API escalates bans on repeated over-limit requests (up to 5 minutes); each pass costs 2 calls plus up to ${cfg.fiveMinute?.maxKlineCalls ?? 0} kline calls. Consider >= 60000.`);
  }

  const alert = cfg.newTokenAlerts ?? {};
  if (alert.enabled) {
    if (!cfg.telegram?.enabled) {
      errors.push(`newTokenAlerts.enabled requires telegram.enabled.`);
    }
    if (!Number.isInteger(alert.pollIntervalMs) || alert.pollIntervalMs < 60_000) {
      errors.push(`newTokenAlerts.pollIntervalMs: must be an integer >= 60000, got ${JSON.stringify(alert.pollIntervalMs)}`);
    }
    if (!Number.isFinite(alert.cooldownMin) || alert.cooldownMin < 0) {
      errors.push(`newTokenAlerts.cooldownMin: must be a non-negative number, got ${JSON.stringify(alert.cooldownMin)}`);
    }
    if (!Number.isFinite(alert.minVolume5mUsd) || alert.minVolume5mUsd < 0) {
      errors.push(`newTokenAlerts.minVolume5mUsd: must be a non-negative number, got ${JSON.stringify(alert.minVolume5mUsd)}`);
    }
    if (!Number.isInteger(alert.minTokenAgeMin) || alert.minTokenAgeMin < 0) {
      errors.push(`newTokenAlerts.minTokenAgeMin: must be a non-negative integer, got ${JSON.stringify(alert.minTokenAgeMin)}`);
    }
    if (!Number.isInteger(alert.maxTokenAgeMin) || alert.maxTokenAgeMin <= 0) {
      errors.push(`newTokenAlerts.maxTokenAgeMin: must be a positive integer, got ${JSON.stringify(alert.maxTokenAgeMin)}`);
    }
    if (Number.isInteger(alert.minTokenAgeMin) && Number.isInteger(alert.maxTokenAgeMin) && alert.minTokenAgeMin > alert.maxTokenAgeMin) {
      errors.push(`newTokenAlerts.minTokenAgeMin cannot exceed maxTokenAgeMin.`);
    }
    for (const key of ["minMarketCapUsd", "maxMarketCapUsd", "minLiquidityUsd"]) {
      const value = alert[key];
      if (value != null && (!Number.isFinite(value) || value < 0)) {
        errors.push(`newTokenAlerts.${key}: must be a non-negative number or null, got ${JSON.stringify(value)}`);
      }
    }
    if (alert.minMarketCapUsd != null && alert.maxMarketCapUsd != null && alert.minMarketCapUsd > alert.maxMarketCapUsd) {
      errors.push(`newTokenAlerts.minMarketCapUsd cannot exceed maxMarketCapUsd.`);
    }
    if (!Number.isInteger(alert.maxResults) || alert.maxResults < 1 || alert.maxResults > 100) {
      errors.push(`newTokenAlerts.maxResults: must be an integer 1–100, got ${JSON.stringify(alert.maxResults)}`);
    }
    if (typeof alert.stateFile !== "string" || !alert.stateFile.trim()) {
      errors.push(`newTokenAlerts.stateFile: must be a non-empty path.`);
    }
  }

  return { errors, warnings };
}

// ---------------------------------------------------------------------------
// ARGUMENT CONSTRUCTION
// ---------------------------------------------------------------------------

/** min_marketcap -> --min-marketcap */
export const apiFieldToFlag = (api) => `--${api.replace(/_/g, "-")}`;

/**
 * Build the `market trending` argv from config.
 * @param {object} cfg
 * @param {object} [o]
 * @param {string} [o.interval]  override the queried window
 * @param {string} [o.orderBy]
 * @param {boolean} [o.intervalScopedRanges] include interval-scoped range
 *        params (default true; the 5m enrichment pass sets this false)
 * @param {string} [o.direction]  override trending.direction
 * @param {number} [o.limit]      override trending.limit
 * @param {object} [o.extraRange] additional range params, {api_field: value}
 */
export function buildTrendingArgs(cfg, o = {}) {
  const interval = o.interval ?? cfg.trending.interval;
  const orderBy = o.orderBy ?? cfg.trending.orderBy;
  const includeScoped = o.intervalScopedRanges !== false;

  const args = [
    "market", "trending",
    "--chain", cfg.chain,
    "--interval", interval,
    "--order-by", orderBy,
    "--direction", o.direction ?? cfg.trending.direction,
    "--limit", String(o.limit ?? cfg.trending.limit),
    "--raw",
  ];

  for (const [key, value] of Object.entries(cfg.trending.range ?? {})) {
    if (value === null || value === undefined) continue;
    if (!includeScoped && INTERVAL_SCOPED_PARAMS.has(key)) continue;
    args.push(apiFieldToFlag(key), String(value));
  }

  // Extra range params for a derived query, e.g. the 24h volume floor.
  for (const [key, value] of Object.entries(o.extraRange ?? {})) {
    if (value !== null && value !== undefined) args.push(apiFieldToFlag(key), String(value));
  }

  for (const tag of cfg.trending.filters ?? []) args.push("--filter", tag);
  for (const p of cfg.trending.platforms ?? []) args.push("--platform", p);

  return args;
}

export function buildKlineArgs(cfg, address, o = {}) {
  const now = Math.floor(Date.now() / 1000);
  const resolution = o.resolution ?? cfg.kline.resolution;
  const lookbackSec = o.lookbackSec ?? cfg.kline.lookbackSec;
  return [
    "market", "kline",
    "--chain", cfg.chain,
    "--address", address,
    "--resolution", resolution,
    "--from", String(now - lookbackSec),
    "--to", String(now),
    "--raw",
  ];
}

// ---------------------------------------------------------------------------
// ENTRY POINT
// ---------------------------------------------------------------------------

export function loadConfig(configPath, { quiet = false } = {}) {
  let user = {};
  let resolved = null;

  if (configPath) {
    resolved = path.resolve(configPath);
    if (!fs.existsSync(resolved)) {
      throw new ConfigError(`Config file not found: ${resolved}`);
    }
  } else {
    // Anchored to this project, not cwd: rh-pump-screener sits next door with
    // its own config.json, and starting from the wrong directory must not
    // silently screen Solana with Robinhood settings.
    const fallback = resolveProjectPath("config.json");
    if (fs.existsSync(fallback)) resolved = fallback;
  }

  if (resolved) {
    let text;
    try {
      text = fs.readFileSync(resolved, "utf8");
    } catch (err) {
      throw new ConfigError(`Could not read ${resolved}: ${err.message}`);
    }
    try {
      user = JSON.parse(text);
    } catch (err) {
      throw new ConfigError(`${resolved} is not valid JSON: ${err.message}`);
    }
    if (!isPlainObject(user)) {
      throw new ConfigError(`${resolved} must contain a JSON object at the top level.`);
    }
  }

  const cfg = merge(DEFAULTS, user);
  cfg._source = resolved ?? "(built-in defaults)";

  // Anchor relative credential paths before anything tries to read them.
  if (cfg.telegram?.envFile) cfg.telegram.envFile = resolveProjectPath(cfg.telegram.envFile);
  if (cfg.ai?.envFile) cfg.ai.envFile = resolveProjectPath(cfg.ai.envFile);
  if (cfg.cek?.envFile) cfg.cek.envFile = resolveProjectPath(cfg.cek.envFile);
  if (cfg.newTokenAlerts?.stateFile) cfg.newTokenAlerts.stateFile = resolveProjectPath(cfg.newTokenAlerts.stateFile);
  if (cfg.telegram?.cooldownStateFile) cfg.telegram.cooldownStateFile = resolveProjectPath(cfg.telegram.cooldownStateFile);

  const { errors, warnings } = validate(cfg);
  if (!quiet) {
    for (const w of warnings) console.warn(`  [config warning] ${w}`);
  }
  if (errors.length) {
    throw new ConfigError(
      `Invalid config (${cfg._source}):\n` + errors.map((e) => `    - ${e}`).join("\n")
    );
  }
  return cfg;
}

export { ConfigError };
