(function (QL) {
  'use strict';

  const YEAR_MS = 365.25 * 86400000;

  // Signals are decided at the close of day t and earn day t+1's return, so
  // there is no look-ahead. Costs are charged on turnover at the trade close.
  // opts.stop = { type: 'fixed' | 'trailing', pct } exits at the close that breaches the
  // stop; the strategy then stays flat until its own signal changes.
  function run(data, pos, s, e, opts) {
    const { dates, close } = data;
    const cost = (opts.costBps || 0) / 10000;
    const stop = opts.stop && opts.stop.type !== 'none' && opts.stop.pct > 0 ? opts.stop : null;
    const sp = stop ? stop.pct / 100 : 0;
    const n = e - s + 1;
    const equity = new Array(n);
    const rets = new Array(n);
    const held = new Array(n);
    const target = new Array(n);
    const trades = [];
    let cur = 0, eq = 100, open = null;
    let entryPx = 0, extreme = 0, block = null, stopHit = false;

    for (let k = 0; k < n; k++) {
      const t = s + k;
      const c = close[t];
      const r = k === 0 ? 0 : c / close[t - 1] - 1;
      const before = eq;
      eq *= 1 + cur * r;
      held[k] = cur;

      let want = pos[t];
      if (block !== null) {
        if (want === block) want = 0;
        else block = null;
      }
      stopHit = false;
      if (stop && cur !== 0 && want === cur) {
        extreme = cur > 0 ? Math.max(extreme, c) : Math.min(extreme, c);
        const ref = stop.type === 'trailing' ? extreme : entryPx;
        if (cur > 0 ? c <= ref * (1 - sp) : c >= ref * (1 + sp)) {
          block = pos[t];
          want = 0;
          stopHit = true;
        }
      }

      const turnover = Math.abs(want - cur);
      if (turnover > 0) {
        eq *= 1 - cost * turnover;
        if (open) {
          open.exit = t;
          open.ret = open.side * (c / close[open.entry] - 1) - 2 * cost;
          open.stopped = stopHit;
          trades.push(open);
          open = null;
        }
        if (want !== 0) {
          open = { side: want, entry: t, exit: null, ret: 0 };
          entryPx = extreme = c;
        }
        cur = want;
      }
      target[k] = cur;
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
      target,
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
      out.stops = trades.filter((t) => t.stopped).length;
    }
    return out;
  }

  // Moments of a return series: arithmetic vs geometric mean and fat tails
  // (count of |r - mean| > 3 sd vs the ~0.27% a normal distribution allows).
  function returnStats(r, ppy) {
    const x = r.filter(isFinite);
    const n = x.length;
    if (n < 30) return null;
    const mean = x.reduce((a, b) => a + b, 0) / n;
    const sd = Math.sqrt(x.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1));
    const m4 = x.reduce((a, b) => a + (b - mean) ** 4, 0) / n;
    const geo = Math.exp(x.reduce((a, b) => a + Math.log(1 + b), 0) / n) - 1;
    let tails = 0, worst = 0;
    for (const v of x) {
      if (Math.abs(v - mean) > 3 * sd) tails++;
      if (v < worst) worst = v;
    }
    return {
      n,
      arithAnnual: mean * ppy,
      geoAnnual: Math.pow(1 + geo, ppy) - 1,
      sd,
      kurtosis: sd > 0 ? m4 / sd ** 4 : NaN,
      tails,
      tailsExpected: n * 0.0027,
      worst,
      worstSigma: sd > 0 ? (worst - mean) / sd : NaN,
    };
  }

  // Slope of y on x (beta) and their correlation.
  function beta(y, x) {
    const n = Math.min(x.length, y.length);
    if (n < 30) return null;
    let mx = 0, my = 0;
    for (let i = 0; i < n; i++) { mx += x[i]; my += y[i]; }
    mx /= n; my /= n;
    let cov = 0, vx = 0, vy = 0;
    for (let i = 0; i < n; i++) {
      cov += (x[i] - mx) * (y[i] - my);
      vx += (x[i] - mx) ** 2;
      vy += (y[i] - my) ** 2;
    }
    return { beta: vx > 0 ? cov / vx : NaN, corr: vx > 0 && vy > 0 ? cov / Math.sqrt(vx * vy) : NaN, n };
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

  QL.backtest = { run, drawdown, monthlyReturns, histogram, returnStats, beta };
})((window.QL = window.QL || {}));
