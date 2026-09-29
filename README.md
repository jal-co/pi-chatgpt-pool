# pi-chatgpt-pool

Pool several ChatGPT accounts in [pi](https://github.com/earendil-works/pi) using OpenAI's Sign in with ChatGPT. You pick one model, and each request goes to a signed-in account. When an account hits a rate limit or its usage limit, pi retries the request on the next account.

## Install

```bash
pi install npm:pi-chatgpt-pool
```

Requires pi 0.99.1 or later. The plugin uses pi's own Sign in with ChatGPT flow, which 0.99.0 shipped without.

## Set up accounts

Run `/chatgpt-pool`, press `a` to add an account, then Enter to sign in. Or from the editor:

```text
/chatgpt-pool add personal
/chatgpt-pool add work
```

After adding an account, pi fills in `/login chatgpt-<n>` for it; press Enter to open the ChatGPT sign-in. Sign in to each account with a different ChatGPT account. `/chatgpt-pool login <label>` does the same for an existing account.

`/login` lists each account as `ChatGPT (<label>)`, or under a name you choose with `/chatgpt-pool name`. Renaming keeps the account signed in. Sign in to each one with a different ChatGPT account. Then pick a pooled model:

```text
/model chatgpt/gpt-5.6-sol
```

The pool offers the ChatGPT subscription models: the OpenAI models that pi also lists for OpenAI Codex, such as `gpt-6.1-sol` and `gpt-5.6-sol`. New models appear when pi's catalog adds them. Pooled models show up once you've added at least one account. Each account also shows up as its own provider (`chatgpt-1`, `chatgpt-2`, ...) if you want to pin one.

## Commands

| Command | What it does |
| --- | --- |
| `/chatgpt-pool` | Open the pool panel (see below) |
| `/chatgpt-pool add <label>` | Add an account slot. Sign in to it with `/login` |
| `/chatgpt-pool login <label>` | Fill in `/login` for that account, so Enter starts its sign-in |
| `/chatgpt-pool name <label> <name>` | Set the name the account shows in `/login`, for example `Work (jal@mastra.ai)`. Leave the name empty to go back to `ChatGPT (<label>)` |
| `/chatgpt-pool remove <label>` | Remove an account. Run `/logout` for it first to delete its token |
| `/chatgpt-pool strategy <name>` | Set the routing strategy: `fill-first`, `round-robin`, `least-used`, or `use-it-or-lose-it` |
| `/chatgpt-pool reset` | Forget recorded limits, for example after a limit clears early |

The command autocompletes its actions and account labels.

## Pool panel

`/chatgpt-pool` shows each account's sign-in status and any recorded limit countdown. Usage meters and banked resets are hidden for ChatGPT subscription-sharing sign-ins until a compatible usage endpoint is verified. Opening the panel does not send rejected Codex usage requests.

| Key | Action |
| --- | --- |
| `↑` `↓` or `j` `k` | Select an account |
| `enter` | Sign in to the selected account (fills in `/login` for it; press Enter again) |
| `c` | Clear the selected account's recorded limit |
| `n` | Set the name the selected account shows in `/login` |
| `d` | Remove the selected account |
| `a` | Add an account |
| `t` | Choose the strategy |
| `r` | Refresh usage |
| `esc` or `q` | Close |

Over RPC the same actions are offered as a list instead.

While a pooled model is selected, the footer shows the account in use, for example `chatgpt: work`, plus how many accounts have recorded limits and when the next one returns. When a conversation moves to another account, pi shows a notice such as `ChatGPT pool: personal is limited (back in 1h 30m), switched to work.`

`/chatgpt-pool` and `spend` need the interactive UI; in `--print` or `--mode json` they stop with an error instead of spending anything. From a shell, use pi's own commands:

```bash
pi auth check --provider chatgpt-1     # is this account signed in?
pi --list-models chatgpt               # pooled models
pi --model chatgpt/gpt-5.6-sol         # start pi on the pool
```

Accounts are stored in `~/.pi/agent/chatgpt-pool.json`. Tokens are stored by pi in `~/.pi/agent/auth.json`.

## Strategies

A conversation stays on the same account while it works, so prompt caching and reasoning replay keep working. The strategy decides where each new conversation starts, and which account a limited conversation moves to.

| Strategy | New conversations go to |
| --- | --- |
| Fill first (default) | The first ready account, in the order you added them |
| Round robin | The next account in turn, so load spreads evenly |
| Least used | The account with the lowest usage % |
| Use it or lose it | The account whose usage window resets soonest, so its remaining quota isn't wasted |

Choose one from the **Strategy** row in `/chatgpt-pool`, or run `/chatgpt-pool strategy <name>`. It's saved in `chatgpt-pool.json`, and the round-robin position is shared across pi sessions. Least used and use it or lose it require usage data. The current ChatGPT sign-in flow cannot read it, so these strategies use the configured account order. Round robin spreads new conversations without usage data.

## How failover works

- When an account hits a limit, the plugin reads the reset time from the 429 response (`resets_at` in the body, `retry-after`, or the rate-limit reset headers) and skips that account until then. If the response has no reset time, it waits 1 minute for a rate limit or 1 hour for a usage limit.
- The next request goes to the first ready account in the current strategy's order.
- Reset times are saved in `chatgpt-pool.json`, so they survive restarts.
- If every account is signed out or limited, the request fails with a message pointing to `/chatgpt-pool`.

## Usage and banked resets

OpenAI's subscription-sharing sign-in tokens are not accepted by the Codex `backend-api/wham` usage service. Usage meters and banked-reset actions are hidden for these accounts. No reset is spent, and the pool never spends one automatically. Recorded limits and failover still work from inference errors.

Review actual usage in [ChatGPT Usage settings](https://chatgpt.com/settings/usage). Codex reset credits have not been verified to reset subscription-sharing limits.

## Releasing

```bash
npm version patch   # or minor / major: bumps package.json, commits, and tags
git push --follow-tags
```

Pushing a `v*` tag runs `.github/workflows/publish.yml`. It checks that the tag matches `package.json`, runs the type check and tests, publishes to npm with provenance through npm trusted publishing, and creates a GitHub release with generated notes.
