# sol-pump-screener

Solana memecoin pump screener (GMGN 1h pump + 5m volume acceleration) with Telegram alerts,
plus `/cek` — a "should I LP this on Meteora DLMM?" verdict per token.

Plain Node.js (`.mjs`), **zero npm dependencies**.

## Telegram

- **Alerts** every `watch.intervalMs`: a table, then one line per token —
  `SYMBOL · launchpad · CA (tap to copy) · GMGN` — and a **⚖️ Cek** button per token.
- **⚖️ Cek / `/cek <mint>`**: GMGN stats · mint & freeze authority · Token-2022 traps ·
  DLMM pools (fee, bin step, TVL, daily yield) · top-LPer results (Agent Meridian) ·
  Jupiter buy→sell test · chart trend · LLM verdict (APE / WATCH / SKIP).
- **A bare mint** → LLM origin-story write-up (`ai.promptTemplate`), also on the 📖 Story button.

Only ids in `TELEGRAM_USER_IDS` can use the bot.

## Setup on a new machine

```bash
# Node 20+
npm install -g gmgn-cli
gmgn-cli config                    # prints a URL — create the API key for the shown public key
gmgn-cli config --apply <API_KEY>  # GMGN keys are bound to this machine's keypair

git clone https://github.com/elduinn/sol-pump-screener.git
cd sol-pump-screener
cp .env.example .env               # fill in — see below
npm run telegram-test              # checks the bot token + chat ids
npm run cek -- EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm   # /cek from the terminal
npm start                          # --serve: alerts + /cek + buttons, one process
```

`.env` (never committed):

| Var | Needed for |
|---|---|
| `TELEGRAM_BOT_TOKEN` | the bot — **one running process per token** (a second one gets 409 Conflict) |
| `TELEGRAM_USER_IDS` | who receives alerts and may use the bot (comma-separated) |
| `LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL` | story write-ups and free-text prompts |
| `CEK_LLM_URL` / `CEK_LLM_KEY` / `CEK_LLM_MODEL` | `/cek` verdict (full chat-completions URL) |
| `SOL_RPC_URL`, `MERIDIAN_API_KEY`, `JUPITER_API_KEY` | optional overrides |

Keep it running with pm2 (`pm2 start npm --name sol-screener -- start`) or a `screen` session.

## Config

`config.json` — validated on load; see `config.mjs` for every key and its default, or
`npm run params` for the gmgn-cli parameters. The `cek` section tunes `/cek` (`thesis`:
`meme` | `neutral` | `utility`, pool filters, round-trip size, chart).

## Commands

`npm start` (serve) · `npm run watch` (alerts only) · `npm run listen` (bot only) ·
`npm run once` · `npm run survey` · `npm run cek -- <mint>` · `npm run config`
