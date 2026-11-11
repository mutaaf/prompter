# Prompter

The portfolio's AI gateway. Phase 2 of the event architecture ([Cue](https://github.com/mutaaf/cue), docs/ARCHITECTURE.md).

Every app used to bind Workers AI directly and cap itself. The caps added up to far more than the account's
free 10,000 neurons a day, so one busy app could switch AI off for all of them. Now they bind Prompter instead,
with the same `env.AI.run(model, body)` call:

```jsonc
"services": [{ "binding": "AI", "service": "prompter", "props": { "app": "cold-gas" } }]
```

```
app ──env.AI.run()──▶ Prompter ──reserve──▶ Ledger (one Durable Object, today's spend per app)
                          │
                          ├──run, falling back through the model chain──▶ Workers AI
                          ├──stream back untouched; meter the neurons on a copy; settle
                          └──prompter.budget.refused / prompter.model.failed──▶ Cue ──▶ email
```

## The budget

| App | Guaranteed share (neurons a day) |
|---|---|
| cold-gas | 2,800 |
| chalk-talk | 2,500 |
| hearth | 1,500 |
| kin | 1,250 |
| metaphases | 1,250 |
| playbill | 200 (search copy drafts, over HTTP) |
| **Cap** | **9,500** of the 10,000 allowance |

- An app can always spend its own share.
- A busy app may borrow an idle app's unspent share, but only in proportion to how much of the UTC day has
  passed: none at midnight, three quarters by 18:00. Nobody is starved in the morning, and the allowance
  isn't wasted at night.
- Each call reserves an estimate (default 20, or `run(model, body, { est })`), then settles the neurons the
  stream actually reports.
- A refusal throws a plain message, and Cue emails once per app per day. If that email comes most days,
  it's time for Workers Paid.

`GET /prompter/api/health` shows today's spend, calls and refusals per app, and calls per model. Add `?days=7` (2 to 30) for a `history` of each day's counts per app, oldest first, today included. /ensemble/ on mutaafaziz.com reads it live, so keep the shape.

## The HTTP door

For callers that can't hold a service binding (Playbill's search-copy drafting runs in a GitHub Action):

```
POST /prompter/api/run
Authorization: Bearer <token>
{ "messages": [{ "role": "system", "content": "..." }, { "role": "user", "content": "..." }], "max_tokens": 200 }
→ { "ok": true, "app": "playbill", "response": "..." }
```

- The token names the app, the way `props.app` does for a binding. The Worker secret `TOKENS` holds only `sha256(token) → app`; plaintext lives in `~/.config/prompter/tokens` (mode 600). `sh scripts/add-token.sh <app>` makes one; the app needs a share.
- Chat models in the fallback chain only, no streaming, at most 8 messages, 12,000 characters and 400 tokens. Same ledger, shares and fallback as a binding. 429 when the share is spent.

## Rules

- **Nothing is stored.** Prompts and answers pass through. The ledger holds counts only.
- **Bring-your-own-key calls never come here.** A visitor's key stays in the app for that one request.
- **The binding names the app** (`props.app`), so an app can't spend another's share.
- AbortSignal can't cross a service binding, so an app passes no `{ signal }`.

`npm test` (Node 22, no install). `npm run deploy` tests, deploys and checks health.
