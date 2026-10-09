(function (QL) {
  'use strict';

  const YEAR_MS = 365.25 * 86400000;

  // Signals are decided at the close of day t and earn day t+1's return, so
  // there is no look-ahead. Costs are charged on turnover at the trade close.
  function run(data, pos, s, e, opts) {
    const { dates, close } = data;
    const cost = (opts.costBps || 0) / 10000;
    const n = e - s + 1;
    const equity = new Array(n);
    const rets = new Array(n);
    const held = new Array(n);
    const trades = [];
    let cur = 0, eq = 100, open = null;

    for (let k = 0; k < n; k++) {
      const t = s + k;
      const r = k === 0 ? 0 : close[t] / close[t - 1] - 1;
      const before = eq;
      eq *= 1 + cur * r;
      held[k] = cur;
      const target = pos[t];
      const turnover = Math.abs(target - cur);
      if (turnover > 0) {
        eq *= 1 - cost * turnover;
        if (open) {
          open.exit = t;
          open.ret = open.side * (close[t] / close[open.entry] - 1) - 2 * cost;
          trades.push(open);
          open = null;
        }
        if (target !== 0) open = { side: target, entry: t, exit: null, ret: 0 };
        cur = target;
      }
      equity[k] = eq;
      rets[k] = eq / before - 1;
    }
    if (open) {
      open.ret = open.side * (close[e] / close[open.entry] - 1) - cost;
      open.openEnd = true;
      trades.push(open);
    }

    const bench = new Array(n);
    const benchRets = new Array(n);
    for (let k = 0; k < n; k++) {
      bench[k] = (100 * close[s + k]) / close[s];
      benchRets[k] = k === 0 ? 0 : close[s + k] / close[s + k - 1] - 1;
    }

    const times = dates.slice(s, e + 1);
    return {
      times,
      equity,
      rets,
      held,
      trades,
      bench,
      benchRets,
      metrics: metrics(times, equity, rets, held, trades, opts.rf || 0),
      benchMetrics: metrics(times, bench, benchRets, null, null, opts.rf || 0),
    };
  }

  function drawdown(eq) {
    let peak = -Infinity;
    return eq.map((v) => {
      peak = Math.max(peak, v);
      return v / peak - 1;
    });
  }

  function metrics(times, equity, rets, held, trades, rfPct) {
    const n = equity.length;
    const years = Math.max((times[n - 1] - times[0]) / YEAR_MS, 1 / 365);
    const ppy = (n - 1) / years;
    const total = equity[n - 1] / 100 - 1;
    const cagr = Math.pow(equity[n - 1] / 100, 1 / years) - 1;

    const r = rets.slice(1);
    const mean = r.reduce((a, b) => a + b, 0) / Math.max(r.length, 1);
    const variance = r.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(r.length - 1, 1);
    const sd = Math.sqrt(variance);
    const rfDaily = rfPct / 100 / ppy;
    const down = Math.sqrt(r.reduce((a, b) => a + Math.min(b - rfDaily, 0) ** 2, 0) / Math.max(r.length, 1));
    const vol = sd * Math.sqrt(ppy);
    const sharpe = sd > 0 ? ((mean - rfDaily) / sd) * Math.sqrt(ppy) : 0;
    const sortino = down > 0 ? ((mean - rfDaily) / down) * Math.sqrt(ppy) : 0;
    const dd = drawdown(equity);
    const maxDD = Math.min(...dd);
    const calmar = maxDD < 0 ? cagr / -maxDD : 0;

    const out = { total, cagr, vol, sharpe, sortino, maxDD, calmar, years };
    if (trades) {
      const closed = trades.filter((t) => !t.openEnd);
      const wins = closed.filter((t) => t.ret > 0);
      const grossWin = wins.reduce((a, t) => a + t.ret, 0);
      const grossLoss = closed.filter((t) => t.ret <= 0).reduce((a, t) => a - t.ret, 0);
      out.trades = trades.length;
      out.winRate = closed.length ? wins.length / closed.length : NaN;
      out.profitFactor = grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : NaN;
      out.exposure = held.filter((h) => h !== 0).length / Math.max(held.length - 1, 1);
    }
    return out;
  }

  function monthlyReturns(times, equity) {
    const rows = new Map();
    let prevEnd = 100;
    let curKey = null, lastVal = null;
    const flush = () => {
      if (curKey === null) return;
      const [y, m] = curKey;
      if (!rows.has(y)) rows.set(y, { year: y, months: new Array(12).fill(null), start: prevEnd, end: null });
      const row = rows.get(y);
      row.months[m] = lastVal / prevEnd - 1;
      row.end = lastVal;
      prevEnd = lastVal;
    };
    for (let i = 0; i < times.length; i++) {
      const d = new Date(times[i]);
      const y = d.getUTCFullYear(), m = d.getUTCMonth();
      if (!curKey || curKey[0] !== y || curKey[1] !== m) {
        flush();
        curKey = [y, m];
      }
      lastVal = equity[i];
    }
    flush();
    return [...rows.values()].map((r) => ({ year: r.year, months: r.months, total: r.end / r.start - 1 }));
  }

  function histogram(values, binCount) {
    const v = values.filter(isFinite).slice().sort((a, b) => a - b);
    if (!v.length) return [];
    const q = (p) => v[Math.min(v.length - 1, Math.max(0, Math.round(p * (v.length - 1))))];
    const lim = Math.max(Math.abs(q(0.005)), Math.abs(q(0.995)), 1e-6);
    const w = (2 * lim) / binCount;
    const bins = Array.from({ length: binCount }, (_, i) => ({ x0: -lim + i * w, x1: -lim + (i + 1) * w, count: 0 }));
    for (const x of v) {
      const i = Math.min(binCount - 1, Math.max(0, Math.floor((x + lim) / w)));
      bins[i].count++;
    }
    bins.total = v.length;
    return bins;
  }

  QL.backtest = { run, drawdown, monthlyReturns, histogram };
})((window.QL = window.QL || {}));
