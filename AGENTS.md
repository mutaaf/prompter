# Agents

- Never log or store prompts, answers, IPs or keys. The ledger holds counts.
- Shares must sum to CAP, and CAP stays under the 10,000 allowance (a test enforces both).
- A new app gets a share in policy.mjs in the same PR that binds it.
- `npm test` must pass. CI runs `npm run check` on every PR.
