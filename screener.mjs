#!/usr/bin/env node
/**
 * Solana — memecoin pump screener with 5-minute volume acceleration.
 * Ported from /root/rh-pump-screener (Robinhood Chain) on 2026-09-14. The
 * response shapes below were verified there and re-checked on live sol data:
 * same fields, same PERCENT units, same kline shape.
 *
 * Solana differences, verified live 2026-09-14:
 *   - Addresses are base58 mints, not 0x hex (see chain.mjs).
 *   - rug_ratio is a real signal here (median ~0.10, p90 ~0.25–0.46), so the
 *     risk gate actually filters. On Robinhood it was flat zero.
 *   - is_honeypot is 0 for every sol token; is_open_source / is_renounced are
 *     EVM-only. Sol applies server-side default filters (renounced mint,
 *     frozen) even when none are passed.
 *   - `stonkfun` is a memecoin launchpad, not tokenized stocks.
 *
 * All gmgn-cli parameters are configurable from JSON — see config.mjs for the
 * parameter tables (extracted from the CLI's own source) and config.json for
 * the active settings. Run `--list-params` to print the full surface.
 *
 * WHAT THIS DOES NOT DO
 *   It does not provide liquidity and it does not trade. gmgn-cli exposes no
 *   liquidity-provision surface; `token pool` is READ-ONLY pool info.
 *
 * VERIFIED FACTS (live calls, not assumptions)
 *   - `price_1h_change` DOES NOT EXIST. The field is `price_change_percent1h`.
 *   - Values are PERCENT, not ratio: on a 100-token sample the median 1h change
 *     was 8.85 and p95 was 140.07. `8.85` means +8.85%. No calibration needed.
 *   - `price_change_percent1h` is present on EVERY row regardless of --interval.
 *   - `price_change_percent` mirrors whatever --interval you queried, so at
 *     --interval 1h it is identical to price_change_percent1h (checked: exact
 *     equality across all 100 rows).
 *   - `--order-by change1h` is the sort key for that metric (spelling differs
 *     from the response field — the asymmetry is real).
 *   - `--min-price-change-percent` takes PERCENT despite the CLI help text
 *     saying "ratio". Proven: value 10 -> lowest returned 1h change 10.13;
 *     value 100 -> lowest 100.57. Server-side, so it screens the WHOLE chain.
 *   - `volume` is scoped to --interval. A 5m query never exceeded the 1h query
 *     for the same token across 63 overlapping tokens. There is no volume_5m.
 *   - `market kline` returns a bare {list:[...]}, `time` in MILLISECONDS,
 *     `volume` in USD and `amount` in token units, both as STRINGS.
 *   - `market trending` envelope is {code, data:{rank:[...]}}.
 *
 * USAGE
 *   node screener.mjs                      # single pass
 *   node screener.mjs --survey             # chain population stats
 *   node screener.mjs --watch              # poll continuously
 *   node screener.mjs --config other.json  # use a different config file
 *   node screener.mjs --print-config       # show effective config, then exit
 *   node screener.mjs --list-params        # every gmgn-cli param you can set
 *   node screener.mjs --json               # machine-readable output
 *   node screener.mjs --include-stocks     # keep tokenized equities in
 *   node screener.mjs --cek <mint>         # /cek LP verdict for one token (terminal)
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  sendTelegram, verifyBot, resolveTelegramCreds, listenTelegram, sendTyping, escapeHtml,
  sendHtml, editHtml, answerCallback,
} from "./telegram.mjs";
import { tokenVerdict, NotAMintError } from "./cek/verdict.mjs";
import { verdictHtml, verdictKeyboard, verdictText, gmgnUrl } from "./cek/render.mjs";
import { askLlm, resolveAiCreds, listModels } from "./ai.mjs";
import { AlertCooldownStore, screenNewTokenVolume } from "./new-token-alerts.mjs";
import { isTokenAddress, isTokenizedStock } from "./chain.mjs";
import {
  loadConfig, buildTrendingArgs, buildKlineArgs, ConfigError,
  RANGE_PARAMS, INTERVAL_SCOPED_PARAMS, VALID_CHAINS, VALID_INTERVALS,
  VALID_RESOLUTIONS, VALID_ORDER_BY, VALID_DIRECTIONS, VALID_FILTER_TAGS,
  apiFieldToFlag,
} from "./config.mjs";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// CLI INVOCATION
// ---------------------------------------------------------------------------

async function runCli(args, cfg) {
  let stdout, stderr;
  try {
    ({ stdout, stderr } = await execFileAsync(cfg.cli.bin, args, {
      timeout: cfg.cli.timeoutMs,
      maxBuffer: cfg.cli.maxBufferMB * 1024 * 1024,
    }));
  } catch (err) {
    if (err.code === "ENOENT") {
      throw new Error(`${cfg.cli.bin} not found on PATH. Install it: npm install -g gmgn-cli`);
    }
    const detail = (err.stderr || err.message || "").trim();
    if (/401|403/.test(detail)) {
      throw new Error(
        `Auth failed. Check GMGN_API_KEY in ~/.config/gmgn/.env.\n` +
        `The API is IPv4-only — test with: curl https://ipv6.icanhazip.com\n` +
        `CLI said: ${detail}`
      );
    }
    throw new Error(`${cfg.cli.bin} failed: ${detail}`);
  }

  if (stderr && stderr.trim()) console.warn(`  [notice] ${stderr.trim()}`);

  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(`Could not parse CLI output as JSON. First 300 chars:\n${stdout.slice(0, 300)}`);
  }

  // The envelope carries a status code even on HTTP 200.
  if (parsed && typeof parsed === "object" && "code" in parsed && parsed.code !== 0) {
    throw new Error(`API returned code ${parsed.code}: ${parsed.message ?? parsed.reason ?? "unknown"}`);
  }
  return parsed;
}

async function fetchTrending(cfg, opts = {}) {
  const parsed = await runCli(buildTrendingArgs(cfg, opts), cfg);
  const rank = parsed?.data?.rank ?? parsed?.rank;
  if (!Array.isArray(rank)) {
    throw new Error(`Expected an array at data.rank, got: ${JSON.stringify(parsed).slice(0, 300)}`);
  }
  return rank;
}

async function fetchNewTokenTrending(cfg) {
  const a = cfg.newTokenAlerts;
  const args = [
    "market", "trending",
    "--chain", cfg.chain,
    "--interval", "5m",
    "--order-by", "volume",
    "--direction", "desc",
    "--limit", "100",
    "--min-volume", String(a.minVolume5mUsd),
    "--min-created", `${a.minTokenAgeMin}m`,
    "--max-created", `${a.maxTokenAgeMin}m`,
    "--raw",
  ];
  if (a.minMarketCapUsd != null) args.push("--min-marketcap", String(a.minMarketCapUsd));
  if (a.maxMarketCapUsd != null) args.push("--max-marketcap", String(a.maxMarketCapUsd));
  if (a.minLiquidityUsd != null) args.push("--min-liquidity", String(a.minLiquidityUsd));
  for (const p of cfg.trending.platforms ?? []) args.push("--platform", p);
  const parsed = await runCli(args, cfg);
  const rank = parsed?.data?.rank ?? parsed?.rank;
  if (!Array.isArray(rank)) throw new Error(`Expected an array at data.rank`);
  return rank;
}

/** Last COMPLETE candle volume for one token, in USD. */
async function fetchKlineVolume(cfg, address) {
  const parsed = await runCli(buildKlineArgs(cfg, address), cfg);
  const list = parsed?.list ?? parsed?.data?.list;
  if (!Array.isArray(list) || list.length === 0) return null;

  // `time` is Unix MILLISECONDS (verified: 1787049300000). The final candle is
  // usually still forming, which understates volume — step back to the last
  // closed one. Candle width comes from the configured resolution.
  const widthMs = RESOLUTION_MS[cfg.kline.resolution] ?? 300_000;
  const nowMs = Date.now();
  const closed = list.filter((c) => toNumber(c.time) != null && toNumber(c.time) + widthMs <= nowMs);
  const candle = closed.length ? closed[closed.length - 1] : list[list.length - 1];

  // `volume` is USD, `amount` is token units. Both arrive as strings.
  return toNumber(candle.volume);
}

const RESOLUTION_MS = {
  "30s": 30_000, "1m": 60_000, "5m": 300_000, "15m": 900_000,
  "1h": 3_600_000, "4h": 14_400_000, "1d": 86_400_000,
};

// ---------------------------------------------------------------------------
// HELPERS
// ---------------------------------------------------------------------------

function toNumber(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function riskVerdict(token, risk) {
  const reasons = [];
  const rug = toNumber(token.rug_ratio);
  const top10 = toNumber(token.top_10_holder_rate);

  if (risk.rejectWashTrading && token.is_wash_trading === true) reasons.push("wash trading");
  if (risk.rejectHoneypot && toNumber(token.is_honeypot) === 1) reasons.push("honeypot");
  if (risk.maxRugRatio != null && rug !== null && rug > risk.maxRugRatio) reasons.push(`rug ${rug.toFixed(2)}`);
  if (risk.maxTop10HolderRate != null && top10 !== null && top10 > risk.maxTop10HolderRate) {
    reasons.push(`top10 ${(top10 * 100).toFixed(0)}%`);
  }
  return { pass: reasons.length === 0, reasons };
}

// ---------------------------------------------------------------------------
// FILTERING
// ---------------------------------------------------------------------------

function screen(rank, cfg) {
  const rows = [];
  const dropped = { noData: 0, notPumping: 0, risky: 0, stocks: 0, wrongPlatform: 0 };
  const minPump = cfg.screen.minPump1hPercent;
  // trending.platforms is applied server-side; this re-checks it so a service
  // that stops honoring --platform cannot quietly widen the screen.
  const platforms = cfg.trending.platforms?.length ? new Set(cfg.trending.platforms) : null;

  for (const t of rank) {
    if (platforms && !platforms.has(t.launchpad_platform)) { dropped.wrongPlatform++; continue; }
    if (cfg.screen.excludeTokenizedStocks && isTokenizedStock(t)) { dropped.stocks++; continue; }

    // Percent already — no unit conversion. Read the dedicated 1h field, never
    // price_change_percent, so this column stays a 1h window even if you point
    // trending.interval at something else.
    const pump = toNumber(t.price_change_percent1h);
    if (pump === null) { dropped.noData++; continue; }
    if (minPump != null && pump < minPump) { dropped.notPumping++; continue; }
    if (!riskVerdict(t, cfg.risk).pass) { dropped.risky++; continue; }

    rows.push({
      symbol: t.symbol ?? "?",
      name: t.name ?? "",
      address: t.address ?? "",
      price: toNumber(t.price),
      marketCap: toNumber(t.market_cap),
      volume: toNumber(t.volume),   // scoped to trending.interval
      vol5m: null,
      vol5mSource: null,
      rvol: null,
      liquidity: toNumber(t.liquidity),
      pump1h: pump,
      pump5m: toNumber(t.price_change_percent5m),
      swaps: toNumber(t.swaps),
      holders: toNumber(t.holder_count),
      smartMoney: toNumber(t.smart_degen_count) ?? 0,
      launchpad: t.launchpad_platform ?? "",
    });
  }

  rows.sort((a, b) => b.pump1h - a.pump1h);
  return { rows, dropped };
}

// ---------------------------------------------------------------------------
// 24H VOLUME FLOOR
// ---------------------------------------------------------------------------
// trending.range.min_volume is scoped to trending.interval (1h), so a 24h floor
// needs its own query. The trending endpoint takes no address list, so one
// `--interval 24h --min-volume <floor>` call returns every token over the floor
// at once and survivors are checked against it locally.
//
// Runs straight after screen(): skipped entirely when nothing survived, and
// anything it drops never costs a kline call further down the pipeline.

const TRENDING_PAGE_CAP = 100;

async function gateVolume24h(rows, cfg) {
  const floor = cfg.screen?.minVolume24h;
  if (floor == null || rows.length === 0) return 0;

  let rank;
  try {
    // Inherits the main query's non-volume gates (mcap, liquidity, age,
    // filters, platforms). Survivors already pass those, so this only narrows
    // the page — fewer tokens competing for its 100 slots.
    rank = await fetchTrending(cfg, {
      interval: "24h",
      orderBy: "volume",
      direction: "desc",
      limit: TRENDING_PAGE_CAP,
      intervalScopedRanges: false,   // drop the 1h-sized volume/swaps/change gates
      extraRange: { min_volume: floor },
    });
  } catch (err) {
    // Rate limits must reach watchLoop so it backs off. Anything else skips
    // the gate for this pass: an API error is not evidence of low volume.
    if (/rate limit|RATE_LIMIT|429/i.test(err.message)) throw err;
    console.warn(`  [vol24h] check skipped this pass — ${err.message}`);
    return 0;
  }

  const vol = new Map();
  for (const t of rank) {
    if (t.address) vol.set(String(t.address).toLowerCase(), toNumber(t.volume));
  }

  // A short page is the complete set, so absence proves the token is under the
  // floor. A full page may have cut qualifying tokens off, so absence proves
  // nothing — keep those survivors rather than drop real matches.
  const complete = rank.length < TRENDING_PAGE_CAP;
  if (!complete) {
    console.warn(`  [vol24h] ${TRENDING_PAGE_CAP}+ tokens are over ${usd(floor)} — page is full, so survivors missing from it are kept, not dropped.`);
  }

  let dropped = 0;
  for (let i = rows.length - 1; i >= 0; i--) {
    const key = String(rows[i].address).toLowerCase();
    if (vol.has(key)) {
      const v = vol.get(key);
      rows[i].vol24h = v;
      // Re-check client-side so a service that stops honoring --min-volume
      // cannot quietly widen the screen.
      if (v != null && v < floor) { rows.splice(i, 1); dropped++; }
    } else if (complete) {
      rows.splice(i, 1);
      dropped++;
    }
  }
  return dropped;
}

// ---------------------------------------------------------------------------
// SHORT-WINDOW VOLUME ENRICHMENT
// ---------------------------------------------------------------------------
// RVOL compares the last short window against the average same-sized slice of
// the primary window. Above 1.0 = running hotter than the window average.

const INTERVAL_MINUTES = { "1m": 1, "5m": 5, "1h": 60, "6h": 360, "24h": 1440 };

async function enrichShortVolume(rows, cfg) {
  if (!cfg.fiveMinute.enabled || rows.length === 0) return;
  const mode = cfg.fiveMinute.source;

  if (mode === "rank" || mode === "hybrid") {
    // Order by volume so the short-window page holds the highest-volume tokens,
    // maximizing overlap with our survivors (measured ~63%).
    // intervalScopedRanges:false drops min_volume / min_swaps /
    // min_price_change_percent, which are sized for the primary window.
    const rankShort = await fetchTrending(cfg, {
      interval: cfg.fiveMinute.interval,
      orderBy: cfg.fiveMinute.orderBy,
      intervalScopedRanges: false,
    });

    const byAddress = new Map();
    for (const t of rankShort) {
      if (t.address) byAddress.set(String(t.address).toLowerCase(), toNumber(t.volume));
    }
    for (const r of rows) {
      const v = byAddress.get(String(r.address).toLowerCase());
      if (v != null) { r.vol5m = v; r.vol5mSource = "rank"; }
    }
  }

  const needsKline = (mode === "kline" ? rows : rows.filter((r) => r.vol5m === null))
    .slice(0, cfg.fiveMinute.maxKlineCalls);

  for (const r of needsKline) {
    if (!isTokenAddress(r.address)) continue;
    try {
      const v = await fetchKlineVolume(cfg, r.address);
      if (v != null) { r.vol5m = v; r.vol5mSource = "kline"; }
    } catch {
      // One token's kline failing must not abort the pass.
    }
  }

  const primary = INTERVAL_MINUTES[cfg.trending.interval] ?? 60;
  const short = INTERVAL_MINUTES[cfg.fiveMinute.interval] ?? 5;
  const slices = primary / short;
  for (const r of rows) {
    if (r.vol5m != null && r.volume != null && r.volume > 0) {
      r.rvol = r.vol5m / (r.volume / slices);
    }
  }
}

// ---------------------------------------------------------------------------
// MOVE FRESHNESS — did the pump happen NOW, or earlier in the window?
// ---------------------------------------------------------------------------
// price_change_percent1h is point-to-point: price(now) vs price(1h ago). A
// token that spiked 50 minutes ago and has bled sideways since carries exactly
// the same +15% badge as one breaking out right now. Walking 1m candles tells
// them apart.
//
// Metrics, all derived from the same single kline call:
//   moveAgeMin  minutes since the MIDPOINT of the cumulative gain. Robust to a
//               single outlier bar in a way "time of biggest bar" is not.
//   offHighPct  how far below the window high the price sits now. Near zero
//               means still making highs.
//   recentShare share of the total move that landed in recentWindowMin.
//   recentVolShare  same idea for volume — confirms whether attention is still
//               on the token or the move is coasting on nothing.

const RESOLUTION_MIN = {
  "30s": 0.5, "1m": 1, "5m": 5, "15m": 15, "1h": 60, "4h": 240, "1d": 1440,
};

function analyzeCandles(list, cfg) {
  const bars = list
    .map((c) => ({ t: toNumber(c.time), o: toNumber(c.open), c: toNumber(c.close),
                   h: toNumber(c.high), v: toNumber(c.volume) }))
    .filter((b) => b.t !== null && b.c !== null && b.o !== null && b.o > 0)
    .sort((a, b) => a.t - b.t);
  if (bars.length < 5) return null;

  const nowMs = Date.now();
  const first = bars[0], last = bars[bars.length - 1];
  const totalPct = (last.c - first.o) / first.o * 100;

  // Midpoint of the cumulative gain: the bar by which half the up-move had
  // accrued. Only up-bars count, so chop does not drag the estimate around.
  const gains = bars.map((b) => Math.max(0, b.c - b.o));
  const sum = gains.reduce((a, b) => a + b, 0);
  let acc = 0, midIdx = bars.length - 1;
  if (sum > 0) {
    for (let i = 0; i < bars.length; i++) {
      acc += gains[i];
      if (acc >= sum / 2) { midIdx = i; break; }
    }
  }
  const moveAgeMin = (nowMs - bars[midIdx].t) / 60000;

  const hiBar = bars.reduce((m, b) => ((b.h ?? b.c) > (m.h ?? m.c) ? b : m), bars[0]);
  const hiPrice = hiBar.h ?? hiBar.c;
  const offHighPct = hiPrice > 0 ? (last.c - hiPrice) / hiPrice * 100 : 0;
  const highAgeMin = (nowMs - hiBar.t) / 60000;

  const cut = nowMs - cfg.freshness.recentWindowMin * 60000;
  const recent = bars.filter((b) => b.t >= cut);
  const recentPct = recent.length
    ? (recent[recent.length - 1].c - recent[0].o) / recent[0].o * 100
    : 0;
  const recentShare = totalPct > 0 ? Math.max(0, recentPct) / totalPct * 100 : 0;

  const volTotal = bars.reduce((a, b) => a + (b.v ?? 0), 0);
  const volRecent = recent.reduce((a, b) => a + (b.v ?? 0), 0);
  const recentVolShare = volTotal > 0 ? volRecent / volTotal * 100 : null;

  // Volume of the trailing complete short window, reusable as vol5m so we do
  // not pay for a second kline call.
  const shortMin = INTERVAL_MINUTES[cfg.fiveMinute.interval] ?? 5;
  const shortCut = nowMs - shortMin * 60000;
  const shortBars = bars.filter((b) => b.t >= shortCut);
  const shortVol = shortBars.length ? shortBars.reduce((a, b) => a + (b.v ?? 0), 0) : null;

  return { totalPct, moveAgeMin, offHighPct, highAgeMin, recentPct, recentShare,
           recentVolShare, shortVol, bars: bars.length };
}

function freshnessVerdict(f) {
  if (f === null) return "unknown";
  if (f.offHighPct > -3 && f.recentShare > 40) return "live";
  if (f.offHighPct > -10 && f.recentShare > 15) return "warm";
  if (f.highAgeMin > 30 && f.offHighPct < -15) return "stale";
  return "cooling";
}

async function enrichFreshness(rows, cfg) {
  if (!cfg.freshness?.enabled || rows.length === 0) return { dropped: 0 };

  const targets = rows.slice(0, cfg.freshness.maxKlineCalls);
  for (const r of targets) {
    if (!isTokenAddress(r.address)) continue;
    try {
      const parsed = await runCli(
        buildKlineArgs(cfg, r.address, {
          resolution: cfg.freshness.resolution,
          lookbackSec: Math.round(cfg.freshness.lookbackMin * 60),
        }), cfg);
      const list = parsed?.list ?? parsed?.data?.list;
      if (!Array.isArray(list)) continue;
      r.freshness = analyzeCandles(list, cfg);
      r.verdict = freshnessVerdict(r.freshness);
      // Free short-window volume, already paid for.
      if (r.vol5m === null && r.freshness?.shortVol != null) {
        r.vol5m = r.freshness.shortVol;
        r.vol5mSource = "kline1m";
      }
    } catch {
      // One token failing must not abort the pass.
    }
  }

  // Recompute RVOL for anything that just gained a volume figure.
  const primary = INTERVAL_MINUTES[cfg.trending.interval] ?? 60;
  const short = INTERVAL_MINUTES[cfg.fiveMinute.interval] ?? 5;
  for (const r of rows) {
    if (r.rvol === null && r.vol5m != null && r.volume > 0) {
      r.rvol = r.vol5m / (r.volume / (primary / short));
    }
  }

  // Optional gates.
  const g = cfg.freshness;
  let dropped = 0;
  if (g.minRecentSharePercent != null || g.maxOffHighPercent != null || g.maxMoveAgeMin != null) {
    for (let i = rows.length - 1; i >= 0; i--) {
      const f = rows[i].freshness;
      if (!f) continue;   // never drop on missing data
      const fail =
        (g.minRecentSharePercent != null && f.recentShare < g.minRecentSharePercent) ||
        (g.maxOffHighPercent != null && f.offHighPct < -Math.abs(g.maxOffHighPercent)) ||
        (g.maxMoveAgeMin != null && f.moveAgeMin > g.maxMoveAgeMin);
      if (fail) { rows.splice(i, 1); dropped++; }
    }
  }

  // vol5m floor. Runs BEFORE the verdict filter so the verdict counter only
  // reflects rows that had enough volume to be worth judging in the first
  // place. Tokens with a null vol5m (measurement failed) are kept — missing
  // data is not proof of low volume.
  const minV5 = cfg.screen?.minVol5m;
  let vol5mDropped = 0;
  if (typeof minV5 === "number" && minV5 > 0) {
    for (let i = rows.length - 1; i >= 0; i--) {
      const v = rows[i].vol5m;
      if (v != null && v < minV5) { rows.splice(i, 1); vol5mDropped++; }
    }
  }

  // Verdict allowlist. Runs after the freshness gates so its counter is
  // meaningful even when both are on. Tokens whose freshness call failed
  // carry verdict === "unknown" — include "unknown" in the list to keep them.
  const allowed = cfg.screen?.showVerdicts;
  let verdictDropped = 0;
  if (Array.isArray(allowed) && allowed.length) {
    const allow = new Set(allowed);
    for (let i = rows.length - 1; i >= 0; i--) {
      const v = rows[i].verdict ?? "unknown";
      if (!allow.has(v)) { rows.splice(i, 1); verdictDropped++; }
    }
  }
  return { dropped, verdictDropped, vol5mDropped };
}

// ---------------------------------------------------------------------------
// OUTPUT
// ---------------------------------------------------------------------------

const usd = (n) => {
  if (n === null || n === undefined) return "—";
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
};
const price = (n) => (n === null ? "—" : n < 0.01 ? `$${n.toExponential(2)}` : `$${n.toFixed(4)}`);
const pct = (n) => (n === null ? "—" : `${n >= 0 ? "+" : ""}${n.toFixed(1)}%`);
const rvolFmt = (n) => {
  if (n === null) return "—";
  const arrow = n >= 1.5 ? "▲" : n < 0.6 ? "▼" : "·";
  return `${n.toFixed(2)}${arrow}`;
};

// Column registry. `output.columns` in config picks which appear, and in what
// order. Every key here is valid; omit one and it simply is not drawn.
// NOTE: hiding a column does NOT save API calls — age/offHigh/when all come
// from the same single kline call, which is only skipped by disabling
// `freshness.enabled` entirely.
const COLUMNS = {
  symbol:      { head: () => "SYMBOL", w: 11, left: true, get: (r) => String(r.symbol).slice(0, 10) },
  price:       { head: () => "PRICE", w: 12, get: (r) => price(r.price) },
  mcap:        { head: () => "MCAP", w: 9, get: (r) => usd(r.marketCap) },
  volume:      { head: (c) => `VOL(${c.trending.interval})`, w: 10, get: (r) => usd(r.volume) },
  vol5m:       { head: (c) => `VOL(${c.fiveMinute.interval})`, w: 10, get: (r) => usd(r.vol5m) },
  vol24h:      { head: () => "VOL(24h)", w: 10, get: (r) => usd(r.vol24h) },
  rvol:        { head: () => "RVOL", w: 8, get: (r) => rvolFmt(r.rvol) },
  liquidity:   { head: () => "LIQ", w: 9, get: (r) => usd(r.liquidity) },
  pump1h:      { head: () => "1h", w: 9, get: (r) => pct(r.pump1h) },
  pump5m:      { head: () => "5m", w: 8, get: (r) => pct(r.pump5m) },
  swaps:       { head: () => "SWAPS", w: 8, get: (r) => (r.swaps == null ? "—" : String(r.swaps)) },
  holders:     { head: () => "HOLDERS", w: 9, get: (r) => (r.holders == null ? "—" : String(r.holders)) },
  smartMoney:  { head: () => "SM", w: 5, get: (r) => String(r.smartMoney) },
  age:         { head: () => "AGE", w: 7, get: (r) => (r.freshness ? `${r.freshness.moveAgeMin.toFixed(0)}m` : "—") },
  offHigh:     { head: () => "OFF-HI", w: 8, get: (r) => (r.freshness ? `${r.freshness.offHighPct.toFixed(1)}%` : "—") },
  recentShare: { head: () => "RECENT", w: 8, get: (r) => (r.freshness ? `${r.freshness.recentShare.toFixed(0)}%` : "—") },
  when:        { head: () => "WHEN", w: 9, left: true, get: (r) => r.verdict ?? "—" },
};

export const COLUMN_KEYS = Object.keys(COLUMNS);

const DEFAULT_COLUMNS = [
  "symbol", "price", "mcap", "volume", "vol5m", "rvol", "liquidity",
  "pump1h", "pump5m", "smartMoney", "age", "offHigh", "when",
];

function activeColumns(cfg) {
  const want = cfg.output?.columns ?? DEFAULT_COLUMNS;
  return want.filter((k) => COLUMNS[k]);
}

// Right-aligned columns carry their own leading space via padStart. A
// left-aligned column butts straight up against the previous value, so it gets
// an explicit gutter unless it is the first column.
const cell = (text, col, i) => {
  const t = String(text);
  return col.left ? (i === 0 ? "" : "  ") + t.padEnd(col.w) : t.padStart(col.w);
};

function render(rows, dropped, cfg) {
  const iv = cfg.trending.interval;
  const sv = cfg.fiveMinute.interval;
  const r = cfg.trending.range;

  console.log(
    `\n  ${cfg.chain} — ${cfg.screen.excludeTokenizedStocks ? "memecoins" : "all tokens"} ` +
    `pumping >= ${cfg.screen.minPump1hPercent}% (1h)  |  ` +
    `MC ${usd(r.min_marketcap)}–${r.max_marketcap ? usd(r.max_marketcap) : "∞"}  |  ` +
    `Vol(${iv}) >= ${usd(r.min_volume)}` +
    (cfg.trending.platforms?.length ? `  |  launchpad: ${cfg.trending.platforms.join(", ")}` : "")
  );
  console.log(`  ${new Date().toISOString()}   config: ${cfg._source}\n`);

  if (rows.length === 0) {
    console.log("  No tokens matched.");
  } else {
    const cols = activeColumns(cfg).map((k) => ({ key: k, ...COLUMNS[k] }));
    const head = "  " + cols.map((c, i) => cell(c.head(cfg), c, i)).join("");
    console.log(head);
    console.log("  " + "-".repeat(head.trimEnd().length - 2));

    for (const row of rows) {
      console.log("  " + cols.map((c, i) => cell(c.get(row), c, i)).join("").trimEnd());
    }

    const shown = new Set(activeColumns(cfg));
    console.log("");
    if (shown.has("rvol")) {
      console.log(`  RVOL = last ${sv} volume ÷ average ${sv} slice of the ${iv} window.`);
      console.log(`         ▲ >=1.5 accelerating   · normal   ▼ <0.6 cooling off`);
    }
    if (shown.has("age")) {
      console.log(`  AGE  = minutes since the midpoint of the gain (small = the move is happening now).`);
    }
    if (shown.has("offHigh")) {
      console.log(`  OFF-HI = distance below the ${cfg.freshness.lookbackMin}m high.`);
    }
    if (shown.has("recentShare")) {
      console.log(`  RECENT = share of the move that landed in the last ${cfg.freshness.recentWindowMin}m.`);
    }
    if (shown.has("when")) {
      console.log(`  WHEN = live / warm / cooling / stale — how recent the move is.`);
    }

    const gaps = rows.filter((x) => x.vol5m === null).length;
    if (gaps > 0) console.log(`  ${gaps} token(s) had no ${sv} volume available — shown as —.`);

    if (cfg.output.showAddresses) {
      console.log("\n  Addresses:");
      for (const row of rows) {
        console.log(`    ${String(row.symbol).padEnd(11)} ${row.address}  (${row.launchpad})`);
      }
    }
  }

  console.log(
    `\n  Filtered out — ${dropped.stocks} tokenized stocks, ${dropped.notPumping} not pumping, ` +
    `${dropped.risky} failed risk gate, ${dropped.noData} missing 1h data` +
    (dropped.stale ? `, ${dropped.stale} stale moves` : "") +
    (dropped.wrongVerdict ? `, ${dropped.wrongVerdict} outside showVerdicts` : "") +
    (dropped.lowVol5m ? `, ${dropped.lowVol5m} below vol5m floor` : "") +
    (dropped.lowVol24h ? `, ${dropped.lowVol24h} below 24h volume floor` : "") +
    (dropped.wrongPlatform ? `, ${dropped.wrongPlatform} other launchpads` : "") + `.`
  );
}

// ---------------------------------------------------------------------------
// TELEGRAM
// ---------------------------------------------------------------------------
// The table is fixed-width, so it only survives inside a code fence — Telegram
// renders that monospace and preserves the column alignment. Everything is
// built from the SAME column selection as the terminal view, so the two never
// drift apart.

// Addresses sit OUTSIDE the code block: each CA is inline <code>, which
// Telegram copies to the clipboard on tap. Telegram cannot put a button inside
// a line of text, so each token's ⚖️ Cek button sits under the message
// (cekKeyboard), in the same order as these lines.
function addressBlock(rows) {
  return {
    pre: false,
    lines: [
      "<b>Contract addresses</b>",
      ...rows.map((row) => {
        const symbol = `<b>${escapeHtml(String(row.symbol).replace(/[\r\n]/g, ""))}</b>`;
        const launchpad = row.launchpad ? ` · ${escapeHtml(row.launchpad)}` : "";
        return `${symbol}${launchpad} · <code>${escapeHtml(row.address)}</code> · <a href="${gmgnUrl(row.address)}">GMGN</a>`;
      }),
    ],
  };
}

// One ⚖️ Cek button per token, two per row. callback_data "cek:<mint>" is at
// most 48 bytes (Telegram's limit is 64). Pressing one needs the --listen /
// --serve loop running; under --watch alone the button just spins.
function cekKeyboard(rows, cfg) {
  if (!cfg.cek?.enabled || !rows.length || !cfg.telegram.includeAddresses) return undefined;
  const buttons = rows.map((row) => ({
    text: `⚖️ Cek ${String(row.symbol).replace(/[\r\n]/g, "").slice(0, 12)}`,
    callback_data: `cek:${row.address}`,
  }));
  const kb = [];
  for (let i = 0; i < buttons.length; i += 2) kb.push(buttons.slice(i, i + 2));
  return { inline_keyboard: kb };
}

function buildTelegramBlocks(rows, dropped, cfg) {
  const iv = cfg.trending.interval;
  const r = cfg.trending.range;
  const lines = [];

  lines.push(`${cfg.chain} - ${cfg.screen.excludeTokenizedStocks ? "memecoins" : "all tokens"} pumping >= ${cfg.screen.minPump1hPercent}% (1h)`);
  lines.push(`MC ${usd(r.min_marketcap)}-${r.max_marketcap ? usd(r.max_marketcap) : "inf"}  |  Vol(${iv}) >= ${usd(r.min_volume)}`);
  lines.push(new Date().toISOString().replace("T", " ").slice(0, 16) + " UTC");
  lines.push("");

  if (rows.length === 0) {
    lines.push("No tokens matched.");
  } else {
    const cols = activeColumns(cfg).map((k) => ({ key: k, ...COLUMNS[k] }));
    lines.push(cols.map((c, i) => cell(c.head(cfg), c, i)).join("").trimEnd());
    lines.push("-".repeat(Math.min(64, cols.reduce((a, c) => a + c.w, 0))));
    for (const row of rows) {
      lines.push(cols.map((c, i) => cell(c.get(row), c, i)).join("").trimEnd());
    }
  }

  lines.push("");
  lines.push(`filtered: ${dropped.stocks} stocks, ${dropped.notPumping} not pumping, ` +
             `${dropped.risky} risk, ${dropped.noData} no data` +
             (dropped.stale ? `, ${dropped.stale} stale` : "") +
             (dropped.wrongVerdict ? `, ${dropped.wrongVerdict} outside verdicts` : "") +
             (dropped.lowVol5m ? `, ${dropped.lowVol5m} low vol5m` : "") +
             (dropped.lowVol24h ? `, ${dropped.lowVol24h} low vol24h` : "") +
             (dropped.wrongPlatform ? `, ${dropped.wrongPlatform} other launchpads` : "") +
             (dropped.cooldown ? `, ${dropped.cooldown} in cooldown` : ""));

  const blocks = [{ pre: true, lines }];
  if (rows.length && cfg.telegram.includeAddresses) blocks.push(addressBlock(rows));
  return blocks;
}

// Repeat suppression for the main alert. The screener re-matches the same
// tokens pass after pass, so at watch.intervalMs = 300s the same three symbols
// would arrive 12 times an hour. The store is time-based only: a token that
// drops off the list and comes back still waits out its window, because the
// clock is keyed on last-alerted time and nothing clears it early.
//
// Built once and reused — the constructor reads the state file, and rebuilding
// it every pass would re-read it every pass for no gain.
let screenerCooldown = null;
function getScreenerCooldown(cfg) {
  if (screenerCooldown === null) {
    screenerCooldown = new AlertCooldownStore(cfg.telegram.cooldownStateFile, cfg.telegram.cooldownMin);
  }
  return screenerCooldown;
}

/**
 * @param {object} [opts]
 * @param {boolean} [opts.useCooldown] Suppress repeats. Only the watch loop
 *        sets this: a single manual pass must always show what it found, and
 *        must not advance a clock the watch loop depends on.
 */
async function deliverTelegram(rows, dropped, cfg, { useCooldown = false } = {}) {
  if (!cfg.telegram?.enabled) return;

  const cooling = useCooldown && (cfg.telegram.cooldownMin ?? 0) > 0;

  if (!cooling) {
    if (rows.length === 0 && !cfg.telegram.sendWhenEmpty) return;
    try {
      const res = await sendTelegram(cfg, null, {
        blocks: buildTelegramBlocks(rows, dropped, cfg),
        replyMarkup: cekKeyboard(rows, cfg),
      });
      if (res.skipped) {
        console.warn(`  [telegram] skipped: ${res.skipped}`);
        return;
      }
      const bad = res.results.filter((x) => !x.ok);
      if (bad.length === 0) {
        const chats = new Set(res.results.map((x) => x.chatId)).size;
        console.log(`  [telegram] sent to ${chats} chat(s)${res.chunks > 1 ? ` in ${res.chunks} parts` : ""}.`);
      } else {
        for (const b of bad) console.warn(`  [telegram] chat ${b.chatId} failed: ${b.error}`);
      }
    } catch (err) {
      // Delivery must never take down a screener pass.
      console.warn(`  [telegram] delivery error: ${err.message}`);
    }
    return;
  }

  // Cooldown is per chat, so the row set differs per recipient and each
  // message has to be built separately.
  try {
    const store = getScreenerCooldown(cfg);
    const { chatIds } = resolveTelegramCreds(cfg);
    if (!chatIds.length) {
      console.warn(`  [telegram] skipped: no chat ids`);
      return;
    }

    for (const chatId of chatIds) {
      const fresh = store.fresh(rows, cfg.chain, chatId);
      const suppressed = rows.length - fresh.length;
      if (fresh.length === 0) {
        if (suppressed > 0) console.log(`  [telegram] chat=${chatId} all ${suppressed} match(es) in cooldown — nothing sent.`);
        if (!cfg.telegram.sendWhenEmpty) continue;
      }

      const res = await sendTelegram(cfg, null, {
        blocks: buildTelegramBlocks(fresh, { ...dropped, cooldown: suppressed }, cfg),
        chatIds: [chatId],
        replyMarkup: cekKeyboard(fresh, cfg),
      });
      if (res.skipped) {
        console.warn(`  [telegram] chat=${chatId} skipped: ${res.skipped}`);
        continue;
      }
      const bad = (res.results ?? []).filter((x) => !x.ok);
      if (bad.length === 0) {
        // Only advance the clock on confirmed delivery, or a failed send would
        // silence the token for the whole window.
        store.mark(fresh, cfg.chain, chatId);
        console.log(`  [telegram] chat=${chatId} sent ${fresh.length} token(s)` +
                    `${suppressed ? `, ${suppressed} in cooldown` : ""}.`);
      } else {
        for (const b of bad) console.warn(`  [telegram] chat ${b.chatId} failed: ${b.error} — cooldown not advanced.`);
      }
    }
  } catch (err) {
    console.warn(`  [telegram] delivery error: ${err.message}`);
  }
}

function buildNewTokenAlertBlocks(rows, cfg) {
  const a = cfg.newTokenAlerts;
  const lines = [
    `🔥 NEW TOKENS — 5M VOLUME`,
    `${cfg.chain} · ${new Date().toISOString().replace("T", " ").slice(0, 16)} UTC`,
    "",
    "TOKEN        AGE    VOL(5M)      5M       MCAP        LIQ",
    "------------------------------------------------------------",
  ];
  for (const row of rows) {
    lines.push(
      `${row.symbol.padEnd(12)} ${`${Math.floor(row.ageMin)}m`.padStart(4)} ${usd(row.volume5m).padStart(10)} ` +
      `${pct(row.pump5m).padStart(8)} ${usd(row.marketCap).padStart(10)} ${usd(row.liquidity).padStart(10)}`
    );
  }
  lines.push("", `Trigger: 5m volume > ${usd(a.minVolume5mUsd)} · age ${a.minTokenAgeMin}–${a.maxTokenAgeMin}m`);
  return [{ pre: true, lines }, addressBlock(rows)];
}

async function newTokenAlertLoop(cfg) {
  const a = cfg.newTokenAlerts;
  const cooldown = new AlertCooldownStore(a.stateFile, a.cooldownMin);
  console.log(`  [new-token-alert] polling every ${a.pollIntervalMs / 1000}s · vol>${usd(a.minVolume5mUsd)} · age ${a.minTokenAgeMin}–${a.maxTokenAgeMin}m.`);
  for (;;) {
    let delay = a.pollIntervalMs;
    try {
      const rank = await fetchNewTokenTrending(cfg);
      const matches = screenNewTokenVolume(rank, cfg);
      const { chatIds } = resolveTelegramCreds(cfg);
      for (const chatId of chatIds) {
        const fresh = cooldown.fresh(matches, cfg.chain, chatId);
        if (!fresh.length) continue;
        const res = await sendTelegram(cfg, null, {
          blocks: buildNewTokenAlertBlocks(fresh, cfg),
          chatIds: [chatId],
          replyMarkup: cekKeyboard(fresh, cfg),
        });
        const sent = !res.skipped && (res.results ?? []).every((x) => x.ok);
        if (sent) {
          cooldown.mark(fresh, cfg.chain, chatId);
          console.log(`  [new-token-alert] chat=${chatId} sent ${fresh.length} new hit(s).`);
        } else {
          console.warn(`  [new-token-alert] chat=${chatId} delivery failed; cooldown not advanced.`);
        }
      }
    } catch (err) {
      console.error(`  [new-token-alert] error: ${err.message}`);
      if (/rate limit|RATE_LIMIT|429/i.test(err.message)) delay = a.rateLimitBackoffMs;
    }
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
}

function renderJson(rows, dropped, cfg) {
  console.log(JSON.stringify({
    generatedAt: new Date().toISOString(),
    config: cfg._source,
    chain: cfg.chain,
    interval: cfg.trending.interval,
    shortInterval: cfg.fiveMinute.interval,
    matched: rows.length,
    dropped,
    tokens: rows,
  }, null, 2));
}

// ---------------------------------------------------------------------------
// INTROSPECTION
// ---------------------------------------------------------------------------

function listParams() {
  console.log(`\n  Every gmgn-cli parameter you can set from JSON.`);
  console.log(`  Extracted from gmgn-cli v1.5.7 source — this is the complete surface.\n`);

  console.log(`  "chain":                 ${VALID_CHAINS.join(" / ")}`);
  console.log(`  "trending.interval":     ${VALID_INTERVALS.join(" / ")}`);
  console.log(`  "trending.direction":    ${VALID_DIRECTIONS.join(" / ")}`);
  console.log(`  "trending.limit":        integer 1–100`);
  console.log(`  "kline.resolution":      ${VALID_RESOLUTIONS.join(" / ")}`);
  console.log(`\n  "trending.orderBy":`);
  console.log(`    ${VALID_ORDER_BY.join(" / ")}`);
  console.log(`\n  "trending.filters" (array) — sol:`);
  console.log(`    ${VALID_FILTER_TAGS.sol.join(" / ")}`);

  console.log(`\n  "trending.range" — ${Object.keys(RANGE_PARAMS).length} server-side filters.`);
  console.log(`  Set to null to disable. § = tied to the queried interval, so it is`);
  console.log(`  automatically dropped from the short-window enrichment call.\n`);
  const keys = Object.keys(RANGE_PARAMS);
  const width = Math.max(...keys.map((k) => k.length));
  for (const k of keys) {
    const scoped = INTERVAL_SCOPED_PARAMS.has(k) ? " §" : "  ";
    console.log(`    ${k.padEnd(width)}${scoped}  ${RANGE_PARAMS[k].padEnd(9)} ${apiFieldToFlag(k)}`);
  }
  console.log(`\n  Units: *_rate / *_ratio are 0–1. min/max_created are duration`);
  console.log(`  strings with an m/h/d suffix ("30m", "6h", "7d") — a bare number is`);
  console.log(`  rejected. min/max_price_change_percent are PERCENT (10 = +10%),`);
  console.log(`  despite the CLI help text calling them a ratio.`);
  console.log(`\n  Unknown keys are a hard error here on purpose: the API silently`);
  console.log(`  ignores unrecognized range metrics, so a typo would quietly`);
  console.log(`  disable a filter instead of failing.\n`);
}

// ---------------------------------------------------------------------------
// SURVEY
// ---------------------------------------------------------------------------

async function survey(cfg) {
  console.log("\n  Surveying token population...\n");

  // Strip every range gate so this is the raw trending page.
  const wide = { ...cfg, trending: { ...cfg.trending, range: {} } };
  const rank = await fetchTrending(wide);

  const stocks = rank.filter(isTokenizedStock);
  const memes = rank.filter((t) => !isTokenizedStock(t));

  console.log(`  Tokens on the page:  ${rank.length}  (page size is capped at trending.limit = ${cfg.trending.limit})`);
  console.log(`    memecoins:         ${memes.length}`);
  console.log(`    tokenized stocks:  ${stocks.length}${stocks.length ? "  e.g. " + stocks.slice(0, 5).map((t) => t.symbol).join(", ") : ""}`);
  console.log(
    `\n  Note: comparing page LENGTHS across filter sets tells you nothing —\n` +
    `  every variant saturates at trending.limit. Verified directly: the lenient\n` +
    `  and strict filter sets returned byte-identical address sets on this chain.`
  );

  const changes = memes.map((t) => toNumber(t.price_change_percent1h)).filter((v) => v !== null);
  if (changes.length === 0) {
    console.log("\n  No 1h change data available.");
    return;
  }

  console.log(`\n  1h price change distribution — memecoins only (${changes.length} tokens, unit=percent):`);
  for (const th of [0, 2, 5, 10, 20, 50]) {
    const n = changes.filter((c) => c >= th).length;
    console.log(`    >= +${String(th).padStart(2)}%  ${String(n).padStart(4)}  ${"█".repeat(Math.round(40 * n / changes.length))}`);
  }

  const q = (arr, p) => {
    const v = arr.filter(Number.isFinite).sort((a, b) => a - b);
    return v.length ? v[Math.floor(v.length * p)] : null;
  };
  console.log(`\n  Memecoin population percentiles (use these to set trending.range):`);
  for (const [label, key] of [["market cap", "market_cap"], [`volume(${cfg.trending.interval})`, "volume"], ["liquidity", "liquidity"]]) {
    const v = memes.map((t) => toNumber(t[key])).filter((x) => x !== null);
    console.log(`    ${label.padEnd(14)} p25 ${usd(q(v, .25)).padStart(9)}   median ${usd(q(v, .5)).padStart(9)}   p75 ${usd(q(v, .75)).padStart(9)}   p90 ${usd(q(v, .9)).padStart(9)}`);
  }

  console.log(`\n  Biggest 1h movers (memecoins):`);
  for (const t of memes
    .map((x) => ({ s: x.symbol ?? "?", c: toNumber(x.price_change_percent1h), m: toNumber(x.market_cap) }))
    .filter((x) => x.c !== null).sort((a, b) => b.c - a.c).slice(0, 8)) {
    console.log(`    ${String(t.s).slice(0, 14).padEnd(15)} ${pct(t.c).padStart(11)}   ${usd(t.m).padStart(9)}`);
  }

  const passing = changes.filter((c) => c >= cfg.screen.minPump1hPercent).length;
  console.log(`\n  At screen.minPump1hPercent (+${cfg.screen.minPump1hPercent}%): ${passing} memecoin(s) before range and risk gates.`);
  console.log("");
}

// ---------------------------------------------------------------------------
// MAIN
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// LOOPS
// ---------------------------------------------------------------------------
// Both loops run forever and spend almost all their time awaiting I/O, so a
// single process runs them concurrently via Promise.all — one process to keep
// alive, one log to read.

async function watchLoop(cfg) {
  const cd = cfg.telegram?.enabled ? (cfg.telegram.cooldownMin ?? 0) : 0;
  console.log(`  [watch] polling every ${cfg.watch.intervalMs / 1000}s` +
              `${cd > 0 ? ` · repeat alerts suppressed for ${cd}m per token` : ""}.`);
  for (;;) {
    try {
      await runOnce(cfg, { useCooldown: true });
    } catch (err) {
      console.error(`  [watch] error: ${err.message}`);
      if (/rate limit|RATE_LIMIT|429/i.test(err.message)) {
        // Bans escalate on repeated over-limit requests, so back off hard.
        console.error(`  [watch] rate limited — backing off ${cfg.watch.rateLimitBackoffMs / 1000}s.`);
        await new Promise((r) => setTimeout(r, cfg.watch.rateLimitBackoffMs));
      }
    }
    await new Promise((r) => setTimeout(r, cfg.watch.intervalMs));
  }
}

// Two presses of the same mint in the same chat share one run instead of
// spending GMGN / Meridian / LLM quota twice.
const cekInFlight = new Set();

/** /cek <mint> or a ⚖️ Cek button: post "checking…", then edit it into the verdict. */
async function runCek(cfg, chatId, mint, replyTo) {
  const key = `${chatId}:${mint}`;
  if (cekInFlight.has(key)) return;
  cekInFlight.add(key);
  try {
    const mid = await sendHtml(cfg, chatId,
      `⚖️ <b>Verdict</b> <code>${escapeHtml(mint)}</code>\n<i>GMGN + mint check + DLMM pools + top LPs + round trip + LLM… (~10-30s)</i>`,
      { replyTo });
    let html, replyMarkup;
    try {
      const v = await tokenVerdict(cfg, mint);
      html = verdictHtml(v, cfg);
      replyMarkup = verdictKeyboard(v);
    } catch (err) {
      if (!(err instanceof NotAMintError)) console.error(`  [cek] ${mint} failed: ${err.message}`);
      html = `❌ Verdict failed: ${escapeHtml(err.message.slice(0, 160))}`;
    }
    if (mid) await editHtml(cfg, chatId, mid, html, { replyMarkup });
    else await sendHtml(cfg, chatId, html, { replyMarkup });
  } finally {
    cekInFlight.delete(key);
  }
}

/** A mint on its own runs the configured promptTemplate (origin story / narrative). */
async function runStory(cfg, chatId, addr) {
  const prompt = (cfg.ai.promptTemplate ?? "").replaceAll("{address}", addr);
  await sendTelegram(cfg, `Analyzing ${addr}...`, { parseMode: null, chatIds: [chatId] });
  await sendTyping(cfg, chatId);
  await replyWithLlm(cfg, chatId, prompt);
}

async function replyWithLlm(cfg, chatId, prompt) {
  let reply;
  try {
    reply = (await askLlm(cfg, prompt)).text;
  } catch (err) {
    reply = `Error: ${err.message}`;
  }
  // Plain text: model output routinely contains Markdown that Telegram
  // would reject with a 400.
  await sendTelegram(cfg, reply, { parseMode: null, chatIds: [chatId] });
}

async function listenLoop(cfg) {
  const who = await verifyBot(cfg);
  if (!who.ok) throw new Error(`telegram: ${who.error}`);
  const { model } = resolveAiCreds(cfg);
  console.log(`  [listen] @${who.username} ready — messages become prompts for ${model}` +
              `${cfg.cek?.enabled ? "; /cek <mint> and ⚖️ Cek buttons on" : ""}.`);

  const onCallback = async ({ id, chatId, data, messageId, name }) => {
    const [kind, mint] = data.split(":");
    if (!isTokenAddress(mint) || !["cek", "story"].includes(kind)) {
      await answerCallback(cfg, id);
      return;
    }
    const stamp = new Date().toISOString().slice(11, 19);
    console.log(`  [listen] ${stamp} ${name}: [${kind} button] ${mint}`);
    if (kind === "cek") {
      await answerCallback(cfg, id, "⚖️ Checking…");
      await runCek(cfg, chatId, mint, messageId);
    } else {
      await answerCallback(cfg, id, "📖 Writing the story…");
      await runStory(cfg, chatId, mint);
    }
  };

  await listenTelegram(cfg, async ({ chatId, text, name }) => {
    const stamp = new Date().toISOString().slice(11, 19);

    // /cek <mint> (also "/cek@BotName <mint>"). Not awaited: the listener
    // handles messages one at a time and a verdict takes 10-30s.
    const cek = text.match(/^\/cek(?:@\w+)?(?:\s+(\S+))?/i);
    if (cek) {
      const mint = cek[1] ?? "";
      if (!cfg.cek?.enabled) {
        await sendTelegram(cfg, "/cek is disabled (cek.enabled = false in config.json).", { parseMode: null, chatIds: [chatId] });
      } else if (!isTokenAddress(mint)) {
        await sendTelegram(cfg, "Usage: /cek <mint address>", { parseMode: null, chatIds: [chatId] });
      } else {
        console.log(`  [listen] ${stamp} ${name}: /cek ${mint}`);
        runCek(cfg, chatId, mint).catch((err) => console.error(`  [cek] ${err.message}`));
      }
      return;
    }

    // Let people type "/ask …" out of habit; a bare message works too.
    const body = text.replace(/^\/(ask|prompt|explain)\s*/i, "").trim();
    if (!body) return;

    // A message that is just a Solana mint address runs the configured
    // promptTemplate. Anything else is passed through as a raw prompt.
    if (isTokenAddress(body)) {
      console.log(`  [listen] ${stamp} ${name}: template <- ${body}`);
      await runStory(cfg, chatId, body);
      return;
    }
    console.log(`  [listen] ${stamp} ${name}: ${body.slice(0, 60)}`);
    await sendTyping(cfg, chatId);
    await replyWithLlm(cfg, chatId, body);
  }, { onCallback: cfg.cek?.enabled ? onCallback : undefined });
}

async function runOnce(cfg, { useCooldown = false } = {}) {
  const rank = await fetchTrending(cfg);
  const { rows, dropped } = screen(rank, cfg);
  dropped.lowVol24h = await gateVolume24h(rows, cfg);   // before any kline call
  await enrichShortVolume(rows, cfg);   // survivors only — keeps call count small
  const fresh = await enrichFreshness(rows, cfg);
  dropped.stale = fresh.dropped;
  dropped.wrongVerdict = fresh.verdictDropped;
  dropped.lowVol5m = fresh.vol5mDropped;
  // The terminal always shows every match; only the alert is suppressed.
  (cfg.output.json ? renderJson : render)(rows, dropped, cfg);
  await deliverTelegram(rows, dropped, cfg, { useCooldown });
  return rows;
}

function argValue(args, name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main() {
  const args = process.argv.slice(2);

  if (args.includes("--list-params")) return void listParams();

  let cfg;
  try {
    cfg = loadConfig(argValue(args, "--config"));
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`\n  [config error] ${err.message}\n`);
      process.exit(2);
    }
    throw err;
  }

  // Command-line overrides win over the JSON file.
  if (args.includes("--include-stocks")) cfg.screen.excludeTokenizedStocks = false;
  if (args.includes("--json")) cfg.output.json = true;

  if (args.includes("--ai-test")) {
    const { baseUrl, apiKey, model, source, provider } = resolveAiCreds(cfg);
    console.log(`\n  env file : ${source ?? "(none)"}`);
    console.log(`  provider : ${provider}${provider === "anthropic" && cfg.ai.webSearch ? "  (web search on)" : ""}`);
    console.log(`  baseUrl  : ${baseUrl}`);
    console.log(`  model    : ${model}`);
    console.log(`  api key  : ${apiKey ? apiKey.slice(0, 6) + "\u2026 (" + apiKey.length + " chars)" : "MISSING"}`);
    if (!apiKey) {
      console.error(`\n  Set LLM_API_KEY in ${source}.\n`);
      process.exit(1);
    }

    // Listing models is free and proves the key + base URL before spending
    // anything on a completion. Works on both provider shapes.
    try {
      const ids = await listModels(cfg);
      const claude = ids.filter((x) => /claude|flash|gpt|deepseek/i.test(x));
      console.log(`\n  ${ids.length} models available:`);
      for (const f of claude.slice(0, 12)) console.log(`    ${f}${f === model ? "   <- configured" : ""}`);
      if (!ids.includes(model)) {
        console.warn(`\n  ! "${model}" is not in the list. Set LLM_MODEL to one of the above.`);
      }
    } catch (err) {
      console.error(`\n  [error] could not list models: ${err.message}\n`);
      process.exit(1);
    }

    if (args.includes("--send")) {
      const t = Date.now();
      try {
        const r = await askLlm(cfg, "Reply with exactly: ok");
        console.log(`\n  completion: "${r.text.trim().slice(0, 40)}" in ${((Date.now() - t) / 1000).toFixed(1)}s`);
      } catch (err) {
        console.error(`\n  [error] ${err.message}`);
        process.exit(1);
      }
    } else {
      console.log(`\n  Add --send to also run a real completion.`);
    }
    console.log("");
    return;
  }

  if (args.includes("--telegram-test")) {
    const { token, chatIds, source } = resolveTelegramCreds(cfg);
    console.log(`\n  env file : ${source ?? "(none)"}`);
    console.log(`  token    : ${token ? token.slice(0, 8) + "…" + " (" + token.length + " chars)" : "MISSING"}`);
    console.log(`  chat ids : ${chatIds.length ? chatIds.join(", ") : "MISSING"}`);
    const who = await verifyBot(cfg);
    console.log(who.ok ? `  bot      : @${who.username} (id ${who.id})` : `  bot      : FAILED — ${who.error}`);
    if (who.ok && args.includes("--send")) {
      const res = await sendTelegram(cfg, "sol-pump-screener: test message", {});
      console.log("  send     : " + JSON.stringify(res.results ?? res.skipped));
    } else if (who.ok) {
      console.log(`\n  Credentials look good. Add --send to actually post a test message.`);
    }
    console.log("");
    return;
  }

  if (args.includes("--explain")) {
    const target = argValue(args, "--explain");
    if (!target) {
      console.error("\n  [error] --explain needs a token address.\n");
      process.exit(1);
    }

    const prompt = (cfg.ai.promptTemplate ?? "").replaceAll("{address}", target);
    console.log(`\n  asking ${resolveAiCreds(cfg).model}...`);

    let answer;
    try {
      answer = await askLlm(cfg, prompt);
    } catch (err) {
      console.error(`\n  [ai error] ${err.message}\n`);
      process.exit(1);
    }

    // Plain text, no fence: this is prose, and model output can contain
    // unbalanced Markdown that Telegram would reject with a 400.
    const res = await sendTelegram(cfg, `${target}\n\n${answer.text}`, { parseMode: null });
    if (res.skipped) {
      console.warn(`  [telegram] skipped: ${res.skipped}`);
      console.log("\n" + answer.text + "\n");
    } else {
      const bad = (res.results ?? []).filter((x) => !x.ok);
      if (bad.length) for (const b of bad) console.error(`  [telegram] chat ${b.chatId} failed: ${b.error}`);
      else console.log(`  [telegram] sent to ${new Set(res.results.map((x) => x.chatId)).size} chat(s).\n`);
    }
    return;
  }

  if (args.includes("--cek")) {
    const mint = argValue(args, "--cek");
    if (!isTokenAddress(mint)) {
      console.error("\n  [error] --cek needs a Solana mint address.\n");
      process.exit(1);
    }
    try {
      const v = await tokenVerdict(cfg, mint);
      console.log("\n" + (args.includes("--json") ? JSON.stringify(v, null, 2) : verdictText(v, cfg)) + "\n");
    } catch (err) {
      console.error(`\n  [error] ${err.message}\n`);
      process.exit(1);
    }
    return;
  }

  if (args.includes("--print-config")) {
    const { _source, ...rest } = cfg;
    console.log(`// effective config (source: ${_source})`);
    console.log(JSON.stringify(rest, null, 2));
    return;
  }

  try {
    if (args.includes("--survey")) return void (await survey(cfg));

    // Default (`npm start`) runs BOTH loops in one process. Either flag alone
    // narrows it to just that loop.
    const wantWatch = args.includes("--watch") || args.includes("--serve");
    const wantListen = args.includes("--listen") || args.includes("--serve");

    if (wantWatch || wantListen) {
      const loops = [];
      if (wantWatch) loops.push(watchLoop(cfg));
      if (wantWatch && cfg.newTokenAlerts?.enabled) loops.push(newTokenAlertLoop(cfg));
      if (wantListen) loops.push(listenLoop(cfg));
      console.log("  Ctrl-C to stop.\n");
      // If either loop throws, the process exits rather than limping along
      // half-dead and looking fine. A supervisor (pm2) restarts it.
      await Promise.all(loops);
      return;
    }

    await runOnce(cfg);
  } catch (err) {
    console.error(`\n  [error] ${err.message}\n`);
    process.exit(1);
  }
}

main();
