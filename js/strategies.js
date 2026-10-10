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

  // Seeded with the SMA of the first n closes, then alpha = 2 / (n + 1).
  function ema(x, n) {
    const out = new Array(x.length).fill(NaN);
    if (x.length < n) return out;
    const a = 2 / (n + 1);
    let e = 0;
    for (let i = 0; i < n; i++) e += x[i];
    e /= n;
    out[n - 1] = e;
    for (let i = n; i < x.length; i++) {
      e = a * x[i] + (1 - a) * e;
      out[i] = e;
    }
    return out;
  }

  // Highest/lowest close of the n days BEFORE day i (today excluded, so a breakout is possible).
  function rollingExtreme(x, n, pick) {
    const out = new Array(x.length).fill(NaN);
    for (let i = n; i < x.length; i++) {
      let v = x[i - n];
      for (let j = i - n + 1; j < i; j++) v = pick(v, x[j]);
      out[i] = v;
    }
    return out;
  }

  // 1-based trading-day position of each date counted from the start and from the end of its month.
  function monthPositions(dates) {
    const n = dates.length;
    const fromStart = new Array(n), fromEnd = new Array(n);
    const monthOf = (t) => { const d = new Date(t); return d.getUTCFullYear() * 12 + d.getUTCMonth(); };
    for (let i = 0; i < n; i++) fromStart[i] = i > 0 && monthOf(dates[i - 1]) === monthOf(dates[i]) ? fromStart[i - 1] + 1 : 1;
    for (let i = n - 1; i >= 0; i--) fromEnd[i] = i < n - 1 && monthOf(dates[i + 1]) === monthOf(dates[i]) ? fromEnd[i + 1] + 1 : 1;
    // The data's first and last months may be partial; their month boundaries are unknown.
    if (n) {
      const first = new Date(dates[0]);
      if (first.getUTCDate() > 5) {
        for (let i = 0; i < n && monthOf(dates[i]) === monthOf(dates[0]); i++) fromStart[i] = Infinity;
      }
      const last = new Date(dates[n - 1]);
      const daysInMonth = new Date(Date.UTC(last.getUTCFullYear(), last.getUTCMonth() + 1, 0)).getUTCDate();
      if (last.getUTCDate() < daysInMonth - 4) {
        for (let i = n - 1; i >= 0 && monthOf(dates[i]) === monthOf(dates[n - 1]); i--) fromEnd[i] = Infinity;
      }
    }
    return { fromStart, fromEnd };
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

    ema: {
      name: 'EMA Crossover',
      desc: 'ถือ Long เมื่อ EMA เร็วอยู่เหนือ EMA ช้า (เช่น 50/200 = Golden Cross / Death Cross แบบ EMA)',
      params: [
        { key: 'fast', label: 'EMA เร็ว (วัน)', min: 2, max: 250, step: 1, def: 50 },
        { key: 'slow', label: 'EMA ช้า (วัน)', min: 5, max: 400, step: 1, def: 200 },
      ],
      validate: (p) => (p.fast >= p.slow ? 'EMA เร็วต้องน้อยกว่า EMA ช้า' : null),
      signal(close, p, allowShort) {
        const f = ema(close, p.fast), s = ema(close, p.slow);
        return close.map((_, i) => {
          if (!isFinite(f[i]) || !isFinite(s[i])) return 0;
          return f[i] > s[i] ? 1 : allowShort ? -1 : 0;
        });
      },
      overlays: (close, p) => [
        { name: 'EMA ' + p.fast, values: ema(close, p.fast), color: 2 },
        { name: 'EMA ' + p.slow, values: ema(close, p.slow), color: 3 },
      ],
    },

    emaTrend: {
      name: 'ราคาเทียบ EMA200',
      desc: 'ถือ Long เมื่อราคาปิดอยู่เหนือเส้น EMA (ตัวกรองแนวโน้มหลัก) · บัฟเฟอร์ช่วยลดสัญญาณหลอกตอนราคาวนรอบเส้น',
      params: [
        { key: 'period', label: 'EMA (วัน)', min: 5, max: 400, step: 1, def: 200 },
        { key: 'buffer', label: 'บัฟเฟอร์ (%)', min: 0, max: 10, step: 0.5, def: 0 },
      ],
      // With a buffer, entry needs close > EMA*(1+b) and exit needs close < EMA*(1-b);
      // in between the previous position is kept.
      signal(close, p, allowShort) {
        const e = ema(close, p.period);
        const b = p.buffer / 100;
        let pos = 0;
        return close.map((c, i) => {
          if (!isFinite(e[i])) return 0;
          if (c > e[i] * (1 + b)) pos = 1;
          else if (c < e[i] * (1 - b)) pos = allowShort ? -1 : 0;
          return pos;
        });
      },
      overlays(close, p) {
        const e = ema(close, p.period);
        const out = [{ name: 'EMA ' + p.period, values: e, color: 2 }];
        if (p.buffer > 0) {
          const b = p.buffer / 100;
          out.push(
            { name: 'บัฟเฟอร์ ±' + p.buffer + '%', values: e.map((v) => v * (1 + b)), color: 3 },
            { name: 'บัฟเฟอร์ ±' + p.buffer + '%', values: e.map((v) => v * (1 - b)), color: 3, legend: false },
          );
        }
        return out;
      },
    },

    breakout: {
      name: 'Breakout แนวต้าน-แนวรับ',
      desc: 'ซื้อเมื่อราคาปิดทะลุจุดสูงสุดของ N วันก่อนหน้า (แนวต้าน) ขายเมื่อหลุดจุดต่ำสุดของ M วันก่อนหน้า (แนวรับ) · Paulos หน้า 45–47',
      params: [
        { key: 'entry', label: 'ทะลุจุดสูงสุด (วัน)', min: 5, max: 250, step: 1, def: 20 },
        { key: 'exit', label: 'หลุดจุดต่ำสุด (วัน)', min: 2, max: 250, step: 1, def: 10 },
      ],
      signal(close, p, allowShort) {
        const hiN = rollingExtreme(close, p.entry, Math.max), loN = rollingExtreme(close, p.entry, Math.min);
        const hiM = rollingExtreme(close, p.exit, Math.max), loM = rollingExtreme(close, p.exit, Math.min);
        let pos = 0;
        return close.map((c, i) => {
          if (!isFinite(hiN[i])) return 0;
          if (pos === 1 && c < loM[i]) pos = 0;
          else if (pos === -1 && c > hiM[i]) pos = 0;
          if (pos === 0) {
            if (c > hiN[i]) pos = 1;
            else if (allowShort && c < loN[i]) pos = -1;
          }
          return pos;
        });
      },
      overlays(close, p) {
        return [
          { name: 'แนวต้าน ' + p.entry + ' วัน', values: rollingExtreme(close, p.entry, Math.max), color: 2 },
          { name: 'แนวรับ ' + p.exit + ' วัน', values: rollingExtreme(close, p.exit, Math.min), color: 3 },
        ];
      },
    },

    turnOfMonth: {
      name: 'Calendar: ช่วงต้นเดือน',
      desc: 'ถือหุ้นเฉพาะช่วงวันทำการสุดท้ายของเดือนถึงต้นเดือนถัดไป ช่วงอื่นถือเงินสด · Turn-of-month effect, Paulos หน้า 48',
      params: [
        { key: 'before', label: 'วันก่อนสิ้นเดือน', min: 0, max: 10, step: 1, def: 1 },
        { key: 'after', label: 'วันต้นเดือน', min: 1, max: 10, step: 1, def: 3 },
      ],
      // A signal at close t earns day t+1's return, so hold when day t+1 is inside the window.
      signal(close, p, allowShort, dates) {
        const { fromStart, fromEnd } = monthPositions(dates);
        return close.map((_, i) => {
          const j = i + 1;
          if (j >= close.length) return 0;
          return fromEnd[j] <= p.before || fromStart[j] <= p.after ? 1 : 0;
        });
      },
      overlays: () => [],
    },

    january: {
      name: 'Calendar: January effect',
      desc: 'ถือหุ้นเฉพาะเดือนมกราคม เดือนอื่นถือเงินสด · หุ้นมักขึ้นต้นปี แต่ไม่เกิดทุกปี Paulos หน้า 48',
      params: [],
      signal(close, p, allowShort, dates) {
        return close.map((_, i) => (i + 1 < close.length && new Date(dates[i + 1]).getUTCMonth() === 0 ? 1 : 0));
      },
      overlays: () => [],
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

  QL.strategies = { STRATEGIES, defaults, sma, ema, rsi, bollinger };
})((window.QL = window.QL || {}));
