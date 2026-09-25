/** Render a /cek verdict: Telegram HTML + inline keyboard, or plain text for the CLI. */

import { escapeHtml } from "../telegram.mjs";
import { meridianIssue } from "./meridian.mjs";
import { meteoraPoolUrl } from "./meteora.mjs";

const usd = (n) => {
  if (!n) return "$0";
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return `$${n.toFixed(n >= 10 ? 0 : 2)}`;
};
const sg = (n, d) => (n >= 0 ? "+" : "") + n.toFixed(d);
const pct = (r) => `${(r * 100).toFixed(0)}%`;
const age = (ms) => {
  if (ms == null || !(ms >= 0)) return "?";
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  const d = Math.floor(h / 24);
  return d >= 365 ? `${(d / 365).toFixed(1)}y` : `${d}d ${h % 24}h`;
};

/** Monospace body lines (plain text; escaped by the caller). */
export function verdictLines(v, cfg) {
  const T = [];
  const s = v.screen;
  const g = v.gmgn;
  if (s && g) {
    const kindTag = s.kind === "util" ? "🛠 util" : s.kind === "meme" ? "🐸 meme" : "❓ unclear";
    const commTag = s.community === "clear" ? "🟢 community clear" : s.community === "thin" ? "🟡 community thin" : "🔴 community sus";
    T.push(`${kindTag} · ${commTag} · FOMO ${s.fomo} · GMGN score ${s.score}`);
    T.push(`mcap ${usd(g.marketCap)} (ATH ${usd(g.athMarketCap)}) · liq ${usd(g.liquidity)}`);
    T.push(`vol 24h ${usd(g.volume24h)} · 1h ${sg(g.change1hPct, 0)}% · 24h ${sg(g.change24hPct, 0)}%`);
    T.push(`holders ${g.holders} · smart ${g.smartWallets} · KOL ${g.kolWallets} · top10 ${pct(g.top10Rate)}`);
    T.push(`bots ${pct(g.botDegenRate)} · bundlers ${g.bundlerWallets} · dev launches ${g.creatorCreatedCount}${g.creatorTokenStatus ? ` (${g.creatorTokenStatus})` : ""}`);
    const lp = g.launchpad ? `${g.launchpad}${g.launchpadProgress >= 1 ? " · graduated" : ` · bonding ${pct(g.launchpadProgress)}`}` : "no launchpad";
    T.push(`age ${age(g.ageMs)} · ${lp}${g.isHoneypot ? " · ⚠️ HONEYPOT" : ""}`);
    if (s.flags.length) T.push(`🚩 ${s.flags.join(" · ")}`);
  } else {
    T.push("GMGN: no data (gmgn-cli failed / token not indexed)");
    const m = v.meteoraToken;
    if (m) T.push(`Meteora: price $${m.priceUsd.toPrecision(3)} · mcap ${usd(m.marketCap)} · holders ${m.holders}`);
    if (v.safetyFlags.length) T.push(`🚩 ${v.safetyFlags.join(" · ")}`);
  }

  T.push("");
  const m = v.safety;
  if (m) {
    const parts = [
      m.program,
      m.mintAuthority ? "⚠️ mint auth ON" : "✅ mint renounced",
      m.freezeAuthority ? "⚠️ freeze auth ON" : "✅ freeze renounced",
    ];
    if (m.transferFeeBps > 0) parts.push(`⚠️ transfer fee ${(m.transferFeeBps / 100).toFixed(2)}%`);
    if (m.transferHook) parts.push("⚠️ transfer hook");
    if (m.permanentDelegate) parts.push("🚨 permanent delegate");
    if (m.nonTransferable || m.defaultFrozen) parts.push("🚨 untradeable");
    T.push(`🔐 ${parts.join(" · ")}`);
  } else {
    T.push("🔐 mint check: RPC unavailable");
  }

  T.push("");
  if (v.pools.length) {
    T.push(`DLMM pools (${v.pools.length} shown${v.hiddenPools ? ` · ${v.hiddenPools} hidden` : ""}) — by 24h fees:`);
    v.pools.forEach(({ pool: p, study }, i) => {
      T.push(`${i + 1}. ${p.name} · fee ${p.baseFeePct}% · bin ${p.binStep} · TVL ${usd(p.tvlUsd)}`);
      T.push(`   vol 24h ${usd(p.vol24h)} · fees ${usd(p.fees24h)} · yield ${p.feeTvl24hPct.toFixed(p.feeTvl24hPct >= 10 ? 0 : 2)}%/day`);
      if (study) {
        const last = study.lastActivityMs ? ` · last ${age(Date.now() - study.lastActivityMs)} ago` : "";
        const style = study.suggested && study.suggested.strategy !== "unknown" ? ` · style ${study.suggested.strategy}/${study.suggested.rangeStyle}` : "";
        const warn = study.profitable < study.lpers / 2 ? " ⚠️ most lost" : "";
        T.push(`   👥 top LPs ${study.profitable}/${study.lpers} profitable · median ${sg(study.medianPnlPct, 1)}% · fee ${study.medianFeePct.toFixed(1)}%${style}${last}${warn}`);
      }
    });
    const issue = meridianIssue();
    if (issue && !v.pools.some((p) => p.study)) T.push(`ℹ️ top-LP study unavailable: Meridian ${issue} — re-check later`);
  } else {
    T.push(v.hiddenPools
      ? `DLMM pools: all ${v.hiddenPools} filtered out (fee < ${cfg.cek.minFeePct}% or TVL < $${cfg.cek.minTvlUsd})`
      : "DLMM pools: none found");
  }

  const r = v.roundTrip;
  if (r) {
    const route = r.sellVia !== "-" ? ` via ${r.buyVia} → ${r.sellVia}` : r.buyVia !== "-" ? ` via ${r.buyVia}` : "";
    T.push(`${r.ok ? "✅" : "⚠️"} round trip ${r.solIn} SOL: back ${r.backPct.toFixed(1)}%${route} · ${r.reason}`);
  } else {
    T.push("❔ round trip: Jupiter unavailable");
  }

  const c = v.chart;
  if (c) {
    const bits = [c.supertrend && `supertrend ${c.supertrend}`, c.rsi != null && `RSI(2) ${c.rsi.toFixed(0)}`, c.bb && `BB ${c.bb}`];
    if (c.chgPct != null) bits.push(`${Math.round(c.windowHours)}h ${sg(c.chgPct, 1)}%`);
    T.push(`📈 ${c.interval.replace("_MINUTE", "m").replace("_HOUR", "h")}: ${bits.filter(Boolean).join(" · ")}`);
  }
  return T;
}

/** Headline (verdict + LLM summary) as Telegram HTML. */
export function verdictHead(v) {
  const act = v.llm?.action;
  const actTag = act === "ape" ? "🟢 APE" : act === "watch" ? "🟡 WATCH" : act === "skip" ? "🔴 SKIP" : "⚪ LLM n/a";
  const note = v.llm
    ? `\n💡 ${escapeHtml(v.llm.summary)}`
    : v.llmConfigured ? "\n<i>(LLM did not answer — see log)</i>" : "\n<i>(LLM off — CEK_LLM_KEY empty)</i>";
  return `⚖️ <b>Verdict ${escapeHtml(v.symbol)}</b> — ${actTag}${v.score != null ? ` · score <b>${v.score}</b>` : ""} <i>(${v.thesis})</i>\n` +
    `<code>${v.mint}</code>${note}`;
}

export const verdictHtml = (v, cfg) => `${verdictHead(v)}\n<pre>${escapeHtml(verdictLines(v, cfg).join("\n"))}</pre>`;

export function verdictKeyboard(v) {
  const row1 = [{ text: "🔄 Re-check", callback_data: `cek:${v.mint}` }, { text: "📖 Story", callback_data: `story:${v.mint}` }];
  const row2 = [
    { text: "GMGN", url: gmgnUrl(v.mint) },
    { text: "DexScreener", url: `https://dexscreener.com/solana/${v.mint}` },
  ];
  const top = v.pools[0];
  if (top) row2.push({ text: "🌊 Meteora", url: meteoraPoolUrl(top.pool.address) });
  return { inline_keyboard: [row1, row2] };
}

export const gmgnUrl = (mint) => `https://gmgn.ai/sol/token/${mint}`;

/** Plain-text report for the terminal (--cek). */
export function verdictText(v, cfg) {
  const strip = (s) => s.replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  return strip(verdictHead(v)) + "\n\n" + verdictLines(v, cfg).join("\n");
}
