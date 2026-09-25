import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AlertCooldownStore, screenNewTokenVolume, tokenAgeMinutes } from "./new-token-alerts.mjs";

const now = Date.UTC(2026, 8, 3, 12, 0, 0);
const cfg = { newTokenAlerts: { minVolume5mUsd: 300_000, minTokenAgeMin: 40, maxTokenAgeMin: 60, minMarketCapUsd: null, maxMarketCapUsd: null, minLiquidityUsd: null, maxResults: 30 } };
const token = (over = {}) => ({ address: "EJUG2BZeBcrX9Uqybc7fc6mE9tLwRAiAG7ZnSG5Jpump", symbol: "NEW", name: "New", creation_timestamp: now / 1000 - 45 * 60, volume: 300_001, market_cap: 1_000_000, liquidity: 100_000, price_change_percent5m: 2, ...over });

assert.equal(Math.floor(tokenAgeMinutes(token(), now)), 45);
assert.equal(screenNewTokenVolume([token()], cfg, now).length, 1);
assert.equal(screenNewTokenVolume([token({ volume: 300_000 })], cfg, now).length, 0, "threshold is strictly greater than 300k");
assert.equal(screenNewTokenVolume([token({ creation_timestamp: now / 1000 - 39 * 60 })], cfg, now).length, 0, "token must be at least 40 minutes old");
assert.equal(screenNewTokenVolume([token({ creation_timestamp: now / 1000 - 61 * 60 })], cfg, now).length, 0);
assert.equal(screenNewTokenVolume([token({ creation_timestamp: null, open_timestamp: null })], cfg, now).length, 0);
assert.equal(screenNewTokenVolume([token({ creation_timestamp: now / 1000 + 60 })], cfg, now).length, 0);
assert.equal(screenNewTokenVolume([token({ launchpad_platform: "xstocks" })], cfg, now).length, 0, "tokenized stocks are excluded");
assert.equal(screenNewTokenVolume([token({ launchpad_platform: "stonkfun" })], cfg, now).length, 1, "stonkfun is a memecoin launchpad, not stocks");
assert.equal(screenNewTokenVolume([token({ address: "0x1111111111111111111111111111111111111111" })], cfg, now).length, 0, "EVM addresses are rejected");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rh-alert-test-"));
const file = path.join(dir, "state.json");
const store = new AlertCooldownStore(file, 30);
const rows = screenNewTokenVolume([token()], cfg, now);
assert.equal(store.fresh(rows, "sol", "chat-a", now).length, 1);
store.mark(rows, "sol", "chat-a", now);
assert.equal(store.fresh(rows, "sol", "chat-a", now + 29 * 60_000).length, 0);
assert.equal(store.fresh(rows, "sol", "chat-b", now + 29 * 60_000).length, 1);
assert.equal(new AlertCooldownStore(file, 30).fresh(rows, "sol", "chat-a", now + 31 * 60_000).length, 1);
fs.rmSync(dir, { recursive: true });
console.log("new-token alert checks passed");
