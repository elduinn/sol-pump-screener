/**
 * Heuristic token score (no LLM), ported from rh-lp-bot's screen.ts scoreToken():
 *   kind      util / meme / unclear from name/symbol/site keywords
 *   community clear / thin / sus from socials (renamed X, recycled logo, CTO)
 *   FOMO      0-100 traction read (smart money, KOL, turnover, holders, momentum, heat)
 *   safety    0-25: on-chain mint authorities + Token-2022 extensions (the Solana
 *             "honeypot" surface) plus GMGN holder-distribution red flags
 * cek.thesis shifts the kind adjustment: "meme" rewards memes, "utility" is rh-lp-bot's
 * original (memes penalised), "neutral" ignores kind.
 */

const MEME_RE = /(cat|dog|inu|shib|pepe|wojak|moon|elon|trump|doge|frog|chad|wif\b|bonk|floki|meme|baby|kitty|puppy|lambo|degen|based|wagmi|\bgm\b|pump|milady|fart|goat|popcat|mew|pnut|chill|guy|69|420)/i;
const UTIL_RE =
  /(protocol|finance|\bfi\b|swap|\bdex\b|\bai\b|agent|oracle|\brwa\b|chain|network|bridge|vault|index|lend|perp|stake|yield|\bdata\b|compute|\bgpu\b|node|infra|\bpay|bank|credit|trade|exchange|tool|app|market|treasury|fund|asset|invest|stock|game|social|identity)/i;

function classify(t) {
  const hay = `${t.name} ${t.symbol}`.toLowerCase();
  const util = UTIL_RE.test(hay) || (!!t.website && UTIL_RE.test(t.website.toLowerCase()));
  const meme = MEME_RE.test(hay) || /^(pump|bonk|moon|believe|boop)/i.test(t.launchpad);
  if (util && !meme) return "util";
  if (meme && !util) return "meme";
  if (util && meme) return "unclear";
  // no keyword hit: on Solana a token without a real site is almost always a meme
  return t.website ? "unclear" : "meme";
}

function communityGrade(t) {
  const flags = [];
  const socials = [t.twitter, t.website, t.telegram].filter(Boolean).length;
  const recycledLogo = t.imageDupCount >= 5 && !t.isOg;
  if (t.twitterChanged) flags.push("X renamed");
  if (recycledLogo) flags.push(`logo reused ×${t.imageDupCount}`);
  if (!t.twitter) flags.push("no X");
  if (t.ctoFlag) flags.push("CTO");
  const grade = t.twitterChanged || recycledLogo ? "sus" : socials >= 2 ? "clear" : "thin";
  return { grade, flags };
}

function fomoScore(t) {
  const turnover = t.liquidity > 0 ? t.volume24h / t.liquidity : 0;
  const s =
    Math.min(25, t.smartWallets * 1.2) +
    Math.min(20, t.kolWallets * 0.4) +
    Math.min(20, Math.log10(1 + turnover) * 12) +
    Math.min(10, Math.log10(1 + t.holders) * 3) +
    Math.min(15, Math.max(0, t.change24hPct) * 0.05) +
    Math.min(10, t.hotLevel * 3 + Math.log10(1 + t.visitingCount) * 1.5);
  return Math.round(Math.max(0, Math.min(100, s)));
}

/** 0-25 safety points + flags. On-chain mint data wins over GMGN's copy when both exist. */
export function safety(t, m) {
  const flags = [];
  let pts = 25;
  const mintAuth = m ? !!m.mintAuthority : t?.renouncedMint === false;
  const freezeAuth = m ? !!m.freezeAuthority : t?.renouncedFreeze === false;
  if (mintAuth) { pts -= 8; flags.push("mint auth ON"); }
  if (freezeAuth) { pts -= 8; flags.push("freeze auth ON"); }
  if (m) {
    if (m.permanentDelegate) { pts -= 12; flags.push("permanent delegate"); }
    if (m.transferHook) { pts -= 6; flags.push("transfer hook"); }
    if (m.transferFeeBps > 0) { pts -= Math.min(10, m.transferFeeBps / 50); flags.push(`transfer fee ${(m.transferFeeBps / 100).toFixed(1)}%`); }
    if (m.nonTransferable || m.defaultFrozen) { pts = 0; flags.push("UNTRADEABLE mint"); }
  }
  if (t) {
    if (t.isHoneypot) { pts = 0; flags.push("GMGN honeypot"); }
    if (t.top10Rate > 0.5) { pts -= 5; flags.push(`top10 ${(t.top10Rate * 100).toFixed(0)}%`); }
    if (t.bundlerRate > 0.3) { pts -= 4; flags.push(`bundler ${(t.bundlerRate * 100).toFixed(0)}%`); }
    if (t.devHoldRate > 0.1) { pts -= 3; flags.push(`dev ${(t.devHoldRate * 100).toFixed(0)}%`); }
    if (t.sniperHoldRate > 0.15) { pts -= 3; flags.push(`sniper hold ${(t.sniperHoldRate * 100).toFixed(0)}%`); }
    if (t.botDegenRate > 0.3) { pts -= 3; flags.push(`bots ${(t.botDegenRate * 100).toFixed(0)}%`); }
    if (t.creatorCreatedCount >= 10) { pts -= 3; flags.push(`serial dev ×${t.creatorCreatedCount}`); }
    if (t.lockPercent >= 0.5 || t.burnStatus === "burn") pts += 1;
  }
  return { pts: Math.max(0, Math.min(25, pts)), flags };
}

function kindAdj(kind, thesis) {
  if (thesis === "utility") return kind === "util" ? 10 : kind === "meme" ? -15 : 0;
  if (thesis === "meme") return kind === "meme" ? 8 : kind === "util" ? 0 : 3;
  return 0;
}

export function scoreToken(t, m, thesis) {
  const kind = classify(t);
  const { grade, flags: cflags } = communityGrade(t);
  const fomo = fomoScore(t);
  const { pts, flags: sflags } = safety(t, m);
  const commPts = grade === "clear" ? 25 : grade === "thin" ? 10 : 0;
  const score = Math.round(Math.max(0, Math.min(100, fomo * 0.4 + commPts + pts + kindAdj(kind, thesis))));
  return { kind, community: grade, fomo, safety: pts, score, flags: [...cflags, ...sflags] };
}
