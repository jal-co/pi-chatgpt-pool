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
| `/chatgpt-pool` | Show each account and whether it is ready, signed out, or cooling down |
| `/chatgpt-pool add <label>` | Add an account slot. Sign in to it with `/login` |
| `/chatgpt-pool remove <label>` | Remove an account. Run `/logout` for it first to delete its token |
| `/chatgpt-pool reset` | Clear cooldowns, for example after a usage limit resets early |

Accounts are stored in `~/.pi/agent/chatgpt-pool.json`. Tokens are stored by pi in `~/.pi/agent/auth.json`.

## How failover works

- A conversation stays on the same account while it works, so prompt caching and reasoning replay keep working.
- If an account returns a rate limit, it cools down for 1 minute. If it returns a usage limit, it cools down for 1 hour. The next request goes to the first ready account in the order you added them.
- Cooldowns are in memory. Restarting pi clears them.
- If every account is signed out or cooling down, the request fails with a message pointing to `/chatgpt-pool`.

Cooldowns use fixed lengths instead of the reset time in the error. An account can come back before pi tries it again; use `/chatgpt-pool reset` in that case.

## Credits

The Sign in with ChatGPT flow in `src/chatgpt-oauth.ts` is adapted from pi's `packages/ai/src/auth/oauth/openai-chatgpt.ts` (MIT, Mario Zechner). pi 0.99.0 ships without that file, so its built-in "Sign in with ChatGPT" option fails to load.
