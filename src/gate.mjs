// One call through Prompter: reserve an estimate, run with model fallback, settle the real neurons.
// Kept apart from worker.mjs so it runs in Node tests. Prompts and answers pass through; nothing is stored.
import { day, chain, bodyFor, meter, DEFAULT_EST } from './policy.mjs';

// One report per id per isolate: a model that's down fails every call, and Cue only needs to hear it once.
const told = new Set();
const once = (publish, e) => (told.has(e.id) ? Promise.resolve() : (told.add(e.id), publish(e)));

export async function run({ app, model, input, est = DEFAULT_EST, ai, ledger, waitUntil, publish = async () => {}, now = Date.now() }) {
  const d = day(now);
  est = Number.isFinite(est) && est > 0 ? Math.min(est, 2000) : DEFAULT_EST;
  const r = await ledger.reserve(app, est, d);
  if (!r.ok) {
    if (r.first) waitUntil(once(publish, { type: 'prompter.budget.refused', id: `budget:${app}:${d}`, data: { app, day: d, spent: Math.round(r.spent) } }));
    throw Object.assign(new Error(`Prompter: today's shared AI allowance for ${app} is used up. It resets at 00:00 UTC.`), { code: 'budget' });
  }
  let last;
  for (const m of chain(model)) {
    let out;
    try { out = await ai.run(m, bodyFor(m, input)); } catch (e) {
      last = e;
      waitUntil(once(publish, { type: 'prompter.model.failed', id: `model:${m}:${new Date(now).toISOString().slice(0, 13)}`.replace(/[^\w.:-]/g, '_'), data: { model: m, app, error: String(e?.message ?? e).slice(0, 160) } }));
      continue;
    }
    if (out instanceof ReadableStream) {
      const [mine, theirs] = out.tee();
      waitUntil(meter(theirs).then((n) => ledger.settle(app, (n ?? est) - est, d, m)).catch(() => {}));
      return mine;
    }
    const n = out?.usage?.neurons;
    waitUntil(ledger.settle(app, (Number.isFinite(n) ? n : est) - est, d, m).catch(() => {}));
    return out;
  }
  await ledger.settle(app, -est, d, null); // nothing ran, give the reservation back
  throw last ?? new Error('Prompter: no model answered');
}
