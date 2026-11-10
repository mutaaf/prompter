// Prompter: the portfolio's AI gateway. Apps bind it in place of Workers AI:
//   "services": [{ "binding": "AI", "service": "prompter", "props": { "app": "cold-gas" } }]
// and keep calling env.AI.run(model, body). The binding's props name the app, so an app can't spend another's share.
import { WorkerEntrypoint, DurableObject } from 'cloudflare:workers';
import { decide, day, CAP, ALLOWANCE, SHARES } from './policy.mjs';
import { run } from './gate.mjs';

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
}

const json = (b, s = 200) => new Response(JSON.stringify(b, null, 1), { status: s, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
const ledger = (env) => env.LEDGER.get(env.LEDGER.idFromName('account'));

export default class Prompter extends WorkerEntrypoint {
  // Drop-in for the Workers AI binding's run(). The third argument may carry { est } (neurons) and nothing else.
  async run(model, input, opts = {}) {
    const app = this.ctx.props?.app;
    if (!app) throw new Error('Prompter: this binding has no props.app');
    return run({
      app, model, input, est: opts?.est, ai: this.env.AI, ledger: ledger(this.env),
      waitUntil: (p) => this.ctx.waitUntil(p),
      publish: (e) => this.env.CUE?.publish(e).catch(() => {}) ?? Promise.resolve(),
    });
  }

  async today() { return { day: day(), cap: CAP, allowance: ALLOWANCE, shares: SHARES, ...(await ledger(this.env).today(day())) }; }

  async fetch(req) {
    const path = new URL(req.url).pathname.replace(/\/+$/, '');
    if (path === '/prompter/api/health') return json({ ok: true, service: 'prompter', ...(await this.today()) });
    return json({ ok: false, error: 'not found' }, 404);
  }
}
