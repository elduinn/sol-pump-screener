/**
 * /cek <mint> — should I LP this token on Meteora DLMM? Ported from rh-lp-bot's
 * radar/verdict.ts (via sol-lp-bot). Gathers in parallel:
 *   GMGN detail · Meteora DLMM pools · Jupiter buy->sell round trip · Meridian chart
 * after a mint-safety check, then a Meridian top-LPer study on the busiest pools and one
 * LLM verdict over all of it. Nothing here signs a transaction.
 */

import { resolveCekEnv } from "./env.mjs";
import { mintSafety } from "./mint.mjs";
import { dlmmPools } from "./meteora.mjs";
import { roundTrip } from "./jupiter.mjs";
import { topLpStudy, chartSignal } from "./meridian.mjs";
import { liveLps } from "./lpagent.mjs";
import { gmgnToken } from "./gmgn.mjs";
import { scoreToken, safety } from "./score.mjs";
import { llmVerdict } from "./llm.mjs";

const THESIS_LINE = {
  meme:
    "Operator thesis: MEME-FRIENDLY. On Solana, memes with real attention are where DLMM fee volume lives — do NOT penalise a token for being a meme. Judge the meme's strength instead: narrative, community, smart-money/KOL interest, and whether volume is organic or bot-driven.",
  neutral: "Operator thesis: NEUTRAL on meme vs utility — judge only traction, safety and farmability.",
  utility: "Operator thesis: favour UTILITY tokens (real product/use-case); pure memes are fading and should be penalised.",
};

function systemPrompt(c) {
  return [
    "You are a skeptical token analyst for Solana, judging ONE token the operator is considering for a Meteora DLMM liquidity position.",
    THESIS_LINE[c.thesis],
    "Weigh: (1) community clarity — genuine, non-recycled socials; (2) FOMO — momentum backed by smart money and a real narrative, or an empty pump about to fade;",
    "(3) LP risk — an LP is an AUTOMATIC BUYER as price falls, so downside matters more than upside: thin liquidity, heavy bot/bundler/sniper activity, serial-launcher devs and dev exits are red flags;",
    "(4) mint safety — mint authority ON (infinite supply), freeze authority ON (your LP can be frozen), Token-2022 transfer fee / transfer hook / permanent delegate are serious red flags;",
    "(5) farmability — a busy DLMM pool whose fees are real: fee_tvl_24h_pct = yesterday's fees ÷ TVL (daily LP yield). top_lpers = how the pool's biggest LPs historically did (profitable share, median PnL %); a pool where most top LPs lost money is a warning. live_lps = positions open RIGHT NOW: a high top1/top2 share of TVL means one exit can gut the pool; a negative median_live_pnl_pct means current LPs are underwater.",
    "METRICS: roundtrip_back_pct = % of SOL returned by a Jupiter buy->sell quote (>= ~97 is clean; much lower = transfer tax or very thin liquidity; no_sell_route = cannot sell).",
    "Rates are 0-1 decimals. Missing/0 data = unknown, not safe. Use only the numbers given.",
    c.thesisExtra ? `Extra operator rules: ${c.thesisExtra}` : "",
    'Respond ONLY as compact JSON: {"score": <0-100 conviction>, "action": "ape"|"watch"|"skip", "summary": "<one or two sentences in English, MAX 200 characters: narrative + main LP risk + best pool if any>"}.',
  ].filter(Boolean).join(" ");
}

const r1 = (v) => +v.toFixed(1);
const r3 = (v) => +v.toFixed(3);

export class NotAMintError extends Error {}

export async function tokenVerdict(cfg, mint) {
  const c = cfg.cek;
  const env = resolveCekEnv(cfg);

  // Mint check first: one fast RPC call, and a wallet/pool address must not get a fake report
  // (GMGN answers any address with a zeroed stub).
  const msRaw = await mintSafety(env.rpcUrl, mint);
  if (msRaw === "not-mint") throw new NotAMintError("that address is not a token mint (wallet, pool or program?)");
  const ms = msRaw;

  const [g, met, rt, chart] = await Promise.all([
    gmgnToken(cfg, mint).catch(() => null),
    dlmmPools(mint).catch(() => ({ pools: [], token: null })),
    roundTrip(env, mint, c.roundTripSol, c.maxLossPct).catch(() => null),
    c.chart ? chartSignal(env, mint, c.chartInterval).catch(() => null) : null,
  ]);
  const symbol = g?.symbol || met.token?.symbol || mint.slice(0, 6);

  const shownAll = met.pools.filter((p) => !p.blacklisted && p.baseFeePct >= c.minFeePct && p.tvlUsd >= c.minTvlUsd);
  const pools = shownAll.slice(0, c.maxPools).map((pool) => ({ pool, study: null, live: null }));

  // LP analysis on the busiest pools that actually earn fees: Meridian's historical top-LPer
  // study (2 requests) + LP Agent's live open positions (1 request) — independent sources,
  // so one being down still leaves the other.
  await Promise.all(pools.filter((p) => p.pool.fees24h > 0).slice(0, c.topLpPools).map(async (p) => {
    [p.study, p.live] = await Promise.all([
      topLpStudy(env, p.pool.address).catch(() => null),
      liveLps(env, p.pool.address, p.pool.tvlUsd).catch(() => null),
    ]);
  }));

  const screen = g ? scoreToken(g, ms, c.thesis) : null;
  const safetyFlags = screen ? [] : safety(null, ms).flags;

  const payload = {
    mint,
    symbol,
    name: g?.name || met.token?.name,
    gmgn: g ? {
      heuristic_kind: screen.kind,
      community: screen.community,
      heuristic_score: screen.score,
      fomo_score: screen.fomo,
      age_hours: g.ageMs != null ? r1(g.ageMs / 3_600_000) : null,
      market_cap_usd: Math.round(g.marketCap),
      ath_market_cap_usd: Math.round(g.athMarketCap),
      volume_24h_usd: Math.round(g.volume24h),
      volume_1h_usd: Math.round(g.volume1h),
      liquidity_usd: Math.round(g.liquidity),
      price_change_pct: { h1: r1(g.change1hPct), h6: r1(g.change6hPct), h24: r1(g.change24hPct) },
      buys_24h: g.buys24h,
      sells_24h: g.sells24h,
      holders: g.holders,
      smart_money_wallets: g.smartWallets,
      kol_wallets: g.kolWallets,
      bundler_wallets: g.bundlerWallets,
      rat_trader_wallets: g.ratTraderWallets,
      bot_degen_rate: r3(g.botDegenRate),
      fresh_wallet_rate: r3(g.freshWalletRate),
      top10_holder_rate: r3(g.top10Rate),
      dev_hold_rate: r3(g.devHoldRate),
      sniper_hold_rate: r3(g.sniperHoldRate),
      creator_created_count: g.creatorCreatedCount,
      creator_token_status: g.creatorTokenStatus,
      launchpad: g.launchpad || null,
      launchpad_graduated: g.launchpad ? g.launchpadProgress >= 1 : null,
      twitter: g.twitter || null,
      website: g.website || null,
      telegram: g.telegram || null,
      cto: g.ctoFlag,
      logo_reused_by_other_tokens: g.imageDupCount,
      heuristic_flags: screen.flags,
    } : met.token
      ? { unavailable: true, meteora_fallback: { price_usd: met.token.priceUsd, market_cap_usd: Math.round(met.token.marketCap), holders: met.token.holders } }
      : "unavailable",
    mint_safety: ms ? {
      program: ms.program,
      mint_authority_on: !!ms.mintAuthority,
      freeze_authority_on: !!ms.freezeAuthority,
      transfer_fee_pct: ms.transferFeeBps / 100,
      transfer_hook: !!ms.transferHook,
      permanent_delegate: !!ms.permanentDelegate,
      non_transferable: ms.nonTransferable || ms.defaultFrozen,
    } : "unavailable",
    dlmm_pools: pools.map(({ pool: p, study: s, live: l }) => ({
      pair: p.name,
      base_fee_pct: p.baseFeePct,
      bin_step: p.binStep,
      tvl_usd: Math.round(p.tvlUsd),
      volume_24h_usd: Math.round(p.vol24h),
      volume_1h_usd: Math.round(p.vol1h),
      fees_24h_usd: Math.round(p.fees24h),
      fee_tvl_24h_pct: r1(p.feeTvl24hPct),
      pool_age_hours: p.createdAt ? Math.round((Date.now() - p.createdAt) / 3_600_000) : null,
      ...(s ? {
        top_lpers: {
          count: s.lpers,
          profitable: s.profitable,
          median_pnl_pct: r1(s.medianPnlPct),
          median_fee_pct: r1(s.medianFeePct),
          avg_hold_hours: s.avgHoldHours != null ? r1(s.avgHoldHours) : null,
          last_activity_hours_ago: s.lastActivityMs ? Math.round((Date.now() - s.lastActivityMs) / 3_600_000) : null,
          suggested_style: s.suggested,
        },
      } : {}),
      ...(l ? {
        live_lps: {
          open_positions: l.openCount,
          top1_share_of_tvl_pct: l.top1Pct != null ? r1(l.top1Pct) : null,
          top2_share_of_tvl_pct: l.top2Pct != null ? r1(l.top2Pct) : null,
          in_range_pct: r1(l.inRangePct),
          median_live_pnl_pct: r1(l.medianPnlPct),
        },
      } : {}),
    })),
    dlmm_pool_count: met.pools.length,
    pools_hidden: met.pools.length - shownAll.length,
    roundtrip_back_pct: rt ? r1(rt.backPct) : null,
    no_sell_route: rt ? rt.reason.startsWith("NO SELL") : null,
    chart: chart ? {
      interval: chart.interval,
      rsi2: chart.rsi != null ? r1(chart.rsi) : null,
      supertrend: chart.supertrend,
      bollinger: chart.bb,
      window_change_pct: chart.chgPct != null ? r1(chart.chgPct) : null,
    } : null,
  };

  const llm = await llmVerdict(env, systemPrompt(c), "Rate this token:\n" + JSON.stringify(payload)).catch(() => null);
  const score = screen ? (llm ? Math.round(screen.score * 0.7 + llm.score * 0.3) : screen.score) : (llm?.score ?? null);
  console.log(`  [cek] ${symbol}: gmgn ${screen ? screen.score : "n/a"} · llm ${llm ? `${llm.action} ${llm.score}` : "n/a"} · ${met.pools.length} DLMM pools`);
  return {
    mint, symbol, gmgn: g, meteoraToken: met.token, safety: ms, screen, safetyFlags,
    pools, hiddenPools: met.pools.length - shownAll.length, roundTrip: rt, chart, llm, score,
    llmConfigured: !!env.llmKey, thesis: c.thesis,
  };
}
