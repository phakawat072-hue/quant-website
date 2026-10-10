(function (QL) {
  'use strict';

  const YEAR_MS = 365.25 * 86400000;

  // Signals are decided at the close of day t and earn day t+1's return, so
  // there is no look-ahead. Costs are charged on turnover at the trade close.
  // opts.stop = { type: 'fixed' | 'trailing', pct } exits at the close that breaches the
  // stop; the strategy then stays flat until its own signal changes.
  // Optional realism: opts.delay = 1 trades one close later; opts.size[t] in [0, 1] scales the
  // position (volatility targeting); opts.cash earns opts.rf on uninvested capital; opts.borrowPct
  // is the yearly cost of short exposure.
  function run(data, pos, s, e, opts) {
    const { dates, close } = data;
    const cost = (opts.costBps || 0) / 10000;
    const stop = opts.stop && opts.stop.type !== 'none' && opts.stop.pct > 0 ? opts.stop : null;
    const sp = stop ? stop.pct / 100 : 0;
    const sig = opts.delay ? pos.map((_, t) => (t > 0 ? pos[t - 1] : 0)) : pos;
    const size = opts.size || null;
    const rfA = opts.cash ? (opts.rf || 0) / 100 : 0;
    const borrowA = (opts.borrowPct || 0) / 100;
    const n = e - s + 1;
    const equity = new Array(n);
    const rets = new Array(n);
    const held = new Array(n);
    const target = new Array(n);
    const trades = [];
    let cur = 0, expo = 0, eq = 100, open = null;
    let entryPx = 0, extreme = 0, block = null, stopHit = false;

    for (let k = 0; k < n; k++) {
      const t = s + k;
      const c = close[t];
      const r = k === 0 ? 0 : c / close[t - 1] - 1;
      const dtY = k === 0 ? 0 : (dates[t] - dates[t - 1]) / YEAR_MS;
      const before = eq;
      eq *= 1 + expo * r;
      if (rfA && dtY) eq *= 1 + (1 - Math.min(Math.abs(expo), 1)) * (Math.pow(1 + rfA, dtY) - 1);
      if (borrowA && expo < 0) eq *= 1 + expo * borrowA * dtY;
      held[k] = expo;

      let want = sig[t];
      if (block !== null) {
        if (want === block) want = 0;
        else block = null;
      }
      stopHit = false;
      if (stop && cur !== 0 && want === cur) {
        extreme = cur > 0 ? Math.max(extreme, c) : Math.min(extreme, c);
        const ref = stop.type === 'trailing' ? extreme : entryPx;
        if (cur > 0 ? c <= ref * (1 - sp) : c >= ref * (1 + sp)) {
          block = sig[t];
          want = 0;
          stopHit = true;
        }
      }

      if (want !== cur) {
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
      const next = cur * (size && isFinite(size[t]) ? size[t] : 1);
      const turnover = Math.abs(next - expo);
      if (turnover > 0) eq *= 1 - cost * turnover;
      expo = next;
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

    // Historical one-day VaR/CVaR at 95% (as positive losses) and the longest stretch below a peak.
    const sorted = r.slice().sort((a, b) => a - b);
    const cut = Math.max(1, Math.floor(sorted.length * 0.05));
    const var95 = sorted.length ? -sorted[cut - 1] : NaN;
    const cvar95 = sorted.length ? -sorted.slice(0, cut).reduce((a, b) => a + b, 0) / cut : NaN;
    let ddDays = 0, peakT = times[0];
    for (let i = 0; i < n; i++) {
      if (dd[i] === 0) peakT = times[i];
      else ddDays = Math.max(ddDays, (times[i] - peakT) / 86400000);
    }

    const out = { total, cagr, vol, sharpe, sortino, maxDD, calmar, years, var95, cvar95, ddDays: Math.round(ddDays) };
    if (held) out.avgExposure = held.slice(1).reduce((a, h) => a + Math.abs(h), 0) / Math.max(held.length - 1, 1);
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

  // Slope of y on x (beta), per-period intercept (alpha) and their correlation.
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
    const b = vx > 0 ? cov / vx : NaN;
    return { beta: b, alpha: my - b * mx, corr: vx > 0 && vy > 0 ? cov / Math.sqrt(vx * vy) : NaN, n };
  }

  // Up to 7 values of a numeric strategy parameter around its default, snapped to its step
  // and range: multiplicative (x0.5 .. x2) for large values, linear steps for small ones.
  function gridValues(d) {
    const dec = (String(d.step).split('.')[1] || '').length;
    const snap = (v) => +Math.min(d.max, Math.max(d.min, Math.round(v / d.step) * d.step)).toFixed(dec);
    const uniq = (a) => [...new Set(a)].sort((x, y) => x - y);
    let out = uniq([0.5, 0.67, 0.8, 1, 1.25, 1.5, 2].map((f) => snap(d.def * f)));
    if (out.length < 5) {
      const s = Math.max(d.step, Math.round((d.max - d.min) / 12 / d.step) * d.step);
      out = uniq([-3, -2, -1, 0, 1, 2, 3].map((k) => snap(d.def + k * s)));
    }
    return out;
  }

  // Volatility targeting: position scale for day t from the realised volatility of the
  // `lookback` daily returns up to and including t, capped at 1 (no leverage).
  function volScale(close, targetPct, lookback, ppy) {
    const L = lookback || 20, P = ppy || 252, tgt = targetPct / 100;
    const out = new Array(close.length).fill(NaN);
    for (let t = L; t < close.length; t++) {
      let s = 0, s2 = 0;
      for (let j = t - L + 1; j <= t; j++) {
        const x = close[j] / close[j - 1] - 1;
        s += x;
        s2 += x * x;
      }
      const m = s / L;
      const vol = Math.sqrt(Math.max(s2 / L - m * m, 0) * L / (L - 1) * P);
      out[t] = vol > 0 ? Math.min(1, tgt / vol) : 1;
    }
    return out;
  }

  // Annualised Sharpe over a trailing window of `win` returns (NaN until the window fills).
  function rollingSharpe(rets, win, ppy, rfPct) {
    const out = new Array(rets.length).fill(NaN);
    const rfD = (rfPct || 0) / 100 / ppy;
    let s = 0, s2 = 0;
    for (let i = 1; i < rets.length; i++) {
      s += rets[i];
      s2 += rets[i] * rets[i];
      if (i > win) { s -= rets[i - win]; s2 -= rets[i - win] * rets[i - win]; }
      if (i >= win) {
        const m = s / win, sd = Math.sqrt(Math.max(s2 / win - m * m, 0) * win / (win - 1));
        out[i] = sd > 0 ? ((m - rfD) / sd) * Math.sqrt(ppy) : 0;
      }
    }
    return out;
  }

  // Standard normal CDF (Abramowitz-Stegun 7.1.26) and inverse CDF (Acklam).
  function normCdf(x) {
    const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2);
    const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x / 2);
    return x >= 0 ? (1 + y) / 2 : (1 - y) / 2;
  }
  function normInv(p) {
    const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
    const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
    const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
    const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
    const q0 = 0.02425;
    if (p < q0) {
      const q = Math.sqrt(-2 * Math.log(p));
      return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
    }
    if (p > 1 - q0) return -normInv(1 - p);
    const q = p - 0.5, r = q * q;
    return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  }

  // Deflated Sharpe ratio (Bailey & Lopez de Prado 2014): probability that the best of `trials`
  // backtests has a true Sharpe above zero, given how many were tried and how much their Sharpes
  // varied. r = the chosen strategy's per-period returns, trialSharpes = annualised Sharpes.
  function deflatedSharpe(r, ppy, trialSharpes, rfPct) {
    const x = r.filter(isFinite);
    const T = x.length, N = trialSharpes.length;
    if (T < 60 || N < 2) return null;
    const rfD = (rfPct || 0) / 100 / ppy;
    const mean = x.reduce((a, b) => a + b, 0) / T;
    const sd = Math.sqrt(x.reduce((a, b) => a + (b - mean) ** 2, 0) / (T - 1));
    if (!(sd > 0)) return null;
    const sr = (mean - rfD) / sd;
    const skew = x.reduce((a, b) => a + ((b - mean) / sd) ** 3, 0) / T;
    const kurt = x.reduce((a, b) => a + ((b - mean) / sd) ** 4, 0) / T;
    const per = trialSharpes.map((v) => v / Math.sqrt(ppy));
    const pm = per.reduce((a, b) => a + b, 0) / N;
    const pv = per.reduce((a, b) => a + (b - pm) ** 2, 0) / (N - 1);
    const g = 0.5772156649;
    const sr0 = Math.sqrt(pv) * ((1 - g) * normInv(1 - 1 / N) + g * normInv(1 - 1 / (N * Math.E)));
    const denom = Math.sqrt(Math.max(1 - skew * sr + ((kurt - 1) / 4) * sr * sr, 1e-12));
    return {
      dsr: normCdf(((sr - sr0) * Math.sqrt(T - 1)) / denom),
      psr: normCdf((sr * Math.sqrt(T - 1)) / denom),
      sharpe: sr * Math.sqrt(ppy),
      hurdle: sr0 * Math.sqrt(ppy),
      trials: N,
    };
  }

  // Seeded PRNG (mulberry32) so resampled results don't flicker between re-renders.
  function rng(seed) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // Circular block bootstrap of daily returns: resample blocks of `block` days (keeps short-run
  // autocorrelation) and report 5/50/95th percentiles of annualised Sharpe and CAGR.
  function bootstrap(r, ppy, opts) {
    const o = Object.assign({ n: 1000, block: 20, seed: 7, rfPct: 0 }, opts);
    const x = r.filter(isFinite);
    const m = x.length;
    if (m < 60) return null;
    const rand = rng(o.seed);
    const rfDaily = o.rfPct / 100 / ppy;
    const sh = new Array(o.n), cg = new Array(o.n);
    for (let k = 0; k < o.n; k++) {
      let sum = 0, sum2 = 0, logSum = 0;
      for (let i = 0; i < m;) {
        const start = Math.floor(rand() * m);
        for (let j = 0; j < o.block && i < m; j++, i++) {
          const v = x[(start + j) % m];
          sum += v;
          sum2 += v * v;
          logSum += Math.log(1 + v);
        }
      }
      const mean = sum / m;
      const sd = Math.sqrt(Math.max(sum2 / m - mean * mean, 0) * m / (m - 1));
      sh[k] = sd > 0 ? ((mean - rfDaily) / sd) * Math.sqrt(ppy) : 0;
      cg[k] = Math.exp((logSum / m) * ppy) - 1;
    }
    const q = (a, p) => a[Math.min(a.length - 1, Math.max(0, Math.round(p * (a.length - 1))))];
    sh.sort((a, b) => a - b);
    cg.sort((a, b) => a - b);
    return {
      sharpe: [q(sh, 0.05), q(sh, 0.5), q(sh, 0.95)],
      cagr: [q(cg, 0.05), q(cg, 0.5), q(cg, 0.95)],
      pPositive: sh.filter((v) => v > 0).length / o.n,
      n: o.n,
      block: o.block,
    };
  }

  // Rolling walk-forward: on each train window pick the candidate with the best Sharpe, then
  // trade it on the following test window. cands = [{ params, pos }] with positions precomputed.
  // Test windows are stitched into one out-of-sample series; each window starts flat.
  function walkForward(data, cands, s, e, opts, trainLen, testLen) {
    const folds = [];
    const times = [], rets = [], bRets = [];
    for (let t0 = s + trainLen; t0 + 20 <= e; t0 += testLen) {
      const t1 = Math.min(t0 + testLen, e);
      let best = 0, bestSharpe = -Infinity;
      cands.forEach((c, i) => {
        const sh = run(data, c.pos, t0 - trainLen, t0, opts).metrics.sharpe;
        if (sh > bestSharpe) { bestSharpe = sh; best = i; }
      });
      const test = run(data, cands[best].pos, t0, t1, opts);
      folds.push({ trainS: t0 - trainLen, testS: t0, testE: t1, best, trainSharpe: bestSharpe, test });
      const from = times.length ? 1 : 0;
      for (let k = from; k < test.times.length; k++) {
        times.push(test.times[k]);
        rets.push(test.rets[k]);
        bRets.push(test.benchRets[k]);
      }
    }
    if (!folds.length) return null;
    const curve = (rr) => { let v = 100; return rr.map((x) => (v *= 1 + x)); };
    const eq = curve(rets), beq = curve(bRets);
    return {
      folds,
      times,
      equity: eq,
      benchEquity: beq,
      metrics: metrics(times, eq, rets, null, null, opts.rf || 0),
      benchMetrics: metrics(times, beq, bRets, null, null, opts.rf || 0),
    };
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

  QL.backtest = { run, drawdown, metrics, monthlyReturns, histogram, returnStats, beta, gridValues, bootstrap, walkForward, volScale, rollingSharpe, deflatedSharpe, normCdf, normInv };
})((window.QL = window.QL || {}));
