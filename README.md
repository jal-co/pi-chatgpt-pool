# pi-chatgpt-pool

Pool several ChatGPT accounts in [pi](https://github.com/earendil-works/pi) using OpenAI's Sign in with ChatGPT. You pick one model, and each request goes to a signed-in account. When an account hits a rate limit or its usage limit, pi retries the request on the next account.

## Install

```bash
pi install npm:pi-chatgpt-pool
```

Requires pi 0.99 or later.

## Set up accounts

```text
/chatgpt-pool add personal
/chatgpt-pool add work
/login
```

`/login` lists each account as `ChatGPT (<label>)`. Sign in to each one with a different ChatGPT account. Then pick a pooled model:

```text
/model chatgpt/gpt-5.6-sol
```

Every OpenAI model has a pooled copy under the `chatgpt` provider. Each account also shows up as its own provider (`chatgpt-1`, `chatgpt-2`, ...) if you want to pin one.

## Commands

| Command | What it does |
| --- | --- |
| `/chatgpt-pool` | Show each account's usage, when each window resets, and its banked resets |
| `/chatgpt-pool add <label>` | Add an account slot. Sign in to it with `/login` |
| `/chatgpt-pool remove <label>` | Remove an account. Run `/logout` for it first to delete its token |
| `/chatgpt-pool spend <label>` | Spend one banked reset on that account, after you confirm |
| `/chatgpt-pool reset` | Forget recorded limits, for example after a limit clears early |

Accounts are stored in `~/.pi/agent/chatgpt-pool.json`. Tokens are stored by pi in `~/.pi/agent/auth.json`.

## How failover works

- A conversation stays on the same account while it works, so prompt caching and reasoning replay keep working.
- When an account hits a limit, the plugin reads the reset time from the 429 response (`resets_at` in the body, `retry-after`, or the rate-limit reset headers) and skips that account until then. If the response has no reset time, it waits 1 minute for a rate limit or 1 hour for a usage limit.
- The next request goes to the first ready account, in the order you added them.
- Reset times are saved in `chatgpt-pool.json`, so they survive restarts.
- If every account is signed out or limited, the request fails with a message pointing to `/chatgpt-pool`.

## Banked resets

ChatGPT gives some accounts reset credits that clear a usage limit early. `/chatgpt-pool` shows how many each account has banked and how many apply right now.

The plugin never spends one on its own. Run `/chatgpt-pool spend <label>` to spend one; it picks the credit that expires first and asks you to confirm. It warns you when ChatGPT reports nothing to reset.

Usage and banked resets come from ChatGPT's `backend-api/wham` endpoints, the same ones the Codex CLI uses.

## Credits

The Sign in with ChatGPT flow in `src/chatgpt-oauth.ts` is adapted from pi's `packages/ai/src/auth/oauth/openai-chatgpt.ts` (MIT, Mario Zechner). pi 0.99.0 ships without that file, so its built-in "Sign in with ChatGPT" option fails to load.
