# Lessons

| What happened | Why | What changed |
|---|---|---|
| A live probe was charged 0.8 neurons for calls Workers AI reported at 0.59 | A stream can report usage more than once, cumulatively; summing double-counts | `meter()` keeps the last report (tested), and the five apps' own parsers were fixed the same way |
| An app with no share was told "today's allowance is used up" | Every refusal used the budget message | A missing share has its own message and code (tested) |
| Cold Gas passed `{ signal }` to `env.AI.run` | An AbortSignal can't cross a service binding | Apps cancel the stream on their side; only `{ est }` crosses |
| My migration commit in Cold Gas swept in another agent's unfinished change | That agent was working in the same checkout and switched branches under me | Cross-repo changes are made in a fresh `git worktree` of origin/main, never the main checkout |
| CI would have failed to resolve `stagehand` | The first runtime dependency arrived, and CI ran `npm run check` without installing anything | CI runs `npm ci` against a committed package-lock.json; `npm run deploy` installs first |
