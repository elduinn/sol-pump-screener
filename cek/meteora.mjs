/**
 * Meteora DLMM pools for a token — Meteora's public data API, no key. One request gives
 * base fee, bin step, TVL, volume/fees per window and fee/TVL for every pool.
 *
 * Verified live 2026-09-25:
 *   - `sort_by=tvl:desc` works; `fees_24h:desc` is rejected. So pull the top 50 by TVL and
 *     rank client-side by 24h fees (what an LP actually earns).
 *   - `query` also matches token NAMES — keep only pools that hold the exact mint.
 *   - `fee_tvl_ratio` is already a PERCENT (fees 9.77 / TVL 20,422 -> 0.0478).
 */

const BASE = "https://dlmm.datapi.meteora.ag";
const TTL_MS = 30_000;
const cache = new Map();
const n = (v) => (v == null || v === "" ? 0 : Number(v) || 0);

/** @returns {Promise<{pools: object[], token: object|null}>} empty on failure */
export async function dlmmPools(mint) {
  const hit = cache.get(mint);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.v;
  const empty = { pools: [], token: null };
  let j;
  try {
    const r = await fetch(`${BASE}/pools?query=${encodeURIComponent(mint)}&sort_by=${encodeURIComponent("tvl:desc")}&page_size=50`,
      { signal: AbortSignal.timeout(12_000) });
    if (!r.ok) {
      console.warn(`  [cek] meteora HTTP ${r.status}`);
      return empty;
    }
    j = await r.json();
  } catch (err) {
    console.warn(`  [cek] meteora failed: ${err.message.slice(0, 80)}`);
    return empty;
  }

  let token = null;
  const pools = [];
  for (const p of Array.isArray(j?.data) ? j.data : []) {
    const x = p.token_x ?? {};
    const y = p.token_y ?? {};
    const isX = x.address === mint;
    if (!isX && y.address !== mint) continue;
    const tok = isX ? x : y;
    token ??= {
      symbol: String(tok.symbol ?? ""),
      name: String(tok.name ?? ""),
      priceUsd: n(tok.price),
      marketCap: n(tok.market_cap),
      holders: n(tok.holders),
    };
    pools.push({
      address: String(p.address),
      name: String(p.name ?? ""),
      binStep: n(p.pool_config?.bin_step),
      baseFeePct: n(p.pool_config?.base_fee_pct),
      tvlUsd: n(p.tvl),
      vol24h: n(p.volume?.["24h"]),
      vol1h: n(p.volume?.["1h"]),
      fees24h: n(p.fees?.["24h"]),
      feeTvl24hPct: n(p.fee_tvl_ratio?.["24h"]),
      createdAt: p.created_at ? n(p.created_at) : null,
      blacklisted: !!p.is_blacklisted,
    });
  }
  pools.sort((a, b) => b.fees24h - a.fees24h || b.vol24h - a.vol24h || b.tvlUsd - a.tvlUsd);
  const v = { pools, token };
  cache.set(mint, { at: Date.now(), v });
  return v;
}

export const meteoraPoolUrl = (address) => `https://app.meteora.ag/dlmm/${address}`;
