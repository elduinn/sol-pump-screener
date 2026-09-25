/**
 * Buy->sell round trip via Jupiter quotes (HTTP only — nothing is signed or sent). Quote
 * SOL->token, then token->SOL for exactly what the buy returned. The share of SOL that
 * comes back exposes route fees + price impact + any Token-2022 transfer fee. No sell route
 * at all = cannot be sold through any aggregated venue (honeypot-like).
 */

const WSOL = "So11111111111111111111111111111111111111112";

async function quote(env, inputMint, outputMint, amount) {
  const u = `${env.jupiterUrl}/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=300`;
  const r = await fetch(u, {
    headers: env.jupiterKey ? { "x-api-key": env.jupiterKey } : {},
    signal: AbortSignal.timeout(10_000),
  });
  const j = await r.json().catch(() => null);
  return r.ok && j?.outAmount ? j : null;
}

const via = (q) => [...new Set((q?.routePlan ?? []).map((s) => String(s?.swapInfo?.label ?? "?")))].join(" + ");

/** @returns {Promise<object|null>} null only on network failure; "no route" is ok=false */
export async function roundTrip(env, mint, solIn, maxLossPct) {
  const lamports = BigInt(Math.round(solIn * 1e9));
  const fail = (reason, buyVia = "-") => ({ solIn, backPct: 0, lossPct: 100, buyVia, sellVia: "-", ok: false, reason });
  try {
    const buy = await quote(env, WSOL, mint, lamports);
    if (!buy) return fail("no buy route");
    const sell = await quote(env, mint, WSOL, BigInt(buy.outAmount));
    if (!sell) return fail("NO SELL ROUTE — possible honeypot", via(buy));
    const backPct = Number((BigInt(sell.outAmount) * 1_000_000n) / lamports) / 10_000;
    const lossPct = 100 - backPct;
    const ok = lossPct <= maxLossPct;
    return {
      solIn, backPct, lossPct, buyVia: via(buy), sellVia: via(sell), ok,
      reason: ok ? "healthy" : `loses ~${lossPct.toFixed(1)}% (fees/impact/transfer tax)`,
    };
  } catch (err) {
    console.warn(`  [cek] jupiter failed: ${err.message.slice(0, 80)}`);
    return null;
  }
}
