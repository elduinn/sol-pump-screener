/**
 * Agent Meridian API — the endpoints Meridian's own agent uses (meridian-ev02
 * tools/study.js, tools/chart-indicators.js):
 *   GET /top-lp/{pool}           top 20 LPers of a DLMM pool (LP Agent data, ~30 min snapshot)
 *   GET /study-top-lp/{pool}     winners/losers + suggested strategy/range style
 *   GET /chart-indicators/{mint} candles + RSI / Bollinger / Supertrend
 * (/okx/enrich answers {"deprecated": true} since 2026-09 — not used.)
 *
 * The default key is Meridian's PUBLIC key, shared by every install: expect 429s and
 * "LPAgent circuit open" 500s when their upstream is down. Everything is best-effort —
 * a failure returns null and the report says why.
 */

const cache = new Map();
let lastFail = null;

/** Why Meridian data is missing, if it failed in the last minute, else null. */
export const meridianIssue = () => (lastFail && Date.now() - lastFail.at < 60_000 ? lastFail.why : null);
const limited = () => lastFail?.why.startsWith("rate limit") && Date.now() - lastFail.at < 60_000;

async function get(env, path, ttlMs) {
  const url = env.meridianUrl + path;
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < ttlMs) return hit.v;
  if (limited()) return hit?.v ?? null;
  try {
    const r = await fetch(url, { headers: { "x-api-key": env.meridianKey }, signal: AbortSignal.timeout(20_000) });
    if (r.status === 429) {
      lastFail = { at: Date.now(), why: "rate limit (shared key)" };
      return hit?.v ?? null;
    }
    const j = await r.json().catch(() => null);
    if (!r.ok || !j) {
      lastFail = { at: Date.now(), why: String(j?.error ?? `HTTP ${r.status}`).slice(0, 60) };
      console.warn(`  [cek] meridian ${path.split("?")[0]}: ${lastFail.why}`);
      return hit?.v ?? null;
    }
    cache.set(url, { at: Date.now(), v: j });
    return j;
  } catch (err) {
    lastFail = { at: Date.now(), why: "unreachable" };
    console.warn(`  [cek] meridian ${path.split("?")[0]}: ${err.message.slice(0, 80)}`);
    return hit?.v ?? null;
  }
}

const n = (v) => (v == null || v === "" ? 0 : Number(v) || 0);
const median = (xs) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** Top-LPer study for ONE DLMM pool (2 requests, cached 10 min). Null if unavailable/empty. */
export async function topLpStudy(env, pool) {
  const [top, study] = await Promise.all([get(env, `/top-lp/${pool}`, 600_000), get(env, `/study-top-lp/${pool}`, 600_000)]);
  const rows = Array.isArray(top?.topLpers) ? top.topLpers : [];
  if (!rows.length) return null;
  const pnl = rows.map((r) => n(r.pnlPerInflowPct));
  const holds = (Array.isArray(top?.historicalOwners) ? top.historicalOwners : []).map((o) => n(o.avgHoldHours)).filter((h) => h > 0);
  const last = rows.map((r) => Date.parse(String(r.lastActivity ?? ""))).filter(Number.isFinite);
  const sg = study?.suggestedStyle;
  return {
    pool,
    lpers: rows.length,
    profitable: pnl.filter((p) => p > 0).length,
    medianPnlPct: median(pnl),
    medianFeePct: median(rows.map((r) => n(r.feePercent))),
    avgHoldHours: holds.length ? holds.reduce((a, b) => a + b, 0) / holds.length : null,
    lastActivityMs: last.length ? Math.max(...last) : null,
    suggested: sg?.strategy ? { strategy: String(sg.strategy), rangeStyle: String(sg.rangeStyle ?? "?") } : null,
  };
}

/** Latest indicator read for a mint (cached 2 min). Null if unavailable. */
export async function chartSignal(env, mint, interval, candles = 96) {
  const j = await get(env, `/chart-indicators/${mint}?interval=${encodeURIComponent(interval)}&candles=${candles}&rsiLength=2`, 120_000);
  const L = j?.latest;
  if (!L?.candle) return null;
  const close = n(L.candle.close);
  const bbU = n(L.bollinger?.upper);
  const bbL = n(L.bollinger?.lower);
  let bb = null;
  if (bbU > bbL && close > 0) {
    const pos = (close - bbL) / (bbU - bbL);   // 0 = lower band, 1 = upper band
    bb = pos > 1 ? "above upper" : pos >= 0.8 ? "near upper" : pos < 0 ? "below lower" : pos <= 0.2 ? "near lower" : "mid";
  }
  const cs = Array.isArray(j.candles) ? j.candles : [];
  const first = cs.length ? n(cs[0].open) : 0;
  const dir = String(L.supertrend?.direction ?? "");
  return {
    interval: String(j.interval ?? interval),
    rsi: L.rsi?.value != null ? n(L.rsi.value) : null,
    supertrend: dir === "bullish" || dir === "bearish" ? dir : null,
    bb,
    chgPct: first > 0 ? (close / first - 1) * 100 : null,
    windowHours: cs.length >= 2 ? (n(cs[cs.length - 1].time) - n(cs[0].time)) / 3600 : 0,
  };
}
