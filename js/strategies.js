(function (QL) {
  'use strict';

  function sma(x, n) {
    const out = new Array(x.length).fill(NaN);
    let sum = 0;
    for (let i = 0; i < x.length; i++) {
      sum += x[i];
      if (i >= n) sum -= x[i - n];
      if (i >= n - 1) out[i] = sum / n;
    }
    return out;
  }

  function rollingStd(x, n, mean) {
    const out = new Array(x.length).fill(NaN);
    for (let i = n - 1; i < x.length; i++) {
      let s = 0;
      for (let j = i - n + 1; j <= i; j++) s += (x[j] - mean[i]) ** 2;
      out[i] = Math.sqrt(s / n);
    }
    return out;
  }

  // Wilder's RSI
  function rsi(x, n) {
    const out = new Array(x.length).fill(NaN);
    let gain = 0, loss = 0;
    for (let i = 1; i < x.length; i++) {
      const d = x[i] - x[i - 1];
      const g = d > 0 ? d : 0, l = d < 0 ? -d : 0;
      if (i <= n) {
        gain += g; loss += l;
        if (i === n) { gain /= n; loss /= n; }
        else continue;
      } else {
        gain = (gain * (n - 1) + g) / n;
        loss = (loss * (n - 1) + l) / n;
      }
      out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
    }
    return out;
  }

  function bollinger(close, n, k) {
    const mid = sma(close, n);
    const sd = rollingStd(close, n, mid);
    return {
      mid,
      upper: mid.map((m, i) => m + k * sd[i]),
      lower: mid.map((m, i) => m - k * sd[i]),
    };
  }

  const STRATEGIES = {
    sma: {
      name: 'SMA Crossover',
      desc: 'ถือ Long เมื่อเส้นค่าเฉลี่ยเร็วอยู่เหนือเส้นค่าเฉลี่ยช้า (Trend following)',
      params: [
        { key: 'fast', label: 'MA เร็ว (วัน)', min: 2, max: 250, step: 1, def: 20 },
        { key: 'slow', label: 'MA ช้า (วัน)', min: 5, max: 400, step: 1, def: 100 },
      ],
      validate: (p) => (p.fast >= p.slow ? 'MA เร็วต้องน้อยกว่า MA ช้า' : null),
      signal(close, p, allowShort) {
        const f = sma(close, p.fast), s = sma(close, p.slow);
        return close.map((_, i) => {
          if (!isFinite(f[i]) || !isFinite(s[i])) return 0;
          return f[i] > s[i] ? 1 : allowShort ? -1 : 0;
        });
      },
      overlays: (close, p) => [
        { name: 'SMA ' + p.fast, values: sma(close, p.fast), color: 2 },
        { name: 'SMA ' + p.slow, values: sma(close, p.slow), color: 3 },
      ],
    },

    momentum: {
      name: 'Time-Series Momentum',
      desc: 'ถือ Long เมื่อผลตอบแทนย้อนหลัง N วันเป็นบวก (ติดตามโมเมนตัม)',
      params: [
        { key: 'lookback', label: 'ย้อนหลัง (วัน)', min: 5, max: 400, step: 1, def: 126 },
        { key: 'threshold', label: 'เกณฑ์ขั้นต่ำ (%)', min: 0, max: 50, step: 0.5, def: 0 },
      ],
      signal(close, p, allowShort) {
        const th = p.threshold / 100;
        return close.map((c, i) => {
          if (i < p.lookback) return 0;
          const r = c / close[i - p.lookback] - 1;
          if (r > th) return 1;
          if (r < -th) return allowShort ? -1 : 0;
          return 0;
        });
      },
      overlays: (close, p) => [{ name: 'SMA ' + p.lookback, values: sma(close, p.lookback), color: 2 }],
    },

    rsi: {
      name: 'RSI Mean Reversion',
      desc: 'ซื้อเมื่อ RSI ต่ำกว่าเขต Oversold และออกเมื่อ RSI สูงกว่าเขต Overbought',
      params: [
        { key: 'period', label: 'คาบ RSI', min: 2, max: 100, step: 1, def: 14 },
        { key: 'lower', label: 'Oversold', min: 1, max: 50, step: 1, def: 30 },
        { key: 'upper', label: 'Overbought', min: 50, max: 99, step: 1, def: 70 },
      ],
      validate: (p) => (p.lower >= p.upper ? 'Oversold ต้องน้อยกว่า Overbought' : null),
      signal(close, p, allowShort) {
        const r = rsi(close, p.period);
        let pos = 0;
        return close.map((_, i) => {
          const v = r[i];
          if (!isFinite(v)) return 0;
          if (v < p.lower) pos = 1;
          else if (v > p.upper) pos = allowShort ? -1 : 0;
          return pos;
        });
      },
      overlays: () => [],
    },

    bollinger: {
      name: 'Bollinger Reversion',
      desc: 'ซื้อเมื่อราคาหลุดกรอบล่าง ขายทำกำไรเมื่อกลับมาที่เส้นกลาง',
      params: [
        { key: 'period', label: 'คาบ (วัน)', min: 5, max: 200, step: 1, def: 20 },
        { key: 'k', label: 'ความกว้าง (SD)', min: 0.5, max: 4, step: 0.1, def: 2 },
      ],
      signal(close, p, allowShort) {
        const b = bollinger(close, p.period, p.k);
        let pos = 0;
        return close.map((c, i) => {
          if (!isFinite(b.mid[i])) return 0;
          if (pos === 0) {
            if (c < b.lower[i]) pos = 1;
            else if (allowShort && c > b.upper[i]) pos = -1;
          } else if (pos === 1 && c >= b.mid[i]) pos = 0;
          else if (pos === -1 && c <= b.mid[i]) pos = 0;
          return pos;
        });
      },
      overlays(close, p) {
        const b = bollinger(close, p.period, p.k);
        return [
          { name: 'เส้นกลาง', values: b.mid, color: 2 },
          { name: 'กรอบบน/ล่าง', values: b.upper, color: 3 },
          { name: 'กรอบบน/ล่าง', values: b.lower, color: 3, legend: false },
        ];
      },
    },

    buyhold: {
      name: 'Buy & Hold',
      desc: 'ซื้อแล้วถือตลอดช่วงเวลา (ใช้เป็น Benchmark)',
      params: [],
      signal: (close) => close.map(() => 1),
      overlays: () => [],
    },
  };

  function defaults(key) {
    const p = {};
    for (const d of STRATEGIES[key].params) p[d.key] = d.def;
    return p;
  }

  QL.strategies = { STRATEGIES, defaults, sma, rsi, bollinger };
})((window.QL = window.QL || {}));
