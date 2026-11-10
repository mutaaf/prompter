// The shared Workers AI allowance: 10,000 neurons a day for the whole account, reset at 00:00 UTC.
// Every app has a guaranteed share. A busy app may borrow past its share, but an idle app's unspent share
// stays protected in proportion to how much of the UTC day is left: all of it at midnight, a quarter at 18:00.
// So nobody is starved in the morning, and the allowance isn't left unused at night. CAP keeps 500 neurons back for slop in the estimates.
export const ALLOWANCE = 10000;
export const CAP = 9500;
export const SHARES = { 'cold-gas': 3000, 'chalk-talk': 2500, hearth: 1500, kin: 1250, metaphases: 1250 };
export const DEFAULT_EST = 20; // neurons; a judging is ~13, a Hearth insight ~17

export const day = (now = Date.now()) => new Date(now).toISOString().slice(0, 10);

const left = (now) => 1 - ((now % 864e5) / 864e5);

/** spend: { app: neurons } for today. */
export function decide(spend, app, est = DEFAULT_EST, now = Date.now()) {
  if (!Object.hasOwn(SHARES, app)) return { ok: false, reason: `${app} has no share` };
  const total = Object.values(spend).reduce((a, n) => a + n, 0);
  const held = Object.entries(SHARES).reduce((a, [o, share]) => (o === app ? a : a + Math.max(0, Math.min(share - (spend[o] ?? 0), share * left(now)))), 0);
  const mine = spend[app] ?? 0;
  if (mine + est <= SHARES[app] && total + est <= CAP + 1e-9) return { ok: true }; // inside its own share
  if (total + est + held > CAP) return { ok: false, reason: 'budget' };
  return { ok: true };
}

// Chat models in the order to fall back through. All speak the same streaming format.
export const CHAT_CHAIN = ['@cf/google/gemma-4-26b-a4b-it', '@cf/meta/llama-3.1-8b-instruct-fp8'];

/** The models to try for a request: the one asked for, then the rest of the chain after it. */
export function chain(model) {
  const i = CHAT_CHAIN.indexOf(model);
  return i < 0 ? [model] : CHAT_CHAIN.slice(i).concat(CHAT_CHAIN.slice(0, i));
}

/** A request body fit for a given model: thinking switches are Gemma/Qwen/GLM-only. */
export function bodyFor(model, body) {
  if (!body || typeof body !== 'object' || /gemma-4|qwen3|glm/.test(model)) return body;
  const { chat_template_kwargs, ...rest } = body;
  return rest;
}

/** Sum the neurons reported in a Workers AI SSE stream (usage arrives near the end). */
export async function meter(stream) {
  const reader = stream.getReader(), dec = new TextDecoder();
  let buf = '', neurons = 0, seen = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      try { const j = JSON.parse(line.slice(5)); if (j.usage?.neurons) { neurons += j.usage.neurons; seen = true; } } catch { /* [DONE] and partials */ }
    }
  }
  return seen ? neurons : null;
}
