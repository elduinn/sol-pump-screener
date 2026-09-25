/**
 * LP Agent open API (https://docs.lpagent.io) — LIVE open positions in a Meteora DLMM pool
 * (chain=SOL). Complements Meridian's /top-lp, which is a historical snapshot: this says who
 * is in the pool RIGHT NOW, how much of it they hold, whether they are in range and how their
 * positions are doing. Also the fallback when Meridian's LPAgent relay is down.
 *
 * Verified live 2026-09-25: GET /pools/{pool}/positions?chain=SOL&status=Open returns
 * {status, data: {positions[], pagination{totalCount}}}; each position carries owner,
 * currentValue (USD, string), inRange, pnl.percent, createdAt.
 *
 * Free tier = 5 requests/minute and the key is SHARED with rh-lp-bot and meridian-ev02, so
 * every call goes through a sliding window that trusts the server's own ratelimit headers,
 * and /cek backs off while fewer than RESERVE requests remain — the other bots keep theirs.
 */

const BASE = "https://api.lpagent.io/open-api/v1";
const RPM = 5;
const RESERVE = 1;   // leave this many requests per minute for the other bots on the key

const calls = [];    // timestamps of our requests (sliding 60s window)
const cache = new Map();
let server = null;   // { remaining, resetAt } from the last response headers
let lastFail = null;

/** Why LP Agent data is missing, if it failed/was skipped in the last minute, else null. */
export const lpagentIssue = () => (lastFail && Date.now() - lastFail.at < 60_000 ? lastFail.why : null);

function budgetLeft() {
  const now = Date.now();
  while (calls.length && now - calls[0] > 60_000) calls.shift();
  const local = RPM - calls.length;
  const srv = server && now < server.resetAt ? server.remaining : RPM;
  return Math.min(local, srv);
}

async function get(env, path, params, ttlMs) {
  if (!env.lpagentKey) return null;
  const u = new URL(BASE + path);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, String(v));
  const key = u.toString();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.v;
  if (budgetLeft() <= RESERVE) {
    lastFail = { at: Date.now(), why: "rate budget used (5/min, key shared with other bots)" };
    return hit?.v ?? null;
  }
  calls.push(Date.now());
  try {
    const r = await fetch(u, { headers: { "x-api-key": env.lpagentKey }, signal: AbortSignal.timeout(20_000) });
    const rem = Number(r.headers.get("ratelimit-remaining"));
    const reset = Number(r.headers.get("ratelimit-reset"));
    if (Number.isFinite(rem) && Number.isFinite(reset)) server = { remaining: rem, resetAt: Date.now() + reset * 1000 };
    if (r.status === 429) server = { remaining: 0, resetAt: Date.now() + (Number.isFinite(reset) ? reset : 60) * 1000 };
    const j = await r.json().catch(() => null);
    if (!r.ok || j?.status === "error") {
      lastFail = { at: Date.now(), why: r.status === 429 ? "rate limited" : `HTTP ${r.status}` };
      console.warn(`  [cek] lpagent ${path}: ${lastFail.why} ${String(j?.message ?? "").slice(0, 80)}`);
      return hit?.v ?? null;
    }
    cache.set(key, { at: Date.now(), v: j });
    return j;
  } catch (err) {
    lastFail = { at: Date.now(), why: "unreachable" };
    console.warn(`  [cek] lpagent ${path}: ${err.message.slice(0, 80)}`);
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

/**
 * Live LPs of one DLMM pool: the 20 biggest open positions (1 request, cached 60s), grouped
 * by owner. Shares are of the pool's TVL from Meteora. Null if disabled/unavailable/empty.
 */
export async function liveLps(env, pool, tvlUsd) {
  const j = await get(env, `/pools/${pool}/positions`,
    { chain: "SOL", status: "Open", order_by: "inputNative", sort_order: "desc", pageSize: 20 }, 60_000);
  const rows = Array.isArray(j?.data?.positions) ? j.data.positions : Array.isArray(j?.data) ? j.data : null;
  if (!rows?.length) return null;

  const byOwner = new Map();
  for (const r of rows) {
    const owner = String(r.owner ?? "");
    if (!owner) continue;
    byOwner.set(owner, (byOwner.get(owner) ?? 0) + n(r.currentValue));
  }
  const owners = [...byOwner.entries()].sort((a, b) => b[1] - a[1]);
  const share = (usd) => (tvlUsd > 0 ? Math.min(100, (usd / tvlUsd) * 100) : null);
  const newest = Math.max(...rows.map((r) => Date.parse(String(r.createdAt ?? ""))).filter(Number.isFinite));
  return {
    openCount: n(j?.data?.pagination?.totalCount) || rows.length,
    top1Owner: owners[0]?.[0] ?? null,
    top1Usd: owners[0]?.[1] ?? 0,
    top1Pct: owners.length ? share(owners[0][1]) : null,
    top2Pct: owners.length ? share(owners[0][1] + (owners[1]?.[1] ?? 0)) : null,
    inRangePct: (rows.filter((r) => r.inRange === true).length / rows.length) * 100,
    medianPnlPct: median(rows.map((r) => n(r.pnl?.percent))),
    newestOpenMs: Number.isFinite(newest) ? newest : null,
  };
}
