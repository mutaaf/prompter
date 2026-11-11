# Prompter: working notes

Read README.md first.

| Nuance | What to do |
|---|---|
| `cloudflare:workers` can't load in Node tests | Logic lives in `src/policy.mjs` and `src/gate.mjs`; `worker.mjs` is a thin wrapper. |
| AbortSignal isn't serialisable over RPC | Apps drop `{ signal }` when they move to Prompter. Only `{ est }` crosses. |
| Metering a stream | `tee()` it: the app gets one branch untouched, `waitUntil` meters the other and settles. |
| Llama rejects Gemma's `chat_template_kwargs` | `bodyFor()` strips it when the fallback lands on a model that doesn't take it. |
| A down model fails every call | `once()` in gate.mjs tells Cue once per model per hour per isolate. |
| Changing shares | Edit `SHARES` in policy.mjs; the test checks they still sum to `CAP`. |
| Logging | One `{service, event, ms, ok}` line per call and request, from [stagehand](https://github.com/mutaaf/stagehand) (GitHub dependency): `npm ci` first. Only app and model are logged, never prompts or answers. |

## Definition of done

- `npm test` passes (CI runs `npm run check` on every PR; main is protected).
- Shares still sum to CAP (a test enforces it); a new app gets its share in the same PR that binds it.
- `npm run deploy`, then `/prompter/api/health` shows the change.
- A new way this broke goes in `docs/LESSONS.md`, and in a test if a test can catch it.
