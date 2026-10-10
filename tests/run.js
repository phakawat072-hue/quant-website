#!/usr/bin/env node
// Self-contained checks for the site's math and data files. No dependencies:
//   node tests/run.js
// Runs on every push and pull request (.github/workflows/test.yml).
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
global.window = {};
for (const f of ['js/data.js', 'js/strategies.js', 'js/backtest.js', 'js/portfolio.js', 'js/glossary.js']) require(path.join(ROOT, f));
const QL = window.QL;
global.QL = QL;
const BT = QL.backtest, P = QL.portfolio, S = QL.strategies;

let passed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed++; } catch (err) { failures.push(name + '\n    ' + (err && err.message)); }
}
const near = (a, b, tol, msg) => assert(Math.abs(a - b) <= tol, (msg || '') + ` expected ${b}, got ${a}`);

// Deterministic data: the site's simulator with a fixed seed.
const sim = QL.data.simulate(QL.data.ASSETS[0], 42);
const N = sim.close.length;
const flat = sim.close.map(() => 0), long = sim.close.map(() => 1);

// ---------- indicators and strategies ----------
test('sma matches a hand calculation', () => {
  const v = S.sma([1, 2, 3, 4, 5], 3);
  assert(isNaN(v[1]));
  assert.deepStrictEqual(v.slice(2), [2, 3, 4]);
});

test('every strategy is free of look-ahead', () => {
  const cut = Math.floor(N * 0.6);
  for (const [k, strat] of Object.entries(S.STRATEGIES)) {
    for (const short of [false, true]) {
      const p = S.defaults(k);
      const a = strat.signal(sim.close, p, short, sim.dates);
      const changed = sim.close.map((c, i) => (i > cut ? c * (1 + 0.3 * Math.sin(i)) : c));
      const b = strat.signal(changed, p, short, sim.dates);
      // Calendar rules may look at tomorrow's date (known in advance), never at tomorrow's price.
      for (let i = 0; i < cut; i++) assert.strictEqual(a[i], b[i], `${k} short=${short} day ${i} depends on later prices`);
      for (const x of a) assert([-1, 0, 1].includes(x), `${k} returned ${x}`);
    }
  }
});

// ---------- backtest engine ----------
test('flat position keeps equity at 100', () => {
  const r = BT.run(sim, flat, 0, N - 1, { costBps: 5, rf: 2 });
  near(r.equity[N - 1], 100, 1e-9);
});

test('always long with no costs equals Buy & Hold', () => {
  const r = BT.run(sim, long, 10, N - 1, { costBps: 0 });
  near(r.equity[r.equity.length - 1], r.bench[r.bench.length - 1], 1e-6);
});

test('costs only reduce returns', () => {
  const pos = S.STRATEGIES.sma.signal(sim.close, S.defaults('sma'), false, sim.dates);
  const a = BT.run(sim, pos, 0, N - 1, { costBps: 0 }), b = BT.run(sim, pos, 0, N - 1, { costBps: 20 });
  assert(b.metrics.total < a.metrics.total);
});

test('idle cash earns exactly the risk-free rate', () => {
  const r = BT.run(sim, flat, 0, N - 1, { rf: 4, cash: true });
  near(r.metrics.cagr, 0.04, 1e-6);
});

test('stop-loss never lets a trade lose far beyond the stop', () => {
  const r = BT.run(sim, long, 0, N - 1, { costBps: 0, stop: { type: 'fixed', pct: 10 } });
  for (const t of r.trades) if (t.stopped) assert(t.ret > -0.25, 'stopped trade lost ' + t.ret);
});

test('vol targeting lowers volatility and stays within [0, 1]', () => {
  const size = BT.volScale(sim.close, 10, 20, 252);
  assert(size.every((v) => isNaN(v) || (v > 0 && v <= 1)));
  const a = BT.run(sim, long, 30, N - 1, {}), b = BT.run(sim, long, 30, N - 1, { size });
  assert(b.metrics.vol < a.metrics.vol);
});

test('one-day delay shifts trades by one day', () => {
  const pos = S.STRATEGIES.sma.signal(sim.close, S.defaults('sma'), false, sim.dates);
  const a = BT.run(sim, pos, 0, N - 1, {}), b = BT.run(sim, pos, 0, N - 1, { delay: 1 });
  assert.strictEqual(b.trades[0].entry, a.trades[0].entry + 1);
});

test('VaR, CVaR and drawdown duration are consistent', () => {
  const m = BT.run(sim, long, 0, N - 1, {}).benchMetrics;
  assert(m.var95 > 0 && m.cvar95 >= m.var95 && m.ddDays > 0);
});

test('bootstrap is deterministic and brackets the sample Sharpe', () => {
  const r = BT.run(sim, long, 0, N - 1, {});
  const a = BT.bootstrap(r.benchRets.slice(1), 252), b = BT.bootstrap(r.benchRets.slice(1), 252);
  assert.deepStrictEqual(a, b);
  assert(a.sharpe[0] < a.sharpe[1] && a.sharpe[1] < a.sharpe[2]);
});

test('walk-forward picks the better candidate and stitches every test day', () => {
  const up = { dates: sim.dates, close: sim.dates.map((_, i) => 100 * Math.pow(1.0006, i)) };
  const w = BT.walkForward(up, [{ pos: flat }, { pos: long }], 0, N - 1, { costBps: 0 }, 504, 252);
  assert(w.folds.every((f) => f.best === 1));
  assert.strictEqual(w.times.length, N - 504);
});

test('deflated Sharpe discounts the best of many noise strategies', () => {
  let s = 7;
  const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
  const gauss = () => Math.sqrt(-2 * Math.log(rnd())) * Math.cos(2 * Math.PI * rnd());
  const trials = [];
  let best = null, bestS = -Infinity;
  for (let k = 0; k < 50; k++) {
    const r = Array.from({ length: 756 }, () => 0.01 * gauss());
    const m = r.reduce((a, b) => a + b) / r.length;
    const sd = Math.sqrt(r.reduce((a, b) => a + (b - m) ** 2, 0) / (r.length - 1));
    const sh = (m / sd) * Math.sqrt(252);
    trials.push(sh);
    if (sh > bestS) { bestS = sh; best = r; }
  }
  const d = BT.deflatedSharpe(best, 252, trials, 0);
  assert(d.dsr < d.psr && d.dsr < 0.95);
});

test('normal CDF and its inverse agree', () => {
  for (const p of [0.001, 0.05, 0.5, 0.95, 0.999]) near(BT.normCdf(BT.normInv(p)), p, 2e-6);
  near(BT.normInv(0.975), 1.959964, 1e-5);
});

test('parameter grids include the default and respect bounds', () => {
  for (const [k, strat] of Object.entries(S.STRATEGIES)) {
    for (const d of strat.params) {
      const g = BT.gridValues(d);
      assert(g.length >= 3, k + '.' + d.key + ' grid too small');
      assert(g.every((v) => v >= d.min && v <= d.max), k + '.' + d.key + ' out of bounds');
    }
  }
});

// ---------- portfolio ----------
test('simplex projection is long-only and fully invested', () => {
  const w = P.projSimplex([0.5, 0.8, -1]);
  near(w.reduce((a, b) => a + b, 0), 1, 1e-12);
  assert(w.every((x) => x >= 0));
});

test('minimum variance matches the two-asset formula', () => {
  const s1 = 0.2, s2 = 0.3, c = 0.2 * s1 * s2;
  const w = P.minQuad([[s1 * s1, c], [c, s2 * s2]], [0.1, 0.1], 0, null, 2000);
  near(w[0], (s2 * s2 - c) / (s1 * s1 + s2 * s2 - 2 * c), 1e-4);
});

test('perfectly opposite assets split 50/50 (Hatfields and McCoys, Paulos p. 151)', () => {
  const w = P.minQuad([[0.09, -0.09], [-0.09, 0.09]], [0.1, 0.1], 0, null, 2000);
  near(w[0], 0.5, 1e-4);
});

test('efficient frontier returns rise and end at the best asset', () => {
  const cov = [[0.04, 0.012], [0.012, 0.09]];
  const f = P.frontier(cov, [0.05, 0.15], 20, 400);
  for (let i = 1; i < f.length; i++) assert(f[i].ret >= f[i - 1].ret - 1e-9);
  assert(f[f.length - 1].w[1] > 0.99);
});

test('buy-and-hold portfolio matches the closed form', () => {
  const n = 400, dates = [], R = [[], []];
  for (let t = 0; t < n; t++) {
    dates.push(Date.UTC(2020, 0, 1) + t * 86400000 * 1.4);
    R[0].push(t ? 0.001 : 0);
    R[1].push(t ? -0.0005 : 0);
  }
  const bt = P.backtest(dates, R, 0, n - 1, { method: 'equal', rebalance: null, costBps: 0 });
  near(bt.equity[n - 1], 100 * (0.5 * Math.pow(1.001, n - 1) + 0.5 * Math.pow(0.9995, n - 1)), 1e-6);
});

test('signal portfolios pick the right stocks', () => {
  const n = 500, R = [[], [], [], []];
  for (let t = 0; t < n; t++) { const s = t ? 1 : 0; R[0].push(s * 0.001); R[1].push(s * 0.0008); R[2].push(s * -0.001); R[3].push(s * -0.0007); }
  const idx = R.map((r) => { let v = 1; return r.map((x) => (v *= 1 + x)); });
  assert.deepStrictEqual(P.signalWeights('trend', idx, 400), [0.25, 0.25, 0, 0]);
  assert.deepStrictEqual(P.signalWeights('momentum', idx, 400), [0.5, 0.5, 0, 0]);
  const ctx = {
    tickers: ['A', 'B', 'C', 'D'], dates: R[0].map((_, t) => t), close: idx,
    fundAt: (tk) => ({ A: { eps: 0.01, dps: 0 }, B: { eps: 0.1, dps: 0.05 }, C: { eps: -1, dps: 0.02 }, D: { eps: 0.05, dps: 0 } })[tk],
  };
  const v = P.signalWeights('value', idx, 400, ctx);
  assert.strictEqual(v[1], 0.5); assert.strictEqual(v[3], 0.5); assert.strictEqual(v[2], 0);
  const dv = P.signalWeights('dividend', idx, 400, ctx);
  assert.strictEqual(dv[1], 1); assert.strictEqual(dv[0], 0);
});

test('method walk-forward only uses past Sharpe', () => {
  const n = 1200, times = Array.from({ length: n }, (_, i) => i);
  const good = Array.from({ length: n }, (_, i) => (i ? 0.001 + 0.002 * Math.sin(i) : 0));
  const bad = Array.from({ length: n }, (_, i) => (i ? -0.001 + 0.002 * Math.sin(i) : 0));
  const wf = P.methodWalkForward(times, { a: { rets: bad }, b: { rets: good } });
  assert(wf.folds.every((f) => f.pick === 'b'));
  assert.strictEqual(wf.rets.length, wf.times.length);
});

// ---------- data files ----------
test('price manifest lists files that decode', () => {
  require(path.join(ROOT, 'data/prices/index.js'));
  const m = QL.data.getManifest();
  assert(m && m.tickers.length >= 40);
  for (const t of m.tickers) {
    const file = path.join(ROOT, 'data/prices', t.ticker + '.js');
    assert(fs.existsSync(file), 'missing ' + file);
  }
  require(path.join(ROOT, 'data/prices', m.tickers[0].ticker + '.js'));
});

test('fundamentals are point-in-time and well formed', () => {
  require(path.join(ROOT, 'data/fundamentals.js'));
  const f = QL.data.getFundamentals();
  assert(f && Object.keys(f.t).length >= 20);
  for (const [tk, rows] of Object.entries(f.t)) {
    let prev = '';
    for (const r of rows) {
      assert.strictEqual(r.length, 5, tk);
      assert(r[0] >= r[1], tk + ' filed before fiscal year end');
      assert(r[0] >= prev, tk + ' rows out of order');
      prev = r[0];
    }
  }
  const rows = QL.data.fundRows('AAPL');
  const i = rows.findIndex((r, k) => k > 0 && r.filed > rows[k - 1].filed);
  const at = QL.data.fundAt('AAPL', rows[i].filed - 86400000);
  assert.strictEqual(at.end, rows[i - 1].end, 'fundAt must not see a report before its filing date');
  assert.strictEqual(QL.data.fundAt('AAPL', rows[i].filed).end, rows[i].end);
});

test('glossary entries are complete', () => {
  for (const t of QL.glossaryView.TERMS) assert(t[0] && t[1] && t[2], 'empty glossary entry ' + t[0]);
});

// ---------- report ----------
console.log(`${passed} passed, ${failures.length} failed`);
for (const f of failures) console.log('FAIL ' + f);
process.exit(failures.length ? 1 : 0);
