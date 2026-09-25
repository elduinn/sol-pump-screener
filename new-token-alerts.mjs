import fs from "node:fs";
import path from "node:path";
import { isTokenAddress, isTokenizedStock } from "./chain.mjs";

const numberOrNull = (value) => {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
};

export function tokenAgeMinutes(token, nowMs = Date.now()) {
  const raw = numberOrNull(token.creation_timestamp ?? token.open_timestamp);
  if (raw == null || raw <= 0) return null;
  const createdMs = raw > 10_000_000_000 ? raw : raw * 1000;
  const age = (nowMs - createdMs) / 60_000;
  return Number.isFinite(age) && age >= 0 ? age : null;
}

export function screenNewTokenVolume(rank, cfg, nowMs = Date.now()) {
  const a = cfg.newTokenAlerts;
  const rows = [];
  for (const token of rank) {
    const address = String(token.address ?? "");
    if (!isTokenAddress(address)) continue;
    if (isTokenizedStock(token)) continue;

    const volume5m = numberOrNull(token.volume);
    const ageMin = tokenAgeMinutes(token, nowMs);
    const marketCap = numberOrNull(token.market_cap);
    const liquidity = numberOrNull(token.liquidity);
    if (volume5m == null || volume5m <= a.minVolume5mUsd) continue;
    if (ageMin == null || ageMin < a.minTokenAgeMin || ageMin > a.maxTokenAgeMin) continue;
    if (a.minMarketCapUsd != null && (marketCap == null || marketCap < a.minMarketCapUsd)) continue;
    if (a.maxMarketCapUsd != null && (marketCap == null || marketCap > a.maxMarketCapUsd)) continue;
    if (a.minLiquidityUsd != null && (liquidity == null || liquidity < a.minLiquidityUsd)) continue;

    rows.push({
      address,
      symbol: String(token.symbol ?? "?").replace(/[\r\n`]/g, "").slice(0, 12),
      ageMin,
      volume5m,
      pump5m: numberOrNull(token.price_change_percent5m ?? token.price_change_percent),
      marketCap,
      liquidity,
    });
    if (rows.length >= a.maxResults) break;
  }
  return rows;
}

export class AlertCooldownStore {
  constructor(file, cooldownMin) {
    this.file = file;
    this.cooldownMs = cooldownMin * 60_000;
    this.alerted = new Map();
    this.load();
  }

  load() {
    if (!this.file || !fs.existsSync(this.file)) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, "utf8"));
      for (const [key, value] of Object.entries(parsed.alerted ?? {})) {
        if (Number.isFinite(value)) this.alerted.set(key, value);
      }
    } catch (err) {
      console.warn(`  [new-token-alert] ignoring invalid state: ${err.message}`);
    }
  }

  fresh(rows, chain, recipient = "all", nowMs = Date.now()) {
    if (this.cooldownMs === 0) return rows;
    return rows.filter((row) => {
      const last = this.alerted.get(`${recipient}:${chain}:${row.address.toLowerCase()}`);
      return last == null || nowMs - last >= this.cooldownMs;
    });
  }

  mark(rows, chain, recipient = "all", nowMs = Date.now()) {
    for (const row of rows) this.alerted.set(`${recipient}:${chain}:${row.address.toLowerCase()}`, nowMs);
    for (const [key, at] of this.alerted) {
      if (nowMs - at >= Math.max(this.cooldownMs * 2, 60 * 60_000)) this.alerted.delete(key);
    }
    this.persist();
  }

  persist() {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, alerted: Object.fromEntries(this.alerted) }, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }
}
