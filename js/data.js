(function (QL) {
  'use strict';

  const DAY = 86400000;

  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function randn(rng) {
    let u = 0, v = 0;
    while (u === 0) u = rng();
    while (v === 0) v = rng();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  function hashString(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  function businessDays(startMs, endMs) {
    const out = [];
    for (let t = startMs; t <= endMs; t += DAY) {
      const w = new Date(t).getUTCDay();
      if (w !== 0 && w !== 6) out.push(t);
    }
    return out;
  }

  function todayUtc() {
    const d = new Date();
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  }

  const ASSETS = [
    { id: 'index', ticker: 'SIM-INDEX', label: 'ดัชนีหุ้น', start: 1000, mu: 0.07, vol: 0.16, model: 'regime' },
    { id: 'tech', ticker: 'SIM-TECH', label: 'หุ้นเทคโนโลยี', start: 120, mu: 0.14, vol: 0.32, model: 'regime' },
    { id: 'coin', ticker: 'SIM-COIN', label: 'คริปโต', start: 4000, mu: 0.3, vol: 0.7, model: 'regime' },
    { id: 'gold', ticker: 'SIM-GOLD', label: 'ทองคำ', start: 1250, mu: 0.05, vol: 0.14, model: 'regime' },
    { id: 'range', ticker: 'SIM-RANGE', label: 'ตลาด Sideway', start: 100, mu: 0.02, vol: 0.2, model: 'range' },
  ];

  // Two-state (bull/bear) regime-switching GBM with occasional jumps, or a
  // mean-reverting process around a slow trend for the 'range' model.
  function simulate(asset, seed) {
    const rng = mulberry32(hashString(asset.id) ^ seed);
    const end = todayUtc() - DAY;
    const dates = businessDays(Date.UTC(2016, 0, 4), end);
    const dt = 1 / 252;
    const close = new Array(dates.length);
    let logP = Math.log(asset.start);

    if (asset.model === 'range') {
      const phi = 0.985, sd = 0.014;
      let dev = 0;
      let trend = logP;
      close[0] = asset.start;
      for (let i = 1; i < dates.length; i++) {
        trend += asset.mu * dt + 0.004 * randn(rng);
        dev = phi * dev + sd * randn(rng);
        close[i] = Math.exp(trend + dev);
      }
    } else {
      let bear = false;
      const bull = { mu: asset.mu + 0.08, vol: asset.vol * 0.85 };
      const bearP = { mu: asset.mu * 0.5 - 1.5 * asset.vol, vol: asset.vol * 1.6 };
      close[0] = asset.start;
      for (let i = 1; i < dates.length; i++) {
        const u = rng();
        if (!bear && u < 1 / 400) bear = true;
        else if (bear && u < 1 / 80) bear = false;
        const p = bear ? bearP : bull;
        let r = (p.mu - 0.5 * p.vol * p.vol) * dt + p.vol * Math.sqrt(dt) * randn(rng);
        if (rng() < 0.004) r += 3 * p.vol * Math.sqrt(dt) * randn(rng);
        logP += r;
        close[i] = Math.exp(logP);
      }
    }

    return {
      source: 'sim',
      name: asset.ticker,
      label: asset.label + ' (จำลอง)',
      dates,
      close,
    };
  }

  function splitCsvLine(line) {
    const out = [];
    let cur = '', q = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (q) {
        if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
        else if (c === '"') q = false;
        else cur += c;
      } else if (c === '"') q = true;
      else if (c === ',' || c === ';' || c === '\t') { out.push(cur.trim()); cur = ''; }
      else cur += c;
    }
    out.push(cur.trim());
    return out;
  }

  function parseDate(s) {
    let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(s);
    if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3]);
    m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})/.exec(s);
    if (m) return Date.UTC(+m[3], +m[2] - 1, +m[1]);
    const t = Date.parse(s);
    if (isNaN(t)) return NaN;
    const d = new Date(t);
    return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
  }

  function parseNumber(s) {
    if (s == null) return NaN;
    const v = parseFloat(String(s).replace(/[,\s$฿]/g, ''));
    return v;
  }

  function parseCsv(text, fileName) {
    const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '');
    if (lines.length < 2) throw new Error('ไฟล์ว่างหรือมีข้อมูลน้อยเกินไป');
    const header = splitCsvLine(lines[0]).map((h) => h.toLowerCase());
    let dateCol = header.findIndex((h) => h.includes('date') || h.includes('time') || h.includes('วันที่'));
    if (dateCol < 0) dateCol = 0;
    let closeCol = header.findIndex((h) => h === 'adj close' || h === 'adj_close' || h === 'adjclose');
    if (closeCol < 0) closeCol = header.findIndex((h) => h === 'close' || h.includes('close') || h.includes('price') || h.includes('ราคา'));
    if (closeCol < 0) closeCol = header.length - 1;
    if (closeCol === dateCol) throw new Error('หาคอลัมน์ราคาปิด (Close) ไม่เจอ');

    const rows = [];
    for (let i = 1; i < lines.length; i++) {
      const cells = splitCsvLine(lines[i]);
      const t = parseDate(cells[dateCol] || '');
      const c = parseNumber(cells[closeCol]);
      if (isFinite(t) && isFinite(c) && c > 0) rows.push([t, c]);
    }
    rows.sort((a, b) => a[0] - b[0]);
    const dates = [], close = [];
    for (const [t, c] of rows) {
      if (dates.length && dates[dates.length - 1] === t) { close[close.length - 1] = c; continue; }
      dates.push(t);
      close.push(c);
    }
    if (dates.length < 60) throw new Error('ต้องมีข้อมูลอย่างน้อย 60 แถวที่มีวันที่และราคาถูกต้อง (พบ ' + dates.length + ' แถว)');
    const name = (fileName || 'CSV').replace(/\.[^.]+$/, '');
    return { source: 'csv', name, label: 'ไฟล์ ' + name, dates, close };
  }

  QL.data = { ASSETS, simulate, parseCsv, DAY };
})((window.QL = window.QL || {}));
