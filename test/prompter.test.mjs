import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide, SHARES, CAP, chain, bodyFor, meter } from '../src/policy.mjs';
import { run } from '../src/gate.mjs';

test('shares add up to the cap, and the cap leaves headroom under the allowance', () => {
  assert.equal(Object.values(SHARES).reduce((a, n) => a + n, 0), CAP);
  assert.ok(CAP < 10000);
});

test('an app inside its share is always allowed, whatever the others did', () => {
  const spend = { kin: 1250, metaphases: 1250, hearth: 1500, 'chalk-talk': 2500 };
  assert.ok(decide(spend, 'cold-gas', 20).ok);
  assert.ok(decide({ ...spend, 'cold-gas': 2980 }, 'cold-gas', 20).ok);
});

const at = (hhmm) => Date.parse(`2026-11-10T${hhmm}:00Z`);
test('a busy app borrows an idle app\'s share only as the day runs out', () => {
  // Cold Gas is past its share and Chalk Talk hasn't started.
  const spend = { 'cold-gas': 3100, kin: 1250, metaphases: 1250, hearth: 1500 };
  assert.equal(decide(spend, 'cold-gas', 20, at('00:30')).reason, 'budget'); // Chalk Talk's morning is protected
  assert.ok(decide(spend, 'chalk-talk', 20, at('00:30')).ok);
  assert.ok(decide(spend, 'cold-gas', 20, at('23:00')).ok); // at night the idle share is lent out
  assert.equal(decide({ 'cold-gas': 5000 }, 'cold-gas', 20, at('00:30')).reason, 'budget');
  assert.ok(decide({ 'cold-gas': 5000 }, 'cold-gas', 20, at('12:00')).ok);
  // and never past the cap, whatever the hour
  assert.equal(decide({ 'cold-gas': 9490 }, 'cold-gas', 20, at('23:59')).reason, 'budget');
});

test('an app that borrowed doesn\'t lose the right to its own share later', () => {
  assert.ok(decide({ 'cold-gas': 7000, kin: 100 }, 'kin', 20, at('23:00')).ok);
  assert.equal(decide({ 'cold-gas': 8300, kin: 1190 }, 'kin', 20, at('23:00')).reason, 'budget'); // cap still binds
});

test('an unknown app gets nothing', () => assert.equal(decide({}, 'stranger').ok, false));

test('the fallback chain starts with the model asked for and strips Gemma-only switches', () => {
  assert.deepEqual(chain('@cf/meta/llama-3.1-8b-instruct-fp8'), ['@cf/meta/llama-3.1-8b-instruct-fp8', '@cf/google/gemma-4-26b-a4b-it']);
  assert.deepEqual(chain('@cf/openai/whisper'), ['@cf/openai/whisper']);
  const b = { messages: [], chat_template_kwargs: { enable_thinking: false } };
  assert.equal(bodyFor('@cf/google/gemma-4-26b-a4b-it', b), b);
  assert.deepEqual(bodyFor('@cf/meta/llama-3.1-8b-instruct-fp8', b), { messages: [] });
});

const sse = (...lines) => new ReadableStream({ start(c) { for (const l of lines) c.enqueue(new TextEncoder().encode(l)); c.close(); } });

test('meter adds the neurons a stream reports, across chunk boundaries', async () => {
  assert.equal(await meter(sse('data: {"response":"hi"}\n', 'data: {"usage":{"neur', 'ons":12.5}}\n', 'data: [DONE]\n')), 12.5);
  assert.equal(await meter(sse('data: {"response":"hi"}\n')), null);
});

function fakeLedger(spend = {}) {
  const calls = [];
  return { calls, spend, reserve: async (app, est) => { const v = decide(spend, app, est); calls.push(['reserve', app, est, v.ok]); if (v.ok) spend[app] = (spend[app] ?? 0) + est; return v.ok ? v : { ...v, first: true, spent: spend[app] ?? 0 }; }, settle: async (app, delta, d, model) => { calls.push(['settle', app, delta, model]); spend[app] += delta; } };
}
const harness = () => { const waits = [], events = []; return { waits, events, waitUntil: (p) => waits.push(p), publish: async (e) => events.push(e) }; };

test('a stream passes through untouched and the real neurons are settled', async () => {
  const h = harness(), ledger = fakeLedger();
  const ai = { run: async () => sse('data: {"response":"hello"}\n', 'data: {"usage":{"neurons":13}}\n', 'data: [DONE]\n') };
  const out = await run({ app: 'cold-gas', model: '@cf/google/gemma-4-26b-a4b-it', input: {}, ai, ledger, ...h });
  assert.match(await new Response(out).text(), /hello/);
  await Promise.all(h.waits);
  assert.equal(ledger.spend['cold-gas'], 13);
});

test('a failing model falls through to the next, and Cue hears once', async () => {
  const h = harness(), ledger = fakeLedger(), tried = [];
  const ai = { run: async (m, body) => { tried.push([m, body]); if (m.includes('gemma')) throw new Error('3040: capacity'); return { response: 'ok', usage: { neurons: 4 } }; } };
  const input = { messages: [], chat_template_kwargs: { enable_thinking: false } };
  const out = await run({ app: 'hearth', model: '@cf/google/gemma-4-26b-a4b-it', input, ai, ledger, ...h });
  assert.equal(out.response, 'ok');
  assert.deepEqual(tried[1][1], { messages: [] });
  await run({ app: 'hearth', model: '@cf/google/gemma-4-26b-a4b-it', input, ai, ledger, ...h, now: Date.parse('2026-01-01T05:00:00Z') });
  await run({ app: 'hearth', model: '@cf/google/gemma-4-26b-a4b-it', input, ai, ledger, ...h, now: Date.parse('2026-01-01T05:30:00Z') });
  await Promise.all(h.waits);
  assert.equal(h.events.filter((e) => e.id === 'model:_cf_google_gemma-4-26b-a4b-it:2026-01-01T05').length, 1);
  assert.equal(ledger.spend.hearth, 12);
});

test('when every model fails the reservation is returned and the error surfaces', async () => {
  const h = harness(), ledger = fakeLedger();
  const ai = { run: async () => { throw new Error('down'); } };
  await assert.rejects(run({ app: 'kin', model: '@cf/google/gemma-4-26b-a4b-it', input: {}, ai, ledger, ...h }), /down/);
  assert.equal(ledger.spend.kin, 0);
});

test('over budget: refused with a plain reason, the model is never called, Cue is told', async () => {
  const h = harness(), ledger = fakeLedger({ 'cold-gas': 9500 });
  const ai = { run: async () => assert.fail('must not run') };
  await assert.rejects(run({ app: 'cold-gas', model: 'x', input: {}, ai, ledger, ...h }), (e) => e.code === 'budget' && /resets at 00:00 UTC/.test(e.message));
  await Promise.all(h.waits);
  assert.equal(h.events[0].type, 'prompter.budget.refused');
  assert.deepEqual(Object.keys(h.events[0].data), ['app', 'day', 'spent']);
});
