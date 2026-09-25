/**
 * Telegram delivery for the screener.
 *
 * Credentials are NOT stored in config.json — they are read from this project's
 * own .env, so the token never lands in a file you might share or commit.
 * Self-contained: nothing here depends on another project's files.
 *
 * Calls the Bot API directly with fetch rather than pulling in a bot framework,
 * which keeps the project at zero npm dependencies.
 */

import fs from "node:fs";

/** Minimal .env reader: KEY=VALUE, ignores blanks/comments, strips quotes. */
export function readEnvFile(path) {
  const out = {};
  if (!path || !fs.existsSync(path)) return out;
  for (const raw of fs.readFileSync(path, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

/**
 * Resolve credentials. Real process env wins over the file, so you can override
 * per-run without editing anything.
 */
export function resolveTelegramCreds(cfg) {
  const t = cfg.telegram ?? {};
  const fileEnv = readEnvFile(t.envFile);
  const pick = (k) => process.env[k] ?? fileEnv[k];

  const token = pick(t.tokenEnvVar ?? "TELEGRAM_BOT_TOKEN");
  const rawIds = pick(t.chatIdsEnvVar ?? "TELEGRAM_USER_IDS");

  // Explicit chatIds in config win; otherwise fall back to the env allowlist.
  let chatIds = Array.isArray(t.chatIds) && t.chatIds.length
    ? t.chatIds.map(String)
    : String(rawIds ?? "").split(",").map((s) => s.trim()).filter(Boolean);

  return { token, chatIds, source: t.envFile };
}

const TELEGRAM_LIMIT = 4096;

/**
 * Split on line boundaries so a monospace table never breaks mid-row.
 * `fence` re-opens the code fence on every chunk, otherwise chunk 2+ renders
 * as plain text with the alignment destroyed.
 */
export function chunkMessage(text, { fence = false, limit = TELEGRAM_LIMIT } = {}) {
  const wrap = (body) => (fence ? "```\n" + body + "\n```" : body);
  const overhead = fence ? 8 : 0;
  const budget = limit - overhead;

  const lines = text.split("\n");
  const chunks = [];
  let buf = [];
  let len = 0;

  for (const line of lines) {
    const piece = line.length > budget ? line.slice(0, budget) : line;
    if (len + piece.length + 1 > budget && buf.length) {
      chunks.push(wrap(buf.join("\n")));
      buf = []; len = 0;
    }
    buf.push(piece);
    len += piece.length + 1;
  }
  if (buf.length) chunks.push(wrap(buf.join("\n")));
  return chunks;
}

export const escapeHtml = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * Chunk a message built from blocks into HTML parts.
 *   { pre: true,  lines } — raw text, escaped here and wrapped in <pre>
 *   { pre: false, lines } — caller-supplied HTML, sent as-is
 * Splits only on line boundaries, and a <pre> block cut across two parts is
 * closed and re-opened, so neither table alignment nor tags ever break.
 */
export function chunkHtmlBlocks(blocks, limit = TELEGRAM_LIMIT) {
  const entries = blocks.flatMap((b) =>
    b.lines.map((line) => ({ pre: b.pre, html: b.pre ? escapeHtml(line) : line })));

  const render = (list) => {
    const groups = [];
    for (const e of list) {
      const last = groups[groups.length - 1];
      if (last && last.pre === e.pre) last.lines.push(e.html);
      else groups.push({ pre: e.pre, lines: [e.html] });
    }
    return groups
      .map((g) => (g.pre ? `<pre>${g.lines.join("\n")}</pre>` : g.lines.join("\n")))
      .join("\n");
  };

  const chunks = [];
  let buf = [];
  for (const e of entries) {
    if (buf.length && render([...buf, e]).length > limit) {
      chunks.push(render(buf));
      buf = [];
    }
    buf.push(e);
  }
  if (buf.length) chunks.push(render(buf));
  return chunks;
}

async function postJson(url, body, timeoutMs) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    const json = await res.json().catch(() => ({}));
    return { ok: res.ok && json.ok !== false, status: res.status, json };
  } finally {
    clearTimeout(timer);
  }
}

/** Raw Bot API POST. Never throws: returns {ok, status, json}. */
export async function tgCall(cfg, method, body) {
  const { token } = resolveTelegramCreds(cfg);
  if (!token) return { ok: false, status: 0, json: { description: "no token" } };
  try {
    return await postJson(`https://api.telegram.org/bot${token}/${method}`, body, cfg.telegram?.timeoutMs ?? 15000);
  } catch (err) {
    return { ok: false, status: 0, json: { description: err.message } };
  }
}

/** Send one HTML message (no chunking) and return its message_id, or null. */
export async function sendHtml(cfg, chatId, html, { replyMarkup, replyTo } = {}) {
  const r = await tgCall(cfg, "sendMessage", {
    chat_id: chatId,
    text: html,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    ...(replyTo ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } } : {}),
  });
  if (!r.ok) console.warn(`  [telegram] sendMessage failed: ${r.json?.description ?? r.status}`);
  return r.ok ? r.json.result?.message_id ?? null : null;
}

/** Replace the text of a message sent by sendHtml. */
export async function editHtml(cfg, chatId, messageId, html, { replyMarkup } = {}) {
  const r = await tgCall(cfg, "editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text: html,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
  });
  if (!r.ok) console.warn(`  [telegram] editMessageText failed: ${r.json?.description ?? r.status}`);
  return r.ok;
}

/** Stop the button's loading spinner (optionally with a toast). */
export function answerCallback(cfg, callbackId, text) {
  return tgCall(cfg, "answerCallbackQuery", { callback_query_id: callbackId, ...(text ? { text } : {}) });
}

/** Verify the token without sending anything. */
export async function verifyBot(cfg) {
  const { token } = resolveTelegramCreds(cfg);
  if (!token) return { ok: false, error: "no token" };
  const r = await postJson(`https://api.telegram.org/bot${token}/getMe`, {},
    cfg.telegram?.timeoutMs ?? 15000);
  return r.ok
    ? { ok: true, username: r.json.result?.username, id: r.json.result?.id }
    : { ok: false, error: r.json?.description ?? `HTTP ${r.status}` };
}

/**
 * Send one message to every configured chat, chunked as needed.
 * Returns a per-chat report rather than throwing, so a Telegram outage can
 * never take down a screener pass.
 */
/**
 * `replyMarkup` (an inline keyboard) is attached to the LAST part only — that is the part
 * holding the address list the buttons refer to.
 */
export async function sendTelegram(cfg, text, { fence = false, parseMode, chatIds: override, blocks, replyMarkup } = {}) {
  const t = cfg.telegram ?? {};
  if (!t.enabled) return { skipped: "disabled" };

  const { token, chatIds: configured } = resolveTelegramCreds(cfg);
  const chatIds = override ?? configured;
  if (!token) return { skipped: `no bot token (looked for ${t.tokenEnvVar ?? "TELEGRAM_BOT_TOKEN"} in ${t.envFile ?? "process env"})` };
  if (!chatIds?.length) return { skipped: `no chat ids (looked for ${t.chatIdsEnvVar ?? "TELEGRAM_USER_IDS"})` };

  // `blocks` (see chunkHtmlBlocks) always goes out as HTML, whatever the
  // config default says.
  const chunks = blocks ? chunkHtmlBlocks(blocks) : chunkMessage(text, { fence });
  if (blocks) parseMode = "HTML";
  const results = [];

  for (const chatId of chatIds) {
    for (let i = 0; i < chunks.length; i++) {
      const body = {
        chat_id: chatId,
        text: chunks[i],
        disable_web_page_preview: true,
      };
      // parseMode: undefined -> config default; null -> force plain text.
      const mode = parseMode === undefined ? t.parseMode : parseMode;
      if (mode) body.parse_mode = mode;
      if (t.silent) body.disable_notification = true;
      if (replyMarkup && i === chunks.length - 1) body.reply_markup = replyMarkup;

      let r = await postJson(`https://api.telegram.org/bot${token}/sendMessage`, body, t.timeoutMs ?? 15000);

      // Telegram asks callers to wait a stated number of seconds on 429.
      if (!r.ok && r.status === 429) {
        const wait = (r.json?.parameters?.retry_after ?? 2) * 1000;
        await new Promise((res) => setTimeout(res, wait + 250));
        r = await postJson(`https://api.telegram.org/bot${token}/sendMessage`, body, t.timeoutMs ?? 15000);
      }

      results.push({ chatId, part: i + 1, of: chunks.length, ok: r.ok,
                     error: r.ok ? null : (r.json?.description ?? `HTTP ${r.status}`) });
      if (!r.ok) break;   // stop sending parts to a chat that just failed
    }
  }
  return { results, chunks: chunks.length };
}


// ---------------------------------------------------------------------------
// LISTENING (long poll)
// ---------------------------------------------------------------------------
// Telegram permits exactly ONE getUpdates consumer per bot token. A second
// process polling the same token gets HTTP 409 and the two fight over every
// message, so that case is detected and reported rather than left to look like
// a random outage.

async function apiGet(token, method, params, timeoutMs) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const url = new URL(`https://api.telegram.org/bot${token}/${method}`);
    for (const [k, v] of Object.entries(params ?? {})) {
      url.searchParams.set(k, typeof v === "object" ? JSON.stringify(v) : String(v));
    }
    const res = await fetch(url, { signal: ac.signal });
    const json = await res.json().catch(() => ({}));
    return { ok: res.ok && json.ok !== false, status: res.status, json };
  } finally {
    clearTimeout(timer);
  }
}

/** Show "typing…" so a slow model doesn't look like a dead bot. */
export async function sendTyping(cfg, chatId) {
  const { token } = resolveTelegramCreds(cfg);
  if (!token) return;
  await apiGet(token, "sendChatAction", { chat_id: chatId, action: "typing" }, 10_000).catch(() => {});
}

/**
 * Long-poll for incoming messages and hand each to `onMessage`. Inline-button presses go to
 * `onCallback` (same allowlist); without it they are not even requested from Telegram.
 * @param {(msg: {chatId: string, userId: number, text: string, name: string}) => Promise<void>} onMessage
 * @param {{pollSeconds?: number, onCallback?: (cb: {id: string, chatId: string, userId: number, data: string, messageId: number, name: string}) => Promise<void>}} [opts]
 */
export async function listenTelegram(cfg, onMessage, { pollSeconds = 30, onCallback } = {}) {
  const { token, chatIds } = resolveTelegramCreds(cfg);
  if (!token) throw new Error("no bot token — cannot listen");

  // Same allowlist that decides who receives alerts now decides who may spend
  // your LLM credits. Without this, anyone who finds the bot can run up a bill.
  const allowed = new Set((chatIds ?? []).map(String));
  if (!allowed.size) throw new Error("no allowlist — refusing to listen to everyone");

  let offset = 0;
  let conflictWarned = false;

  for (;;) {
    let r;
    try {
      r = await apiGet(token, "getUpdates", {
        offset,
        timeout: pollSeconds,
        allowed_updates: onCallback ? ["message", "callback_query"] : ["message"],
      }, (pollSeconds + 15) * 1000);
    } catch {
      await new Promise((res) => setTimeout(res, 3000));
      continue;
    }

    if (!r.ok) {
      if (r.status === 409) {
        if (!conflictWarned) {
          console.error(
            "  [telegram] 409 Conflict — another process is already polling this bot token.\n" +
            "             Telegram allows only one listener per token. Stop the other bot,\n" +
            "             or use a separate token for this one."
          );
          conflictWarned = true;
        }
        await new Promise((res) => setTimeout(res, 10_000));
        continue;
      }
      await new Promise((res) => setTimeout(res, 5000));
      continue;
    }
    conflictWarned = false;

    for (const upd of r.json.result ?? []) {
      offset = upd.update_id + 1;      // advance BEFORE handling, or a crash re-runs it forever

      const cq = upd.callback_query;
      if (cq && onCallback) {
        const cbUser = cq.from?.id;
        const cbChat = String(cq.message?.chat?.id ?? "");
        if (!allowed.has(String(cbUser)) && !allowed.has(cbChat)) {
          console.warn(`  [telegram] ignoring button press from unauthorised id ${cbUser}`);
          await answerCallback(cfg, cq.id, "⛔ not allowed");
          continue;
        }
        // Not awaited: a /cek takes 10-30s and must not stall the poll loop.
        onCallback({
          id: cq.id,
          chatId: cbChat,
          userId: cbUser,
          data: String(cq.data ?? ""),
          messageId: cq.message?.message_id,
          name: cq.from?.username ?? cq.from?.first_name ?? String(cbUser),
        }).catch((err) => console.error(`  [telegram] button handler error: ${err.message}`));
        continue;
      }

      const msg = upd.message;
      const text = msg?.text?.trim();
      if (!text) continue;

      const userId = msg.from?.id;
      const chatId = String(msg.chat?.id);
      if (!allowed.has(String(userId)) && !allowed.has(chatId)) {
        console.warn(`  [telegram] ignoring message from unauthorised id ${userId}`);
        continue;
      }

      try {
        await onMessage({
          chatId,
          userId,
          text,
          name: msg.from?.username ?? msg.from?.first_name ?? String(userId),
        });
      } catch (err) {
        console.error(`  [telegram] handler error: ${err.message}`);
      }
    }
  }
}
