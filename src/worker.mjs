// Prompter: the portfolio's AI gateway. Apps bind it in place of Workers AI:
//   "services": [{ "binding": "AI", "service": "prompter", "props": { "app": "cold-gas" } }]
// and keep calling env.AI.run(model, body). The binding's props name the app, so an app can't spend another's share.
import { WorkerEntrypoint, DurableObject } from 'cloudflare:workers';
import { decide, day, days, CAP, ALLOWANCE, SHARES } from './policy.mjs';
import { run } from './gate.mjs';
import { log, timed } from 'stagehand';
import { appForToken, chatRequest, textOf } from './http.mjs';

export class Ledger extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec('CREATE TABLE IF NOT EXISTS spend (day TEXT NOT NULL, app TEXT NOT NULL, neurons REAL NOT NULL DEFAULT 0, calls INTEGER NOT NULL DEFAULT 0, refused INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, app))');
    this.sql.exec('CREATE TABLE IF NOT EXISTS models (day TEXT NOT NULL, model TEXT NOT NULL, calls INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, model))');
  }
  spend(d) { return Object.fromEntries(this.sql.exec('SELECT app, neurons FROM spend WHERE day = ?', d).toArray().map((r) => [r.app, r.neurons])); }
  reserve(app, est, d) {
    const spend = this.spend(d), v = decide(spend, app, est, Date.now());
    if (!v.ok && !Object.hasOwn(SHARES, app)) return v;
    if (!v.ok) {
      const before = this.sql.exec('SELECT refused FROM spend WHERE day = ? AND app = ?', d, app).toArray()[0]?.refused ?? 0;
      this.sql.exec('INSERT INTO spend (day, app, refused) VALUES (?, ?, 1) ON CONFLICT(day, app) DO UPDATE SET refused = refused + 1', d, app);
      return { ...v, first: before === 0, spent: spend[app] ?? 0 };
    }
    this.sql.exec('INSERT INTO spend (day, app, neurons, calls) VALUES (?, ?, ?, 1) ON CONFLICT(day, app) DO UPDATE SET neurons = neurons + excluded.neurons, calls = calls + 1', d, app, est);
    return v;
  }
  settle(app, delta, d, model) {
    this.sql.exec('UPDATE spend SET neurons = MAX(0, neurons + ?) WHERE day = ? AND app = ?', delta, d, app);
    if (model) this.sql.exec('INSERT INTO models (day, model, calls) VALUES (?, ?, 1) ON CONFLICT(day, model) DO UPDATE SET calls = calls + 1', d, model);
  }
  today(d) {
    this.sql.exec('DELETE FROM spend WHERE day < ?', day(Date.now() - 30 * 864e5));
    this.sql.exec('DELETE FROM models WHERE day < ?', day(Date.now() - 30 * 864e5));
    return { apps: this.sql.exec('SELECT app, ROUND(neurons, 1) AS neurons, calls, refused FROM spend WHERE day = ?', d).toArray(), models: this.sql.exec('SELECT model, calls FROM models WHERE day = ?', d).toArray() };
  }
  // Counts per app for each of the last n UTC days, oldest first, today included. Same counts as today(), nothing more.
  history(n) {
    const ds = Array.from({ length: n }, (_, i) => day(Date.now() - (n - 1 - i) * 864e5));
    const rows = this.sql.exec('SELECT day, app, ROUND(neurons, 1) AS neurons, calls, refused FROM spend WHERE day >= ?', ds[0]).toArray();
    return ds.map((d) => ({ day: d, apps: rows.filter((r) => r.day === d).map(({ day: _, ...r }) => r) }));
  }
}

const json = (b, s = 200) => new Response(JSON.stringify(b, null, 1), { status: s, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
const ledger = (env) => env.LEDGER.get(env.LEDGER.idFromName('account'));

export default class Prompter extends WorkerEntrypoint {
  // Drop-in for the Workers AI binding's run(). The third argument may carry { est } (neurons) and nothing else.
  async run(model, input, opts = {}) {
    const app = this.ctx.props?.app;
    if (!app) throw new Error('Prompter: this binding has no props.app');
    // One log line per call: app, model, ms, ok. Never the prompt or the answer.
    return timed('prompter', 'run', () => run({
      app, model, input, est: opts?.est, ai: this.env.AI, ledger: ledger(this.env),
      waitUntil: (p) => this.ctx.waitUntil(p),
      publish: (e) => this.env.CUE?.publish(e).catch(() => {}) ?? Promise.resolve(),
    }), { app, model: String(model).slice(0, 80) });
  }

  async today() { return { day: day(), cap: CAP, allowance: ALLOWANCE, shares: SHARES, ...(await ledger(this.env).today(day())) }; }

  async fetch(req) {
    const t = Date.now();
    let res;
    try { res = await this.route(req); } catch (e) { log('prompter', 'request', { method: req.method, ms: Date.now() - t, ok: false, error: String(e?.message ?? e).slice(0, 200) }); throw e; }
    log('prompter', 'request', { method: req.method, route: res.status === 404 ? 'unmatched' : new URL(req.url).pathname.replace(/\/+$/, ''), status: res.status, ms: Date.now() - t, ok: res.status < 500 });
    return res;
  }

  async route(req) {
    const url = new URL(req.url), path = url.pathname.replace(/\/+$/, '');
    if (path === '/prompter/api/health') {
      const n = days(url.searchParams.get('days'));
      return json({ ok: true, service: 'prompter', ...(await this.today()), ...(n ? { history: await ledger(this.env).history(n) } : {}) });
    }
    if (path === '/prompter/api/run' && req.method === 'POST') return this.http(req);
    return json({ ok: false, error: 'not found' }, 404);
  }

  // POST /prompter/api/run with Authorization: Bearer <token>. The token names the app (TOKENS secret holds
  // only hashes); the same ledger, shares and fallback apply. Prompts and answers pass through, never kept.
  async http(req) {
    const app = await appForToken(this.env.TOKENS, req.headers.get('authorization'));
    if (!app) return json({ ok: false, error: 'a valid token is required' }, 401);
    let body; try { body = await req.json(); } catch { return json({ ok: false, error: 'the body must be JSON' }, 400); }
    const r = chatRequest(body);
    if (r.error) return json({ ok: false, error: r.error }, 400);
    try {
      const out = await timed('prompter', 'run', () => run({ app, model: r.model, input: r.input, est: 40, ai: this.env.AI, ledger: ledger(this.env), waitUntil: (p) => this.ctx.waitUntil(p), publish: (e) => this.env.CUE?.publish(e).catch(() => {}) ?? Promise.resolve() }), { app, model: r.model, via: 'http' });
      return json({ ok: true, app, response: textOf(out) });
    } catch (e) {
      return json({ ok: false, error: String(e?.message ?? e).slice(0, 200) }, e?.code === 'budget' ? 429 : e?.code === 'no-share' ? 403 : 502);
    }
  }
}
