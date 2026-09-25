/**
 * GMGN detail for ONE token: `token info` + `token security`, flattened. Uses the same
 * gmgn-cli binary as the screener (cfg.cli.bin). Best-effort: null on any failure.
 *
 * Solana addresses are base58 and CASE-SENSITIVE — never lowercase them.
 * Field names verified live 2026-09-25 (chain sol, WIF): security carries
 * renounced_mint / renounced_freeze_account; is_honeypot is null on sol.
 */

import { execFile } from "node:child_process";

function run(cfg, args) {
  return new Promise((resolve) => {
    execFile(cfg.cli.bin, [...args, "--raw"], { timeout: 15_000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      if (err) return resolve(null);
      try {
        resolve(JSON.parse(stdout.trim()));
      } catch {
        resolve(null);
      }
    });
  });
}

const n = (v) => (v == null || v === "" ? 0 : Number(v) || 0);
const b = (v) => (v == null ? null : v === true || v === 1 || v === "1");

export async function gmgnToken(cfg, mint) {
  const [info, sec] = await Promise.all([
    run(cfg, ["token", "info", "--chain", "sol", "--address", mint]),
    run(cfg, ["token", "security", "--chain", "sol", "--address", mint]),
  ]);
  if (!info?.address) return null;
  const pr = info.price ?? {};
  const st = info.stat ?? {};
  const tags = info.wallet_tags_stat ?? {};
  const link = info.link ?? {};
  const dev = info.dev ?? {};
  const price = n(pr.price);
  const supply = n(info.circulating_supply) || n(info.total_supply);
  const chg = (past) => (n(past) > 0 ? (price / n(past) - 1) * 100 : 0);
  return {
    address: String(info.address),
    name: String(info.name ?? ""),
    symbol: String(info.symbol ?? ""),
    priceUsd: price,
    change1hPct: chg(pr.price_1h),
    change6hPct: chg(pr.price_6h),
    change24hPct: chg(pr.price_24h),
    volume24h: n(pr.volume_24h),
    volume1h: n(pr.volume_1h),
    buys24h: n(pr.buys_24h),
    sells24h: n(pr.sells_24h),
    liquidity: n(info.liquidity),
    marketCap: price * supply,
    athMarketCap: n(info.ath_price) * supply,
    holders: n(info.holder_count ?? st.holder_count),
    top10Rate: n(st.top_10_holder_rate ?? sec?.top_10_holder_rate),
    launchpad: String(info.launchpad ?? ""),
    launchpadProgress: n(info.launchpad_progress),
    twitter: String(link.twitter_username ?? ""),
    website: String(link.website ?? ""),
    telegram: String(link.telegram ?? ""),
    twitterChanged: Array.isArray(dev.twitter_name_change_history) && dev.twitter_name_change_history.length > 0,
    ctoFlag: !!n(dev.cto_flag),
    isOg: !!info.og,
    smartWallets: n(tags.smart_wallets),
    kolWallets: n(tags.renowned_wallets),
    bundlerWallets: n(tags.bundler_wallets),
    ratTraderWallets: n(tags.rat_trader_wallets),
    botDegenRate: n(st.bot_degen_rate),
    freshWalletRate: n(st.fresh_wallet_rate),
    bundlerRate: n(st.top_bundler_trader_percentage),
    devHoldRate: n(st.dev_team_hold_rate),
    sniperHoldRate: n(st.top70_sniper_hold_rate),
    creatorCreatedCount: n(st.creator_created_count),
    creatorTokenStatus: String(dev.creator_token_status ?? ""),
    imageDupCount: n(info.image_dup_count),
    hotLevel: n(pr.hot_level),
    visitingCount: n(info.visiting_count),
    renouncedMint: b(sec?.renounced_mint),
    renouncedFreeze: b(sec?.renounced_freeze_account),
    isHoneypot: sec?.is_honeypot === true || n(sec?.honeypot) === 1,
    lockPercent: n(sec?.lock_summary?.lock_percent),
    burnStatus: String(sec?.burn_status ?? ""),
    ageMs: info.creation_timestamp ? Date.now() - n(info.creation_timestamp) * 1000 : null,
  };
}
