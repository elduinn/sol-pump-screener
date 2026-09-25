/**
 * On-chain mint safety — the Solana equivalent of an EVM honeypot/ownership check. One
 * getAccountInfo (jsonParsed) on the mint tells us:
 *   - mint authority   — still set -> supply can be inflated at will
 *   - freeze authority — still set -> your token account (incl. LP withdrawals) can be frozen
 *   - Token-2022 extensions:
 *       transferFeeConfig  -> a built-in "tax" on every transfer (bps)
 *       transferHook       -> custom program runs on every transfer (can block sells)
 *       permanentDelegate  -> an authority can move/burn tokens from ANY account
 *       nonTransferable / defaultAccountState=frozen -> effectively unsellable
 * Verified live 2026-09-25 on WIF (spl-token, clean), USDC (mint+freeze on) and PYUSD
 * (token-2022, permanent delegate, hook with programId null = unset).
 */

const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

/**
 * @returns {Promise<object|"not-mint"|null>} null = RPC failed; "not-mint" = the account
 *          is missing or is not a token mint (wallet, pool, program...).
 */
export async function mintSafety(rpcUrl, mint) {
  let j;
  try {
    const r = await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getAccountInfo", params: [mint, { encoding: "jsonParsed" }] }),
      signal: AbortSignal.timeout(10_000),
    });
    j = await r.json();
  } catch (err) {
    console.warn(`  [cek] mint check failed: ${err.message.slice(0, 80)}`);
    return null;
  }
  if (!j || j.error || !j.result) return null;   // RPC error is not "not a mint"
  const v = j.result.value;
  const parsed = v?.data?.parsed;
  if (!parsed || parsed.type !== "mint") return "not-mint";

  const info = parsed.info ?? {};
  const ext = new Map((info.extensions ?? []).map((e) => [String(e.extension), e.state ?? {}]));
  // `newerTransferFee` applies once its epoch arrives — take the max to be safe.
  const tf = ext.get("transferFeeConfig");
  const transferFeeBps = tf
    ? Math.max(Number(tf.newerTransferFee?.transferFeeBasisPoints ?? 0), Number(tf.olderTransferFee?.transferFeeBasisPoints ?? 0))
    : 0;

  const s = {
    program: v.owner === TOKEN_2022 ? "token-2022" : v.data?.program === "spl-token" ? "spl-token" : "unknown",
    decimals: Number(info.decimals ?? 0),
    mintAuthority: info.mintAuthority ?? null,
    freezeAuthority: info.freezeAuthority ?? null,
    transferFeeBps,
    transferHook: ext.get("transferHook")?.programId ?? null,
    permanentDelegate: ext.get("permanentDelegate")?.delegate ?? null,
    nonTransferable: ext.has("nonTransferable"),
    defaultFrozen: String(ext.get("defaultAccountState")?.accountState ?? "").toLowerCase() === "frozen",
  };
  return s;
}
