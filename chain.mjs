/**
 * Solana-specific token helpers, shared by the screener and the new-token alerts.
 */

/**
 * SPL mint addresses are base58: 32–44 chars, no 0 / O / I / l, and no 0x
 * prefix. Verified live: pump.fun mints look like
 * EJUG2BZeBcrX9Uqybc7fc6mE9tLwRAiAG7ZnSG5Jpump.
 */
const SOL_ADDR_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export const isTokenAddress = (a) => SOL_ADDR_RE.test(String(a ?? ""));

/**
 * Tokenized-equity detection.
 *
 * Solana's real tokenized-stock product is `xstocks` (Backed Finance), a
 * launchpad_platform value in gmgn-cli's sol vocabulary. None appeared in four
 * live 100-token samples on 2026-09-14 (platforms seen: Pump.fun, stonkfun,
 * meteora_virtual_curve, pool_meteora, jup_studio, letsbonk, pump_agent), so
 * this is a guard, not a measured filter.
 *
 * `stonkfun` is NOT stocks — it is a themed memecoin launchpad (STONK, GTA6,
 * ...) and ~40% of the sol trending feed. Do not add it here.
 */
const STOCK_PLATFORMS = new Set(["xstocks"]);

export function isTokenizedStock(t) {
  return STOCK_PLATFORMS.has(t.launchpad_platform);
}
