(function (QL) {
  'use strict';

  const YEAR = 252;

  // ---------- math (pure; no DOM) ----------

  // Inner-join several price series on their dates.
  function align(series) {
    const maps = series.map((s) => new Map(s.dates.map((t, i) => [t, s.close[i]])));
    const dates = series[0].dates.filter((t) => maps.every((m) => m.has(t)));
    return { dates, close: maps.map((m) => dates.map((t) => m.get(t))) };
  }

  const returnsOf = (close) => close.map((c, t) => (t === 0 ? 0 : c / close[t - 1] - 1));

  // Annualised mean vector and covariance matrix of returns over days (a, b].
  function estimate(R, a, b) {
    const n = R.length, m = b - a;
    const mean = R.map((r) => { let s = 0; for (let t = a + 1; t <= b; t++) s += r[t]; return s / m; });
    const cov = R.map(() => new Array(n).fill(0));
    for (let i = 0; i < n; i++) {
      for (let j = i; j < n; j++) {
        let s = 0;
        for (let t = a + 1; t <= b; t++) s += (R[i][t] - mean[i]) * (R[j][t] - mean[j]);
        cov[i][j] = cov[j][i] = (s / (m - 1)) * YEAR;
      }
    }
    return { mu: mean.map((v) => v * YEAR), cov };
  }

  // Euclidean projection onto { w >= 0, sum w = 1 } (long-only, fully invested).
  function projSimplex(v) {
    const u = v.slice().sort((a, b) => b - a);
    let css = 0, theta = 0;
    for (let k = 0; k < u.length; k++) {
      css += u[k];
      const t = (css - 1) / (k + 1);
      if (u[k] - t > 0) theta = t;
    }
    return v.map((x) => Math.max(x - theta, 0));
  }

  const quad = (cov, w) => w.reduce((s, wi, i) => s + wi * cov[i].reduce((a, c, j) => a + c * w[j], 0), 0);
  const dot = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);

  // Projected gradient for min w'Σw - t·μ'w over the simplex (t = 0 gives minimum variance).
  function minQuad(cov, mu, t, w0, iters) {
    const n = mu.length;
    const L = 2 * cov.reduce((s, r, i) => s + r[i], 0) + 1e-12;
    let w = w0 ? w0.slice() : new Array(n).fill(1 / n);
    for (let k = 0; k < iters; k++) {
      const g = w.map((_, i) => 2 * cov[i].reduce((a, c, j) => a + c * w[j], 0) - t * mu[i]);
      w = projSimplex(w.map((x, i) => x - g[i] / L));
    }
    return w;
  }

  // Long-only efficient frontier: sweep the return tilt t from 0 (min variance) up to the max-return corner.
  function frontier(cov, mu, k, iters) {
    const maxVar = Math.max(...cov.map((r, i) => r[i]));
    const spread = Math.max(Math.max(...mu) - Math.min(...mu), 1e-4);
    const tMax = (20 * maxVar) / spread;
    const pts = [];
    let w = null;
    for (let s = 0; s <= k; s++) {
      w = minQuad(cov, mu, tMax * (s / k) ** 2, w, iters);
      pts.push({ w, ret: dot(mu, w), vol: Math.sqrt(Math.max(quad(cov, w), 0)) });
    }
    return pts;
  }

  const METHODS = {
    equal: { name: 'น้ำหนักเท่ากัน', desc: 'ทุกตัวเท่ากัน 1/N' },
    invvol: { name: 'ตามความผันผวน', desc: 'ตัวที่ผันผวนน้อยได้น้ำหนักมาก (1/σ)' },
    minvar: { name: 'ความเสี่ยงต่ำสุด', desc: 'น้ำหนักที่ทำให้ความผันผวนของพอร์ตต่ำที่สุด ใช้ covariance' },
    maxsharpe: { name: 'Sharpe สูงสุด', desc: 'จุดบน efficient frontier ที่ Sharpe สูงสุด ใช้ทั้งผลตอบแทนและ covariance' },
    momentum: { name: 'Momentum (ครึ่งที่แรงสุด)', desc: 'ถือเท่ากันเฉพาะครึ่งบนของหุ้นที่ขึ้นมากสุดใน 12 เดือนก่อน ไม่นับเดือนล่าสุด (Paulos หน้า 47–48)', signal: true },
    trend: { name: 'ตามเทรนด์ (เหนือ SMA200)', desc: 'ถือเท่ากันเฉพาะตัวที่ราคาอยู่เหนือค่าเฉลี่ย 200 วัน ตัวที่เหลือถือเงินสด (Paulos หน้า 41–44)', signal: true },
  };

  // Signal-driven weights from a price index idx[i][t]; weights may sum to less than 1 (rest is cash).
  // Returns null while there isn't enough history yet.
  function signalWeights(method, idx, t) {
    const n = idx.length;
    if (method === 'momentum') {
      if (t < YEAR) return null;
      const mom = idx.map((p, i) => ({ i, m: p[t - 21] / p[t - YEAR] - 1 }));
      const top = mom.sort((a, b) => b.m - a.m).slice(0, Math.ceil(n / 2));
      const w = new Array(n).fill(0);
      for (const x of top) w[x.i] = 1 / top.length;
      return w;
    }
    if (t < 200) return null;
    const above = idx.map((p) => {
      let s = 0;
      for (let j = t - 199; j <= t; j++) s += p[j];
      return p[t] > s / 200;
    });
    return above.map((a) => (a ? 1 / n : 0));
  }

  function weightsFor(method, est, rfPct) {
    const n = est.mu.length;
    if (method === 'equal') return new Array(n).fill(1 / n);
    if (method === 'invvol') {
      const iv = est.cov.map((r, i) => 1 / Math.sqrt(Math.max(r[i], 1e-12)));
      const s = iv.reduce((a, b) => a + b, 0);
      return iv.map((v) => v / s);
    }
    if (method === 'minvar') return minQuad(est.cov, est.mu, 0, null, 300);
    const rf = rfPct / 100;
    let best = null, bestS = -Infinity;
    for (const p of frontier(est.cov, est.mu, 16, 100)) {
      const s = p.vol > 0 ? (p.ret - rf) / p.vol : -Infinity;
      if (s > bestS) { bestS = s; best = p.w; }
    }
    return best;
  }

  const periodKey = {
    month: (d) => d.getUTCFullYear() * 12 + d.getUTCMonth(),
    quarter: (d) => d.getUTCFullYear() * 4 + Math.floor(d.getUTCMonth() / 3),
    year: (d) => d.getUTCFullYear(),
  };

  // Rebalance at the close of the first day and of the last day of each period, using only the
  // previous `lookback` days of returns (equal weights while there are fewer than 60 days).
  // Weights then drift with prices until the next rebalance. Costs are charged on turnover.
  function backtest(dates, R, s, e, o) {
    const n = R.length;
    const cost = (o.costBps || 0) / 10000;
    const rfA = (o.rf || 0) / 100;
    const key = periodKey[o.rebalance];
    const idx = METHODS[o.method].signal ? R.map((r) => { let v = 1; return r.map((x) => (v *= 1 + x)); }) : null;
    let w = new Array(n).fill(0), eq = 100, turnover = 0, rebalances = 0, last = null;
    const equity = [], rets = [];
    for (let t = s; t <= e; t++) {
      let r = 0;
      if (t > s) {
        const cashW = Math.max(0, 1 - w.reduce((a, b) => a + b, 0));
        const rfDay = Math.pow(1 + rfA, (dates[t] - dates[t - 1]) / (365.25 * 86400000)) - 1;
        r = dot(w, R.map((x) => x[t])) + cashW * rfDay;
        eq *= 1 + r;
        if (1 + r !== 0) w = w.map((wi, i) => (wi * (1 + R[i][t])) / (1 + r));
      }
      const boundary = t === s || (key && t < e && key(new Date(dates[t])) !== key(new Date(dates[t + 1])));
      if (boundary) {
        const a = Math.max(0, t - (o.lookback || YEAR));
        const target = (idx && signalWeights(o.method, idx, t)) ||
          (!idx && t - a >= 60 ? weightsFor(o.method, estimate(R, a, t), o.rf || 0) : new Array(n).fill(1 / n));
        const tv = target.reduce((sum, x, i) => sum + Math.abs(x - w[i]), 0);
        if (t > s) turnover += tv;
        eq *= 1 - cost * tv;
        r = (1 + r) * (1 - cost * tv) - 1;
        w = target;
        last = { t, w: target };
        rebalances++;
      }
      equity.push(eq);
      rets.push(r);
    }
    const years = (dates[e] - dates[s]) / (365.25 * 86400000);
    return { equity, rets, last, turnoverPerYear: years > 0 ? turnover / years : 0, rebalances };
  }

  QL.portfolio = { align, returnsOf, estimate, projSimplex, minQuad, frontier, weightsFor, signalWeights, backtest, METHODS };

  // ---------- view ----------

  function h(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  const pct = (v, d = 1, sign = true) => (!isFinite(v) ? '—' : (sign && v > 0 ? '+' : '') + (v * 100).toFixed(d) + '%');
  const num = (v, d = 2) => (!isFinite(v) ? '—' : v.toFixed(d));
  const isoDate = (t) => new Date(t).toISOString().slice(0, 10);

  function init({ container, onShare }) {
    const C = QL.charts, BT = QL.backtest;
    const manifest = QL.data.getManifest();
    const universe = manifest ? manifest.tickers : [];
    const has = (t) => universe.some((x) => x.ticker === t);
    const st = {
      tickers: ['AAPL', 'JPM', 'JNJ', 'XOM', 'KO', 'WMT'].filter(has),
      range: '5Y',
      method: 'minvar',
      rebalance: 'quarter',
      costBps: 5,
      rf: 2,
      tableView: {},
    };
    // Settings from a shared link: ?pt=AAPL,JPM&pm=minvar&pr=quarter&pg=5Y&pc=5&prf=2#portfolio
    const q = new URLSearchParams(location.search);
    const pt = (q.get('pt') || '').split(',').map((t) => t.trim().toUpperCase()).filter((t, i, a) => has(t) && a.indexOf(t) === i).slice(0, 12);
    if (pt.length >= 2) st.tickers = pt;
    if (METHODS[q.get('pm')]) st.method = q.get('pm');
    if (['month', 'quarter', 'year', 'none'].includes(q.get('pr'))) st.rebalance = q.get('pr');
    if (['3Y', '5Y', '10Y', 'ALL'].includes(q.get('pg'))) st.range = q.get('pg');
    const qn = (k, lo, hi, def) => { const v = parseFloat(q.get(k)); return isFinite(v) ? Math.min(hi, Math.max(lo, v)) : def; };
    st.costBps = qn('pc', 0, 200, st.costBps);
    st.rf = qn('prf', 0, 20, st.rf);
    const link = () => location.origin + location.pathname + '?' + new URLSearchParams({
      pt: st.tickers.join(','), pm: st.method, pr: st.rebalance, pg: st.range, pc: st.costBps, prf: st.rf,
    }).toString();
    let built = false, els = {}, result = null, token = 0;

    function card(title, sub, span, chartKey) {
      const art = h('article', 'card' + (span ? ' span-2' : ''));
      const head = h('header', 'card-head');
      const t = h('div');
      t.append(h('h2', null, title));
      if (sub) t.append(h('p', 'card-sub', sub));
      head.append(t);
      if (chartKey) {
        const actions = h('div', 'card-actions');
        const btn = h('button', 'btn btn-ghost btn-sm', 'ดูเป็นตาราง');
        btn.type = 'button';
        btn.setAttribute('aria-pressed', 'false');
        btn.addEventListener('click', () => {
          st.tableView[chartKey] = !st.tableView[chartKey];
          btn.setAttribute('aria-pressed', st.tableView[chartKey]);
          btn.textContent = st.tableView[chartKey] ? 'ดูเป็นกราฟ' : 'ดูเป็นตาราง';
          render();
        });
        actions.append(btn);
        head.append(actions);
      }
      const body = h('div', 'chart');
      art.append(head, body);
      return { art, body };
    }

    function build() {
      built = true;
      container.textContent = '';
      const ctl = h('section', 'card controls port-controls');
      ctl.setAttribute('aria-label', 'ตั้งค่าพอร์ต');
      ctl.append(h('h2', null, 'พอร์ตหลายหุ้น'),
        h('p', 'card-sub', 'เลือกหุ้น 2–12 ตัว แล้วดูว่าการกระจายความเสี่ยงและวิธีจัดน้ำหนักแบบต่าง ๆ ให้ผลอย่างไร น้ำหนักทุกครั้งที่ปรับคำนวณจากข้อมูล 1 ปีก่อนหน้าเท่านั้น (ไม่รู้อนาคต) · Paulos บท 7 หน้า 141–162'));

      const row1 = h('div', 'control-row');
      const chipField = h('div', 'field port-chips-field');
      chipField.append(h('span', 'field-label', 'หุ้นในพอร์ต'));
      els.chips = h('div', 'port-chips');
      chipField.append(els.chips);
      const addField = h('label', 'field');
      addField.append(h('span', 'field-label', 'เพิ่มหุ้น'));
      els.add = h('select');
      addField.append(els.add);
      els.add.addEventListener('change', () => {
        const t = els.add.value;
        if (t && !st.tickers.includes(t) && st.tickers.length < 12) { st.tickers.push(t); update(); }
        els.add.value = '';
      });
      row1.append(chipField, addField);

      const row2 = h('div', 'control-row');
      const rangeField = h('div', 'field');
      const rl = h('span', 'field-label', 'ช่วงเวลา');
      rl.id = 'portRangeLabel';
      els.range = h('div', 'segmented');
      els.range.setAttribute('role', 'group');
      els.range.setAttribute('aria-labelledby', 'portRangeLabel');
      for (const [k, label] of [['3Y', '3 ปี'], ['5Y', '5 ปี'], ['10Y', '10 ปี'], ['ALL', 'ทั้งหมด']]) {
        const b = h('button', null, label);
        b.type = 'button';
        b.dataset.range = k;
        b.addEventListener('click', () => { st.range = k; update(); });
        els.range.append(b);
      }
      rangeField.append(rl, els.range);
      const sel = (label, opts, value, onChange) => {
        const f = h('label', 'field');
        f.append(h('span', 'field-label', label));
        const s = h('select');
        for (const [v, t] of opts) { const o = h('option', null, t); o.value = v; s.append(o); }
        s.value = value;
        s.addEventListener('change', () => onChange(s.value));
        f.append(s);
        return f;
      };
      const numIn = (label, value, min, max, step, onChange) => {
        const f = h('label', 'field field-sm');
        f.append(h('span', 'field-label', label));
        const i = h('input');
        Object.assign(i, { type: 'number', min, max, step, value });
        i.addEventListener('change', () => {
          const v = Math.min(max, Math.max(min, parseFloat(i.value)));
          i.value = isFinite(v) ? v : value;
          onChange(+i.value);
        });
        f.append(i);
        return f;
      };
      row2.append(rangeField,
        sel('วิธีจัดน้ำหนัก (เส้นหลักในกราฟ)', Object.entries(METHODS).map(([k, m]) => [k, m.name]), st.method, (v) => { st.method = v; render(); }),
        sel('ปรับสัดส่วน', [['month', 'ทุกเดือน'], ['quarter', 'ทุกไตรมาส'], ['year', 'ทุกปี'], ['none', 'ไม่ปรับเลย (ซื้อแล้วถือ)']], st.rebalance, (v) => { st.rebalance = v; update(); }),
        numIn('ค่าธรรมเนียม (bps)', st.costBps, 0, 200, 0.5, (v) => { st.costBps = v; update(); }),
        numIn('Risk-free (%/ปี)', st.rf, 0, 20, 0.25, (v) => { st.rf = v; update(); }));
      const share = h('button', 'btn btn-outline', 'คัดลอกลิงก์การตั้งค่านี้');
      share.type = 'button';
      share.addEventListener('click', () => onShare && onShare(link(), share));
      row2.append(share);
      els.status = h('p', 'status');
      els.status.setAttribute('role', 'status');
      els.status.setAttribute('aria-live', 'polite');
      ctl.append(row1, row2, els.status);

      const grid = h('section', 'grid');
      els.equity = card('มูลค่าพอร์ต (เริ่ม 100)', 'วิธีที่เลือก เทียบน้ำหนักเท่ากันและ SPY (ดัชนี S&P 500)', true, 'equity');
      els.compare = card('เปรียบเทียบวิธีจัดน้ำหนัก', 'ผลจริงของแต่ละวิธีในช่วงเดียวกัน · Sharpe = ผลตอบแทนส่วนเกินต่อความผันผวน (Paulos หน้า 158)', true);
      els.weights = card('น้ำหนักล่าสุด', 'สัดส่วนที่แต่ละวิธีถืออยู่ตอนปรับครั้งล่าสุด', false);
      els.corr = card('Correlation ระหว่างหุ้น', 'ใกล้ 1 = ขึ้นลงพร้อมกัน (กระจายความเสี่ยงได้น้อย) · ใกล้ 0 หรือติดลบ = ช่วยลดความเสี่ยง (Paulos หน้า 149–154)', false);
      els.frontier = card('Efficient frontier', 'ทุกจุดบนเส้นคือพอร์ตที่ผลตอบแทนสูงสุดในแต่ละระดับความเสี่ยง (Markowitz, Paulos หน้า 156–157) · เส้นนี้คำนวณจากข้อมูลทั้งช่วง ซึ่งรู้ผลย้อนหลังแล้ว จึงดีกว่าที่ทำได้จริง', true, 'frontier');
      els.div = card('การกระจายความเสี่ยงช่วยได้แค่ไหน', null, true);
      grid.append(els.equity.art, els.compare.art, els.weights.art, els.corr.art, els.frontier.art, els.div.art);
      container.append(ctl, grid);
      update();
    }

    function syncControls() {
      els.chips.textContent = '';
      for (const t of st.tickers) {
        const b = h('button', 'btn btn-outline btn-sm port-chip');
        b.type = 'button';
        b.append(document.createTextNode(t + ' '));
        const x = h('span', null, '×');
        x.setAttribute('aria-hidden', 'true');
        b.append(x);
        b.setAttribute('aria-label', 'เอา ' + t + ' ออก');
        b.disabled = st.tickers.length <= 2;
        b.addEventListener('click', () => { st.tickers = st.tickers.filter((v) => v !== t); update(); });
        els.chips.append(b);
      }
      els.add.textContent = '';
      const first = h('option', null, st.tickers.length >= 12 ? 'ครบ 12 ตัวแล้ว' : 'เลือกหุ้น…');
      first.value = '';
      els.add.append(first);
      els.add.disabled = st.tickers.length >= 12;
      for (const u of universe) {
        if (st.tickers.includes(u.ticker)) continue;
        const o = h('option', null, u.ticker + ' · ' + u.name);
        o.value = u.ticker;
        els.add.append(o);
      }
      for (const b of els.range.children) {
        const on = b.dataset.range === st.range;
        b.classList.toggle('is-active', on);
        b.setAttribute('aria-pressed', on);
      }
    }

    function setStatus(msg, err) {
      els.status.textContent = msg;
      els.status.classList.toggle('is-error', !!err);
    }

    function update() {
      syncControls();
      const my = ++token;
      setStatus('กำลังโหลดราคา…');
      const need = [...new Set(st.tickers.concat(has('SPY') ? ['SPY'] : []))];
      Promise.all(need.map((t) => QL.data.loadStock(t))).then((list) => {
        if (my !== token) return;
        const byT = Object.fromEntries(need.map((t, i) => [t, list[i]]));
        compute(byT);
        render();
      }).catch((e) => { if (my === token) setStatus(e.message, true); });
    }

    function compute(byT) {
      const al = align(st.tickers.map((t) => byT[t]));
      const dates = al.dates, n = dates.length;
      const R = al.close.map(returnsOf);
      const yrs = { '3Y': 3, '5Y': 5, '10Y': 10 }[st.range];
      let s = 0;
      if (yrs) {
        const from = dates[n - 1] - yrs * 365.25 * 86400000;
        while (s < n - 1 && dates[s] < from) s++;
      }
      const e = n - 1;
      if (e - s < 120) {
        result = null;
        setStatus('ช่วงที่หุ้นทุกตัวมีราคาพร้อมกันสั้นเกินไป ลองเอาหุ้นที่เพิ่งเข้าตลาดออก หรือเลือกช่วงอื่น', true);
        return;
      }
      const times = dates.slice(s, e + 1);
      const o = { rebalance: st.rebalance === 'none' ? null : st.rebalance, costBps: st.costBps, rf: st.rf };
      const runs = {};
      for (const k of Object.keys(METHODS)) {
        const r = backtest(dates, R, s, e, Object.assign({ method: k }, o));
        r.metrics = BT.metrics(times, r.equity, r.rets, null, null, st.rf);
        runs[k] = r;
      }
      let spy = null;
      if (byT.SPY) {
        const m = new Map(byT.SPY.dates.map((t, i) => [t, byT.SPY.close[i]]));
        let prev = null;
        const px = times.map((t) => (prev = m.has(t) ? m.get(t) : prev));
        if (px[0] != null) {
          const eq = px.map((p) => (100 * p) / px[0]);
          const rr = eq.map((v, i) => (i ? v / eq[i - 1] - 1 : 0));
          spy = { equity: eq, metrics: BT.metrics(times, eq, rr, null, null, st.rf) };
        }
      }
      const est = estimate(R, s, e);
      const singles = st.tickers.map((t, i) => {
        const eq = times.map((_, k) => (100 * al.close[i][s + k]) / al.close[i][s]);
        return { t, metrics: BT.metrics(times, eq, R[i].slice(s, e + 1), null, null, st.rf), mu: est.mu[i], vol: Math.sqrt(est.cov[i][i]) };
      });
      result = { dates, times, runs, spy, est, singles, front: frontier(est.cov, est.mu, 40, 400) };
      const short = s < YEAR ? ' · ข้อมูลก่อนช่วงทดสอบมีไม่ถึง 1 ปี ช่วงแรกจึงใช้น้ำหนักเท่ากันจนกว่าจะมีข้อมูลพอ' : '';
      setStatus(st.tickers.length + ' หุ้น · ' + isoDate(dates[s]) + ' ถึง ' + isoDate(dates[e]) + ' · ราคาปิดปรับปันผลแล้ว' + short);
    }

    function render() {
      if (!result) {
        for (const k of ['equity', 'compare', 'weights', 'corr', 'frontier', 'div']) els[k].body.textContent = '';
        return;
      }
      const r = result, M = METHODS[st.method];
      renderEquity(r, M);
      renderCompare(r);
      renderWeights(r);
      renderCorr(r);
      renderFrontier(r);
      renderDiv(r);
    }

    function renderEquity(r, M) {
      const series = [{ name: M.name, values: r.runs[st.method].equity, color: 1 }];
      if (st.method !== 'equal') series.push({ name: METHODS.equal.name, values: r.runs.equal.equity, color: 2 });
      if (r.spy) series.push({ name: 'SPY (S&P 500)', values: r.spy.equity, color: 3 });
      if (st.tableView.equity) {
        const step = Math.max(1, Math.floor(r.times.length / 60));
        const rows = [];
        for (let i = 0; i < r.times.length; i += step) {
          const row = { d: isoDate(r.times[i]) };
          series.forEach((s, k) => (row['s' + k] = num(s.values[i], 1)));
          rows.push(row);
        }
        C.table(els.equity.body, [{ key: 'd', label: 'วันที่' }].concat(series.map((s, k) => ({ key: 's' + k, label: s.name, num: true }))), rows, { caption: 'มูลค่าพอร์ต' });
        return;
      }
      C.lineChart(els.equity.body, {
        times: r.times, series, yFormat: (v) => num(v, v >= 1000 ? 0 : 1), log: true, ariaLabel: 'กราฟมูลค่าพอร์ต',
      });
    }

    function renderCompare(r) {
      const row = (name, m, extra) => Object.assign({
        name,
        cagr: { text: (m.cagr >= 0 ? '▲ ' : '▼ ') + pct(m.cagr), cls: m.cagr >= 0 ? 'is-good' : 'is-bad' },
        vol: pct(m.vol, 1, false),
        sharpe: num(m.sharpe),
        dd: pct(m.maxDD),
      }, extra);
      const rows = Object.entries(METHODS).map(([k, M]) => row(M.name + (k === st.method ? ' (เลือกอยู่)' : ''), r.runs[k].metrics,
        { turn: r.runs[k].turnoverPerYear ? (r.runs[k].turnoverPerYear * 100).toFixed(0) + '%' : '0%', _cls: k === st.method ? 'is-selected' : '' }));
      if (r.spy) rows.push(row('SPY (S&P 500)', r.spy.metrics, { turn: '—' }));
      const avg = (f) => r.singles.reduce((a, x) => a + f(x.metrics), 0) / r.singles.length;
      rows.push(row('หุ้นเดี่ยวเฉลี่ย (ถือตัวเดียว)', { cagr: avg((m) => m.cagr), vol: avg((m) => m.vol), sharpe: avg((m) => m.sharpe), maxDD: avg((m) => m.maxDD) }, { turn: '—' }));
      C.table(els.compare.body, [
        { key: 'name', label: 'วิธี' },
        { key: 'cagr', label: 'CAGR', num: true },
        { key: 'vol', label: 'ผันผวน/ปี', num: true },
        { key: 'sharpe', label: 'Sharpe', num: true },
        { key: 'dd', label: 'Max DD', num: true },
        { key: 'turn', label: 'ซื้อขายต่อปี', num: true },
      ], rows, { caption: 'เปรียบเทียบวิธีจัดน้ำหนัก' });
      els.compare.body.append(h('p', 'sweep-axis', 'ซื้อขายต่อปี = มูลค่าที่ต้องซื้อขายเพื่อปรับสัดส่วน คิดเป็น % ของพอร์ตต่อปี ยิ่งมากยิ่งเสียค่าธรรมเนียมมาก · Sharpe สูงสุดใช้ผลตอบแทนย้อนหลัง 1 ปีซึ่งแกว่งมาก น้ำหนักจึงเปลี่ยนบ่อยและมักไม่ได้ดีอย่างที่ชื่อบอก'));
    }

    function renderWeights(r) {
      const rows = st.tickers.map((t, i) => {
        const row = { t };
        for (const k of Object.keys(METHODS)) row[k] = (r.runs[k].last.w[i] * 100).toFixed(1) + '%';
        return row;
      });
      const cash = { t: 'เงินสด' };
      for (const k of Object.keys(METHODS)) cash[k] = (Math.max(0, 1 - r.runs[k].last.w.reduce((a, b) => a + b, 0)) * 100).toFixed(1) + '%';
      rows.push(cash);
      C.table(els.weights.body, [{ key: 't', label: 'หุ้น' }].concat(Object.entries(METHODS).map(([k, M]) => ({ key: k, label: M.name, num: true }))), rows, { caption: 'น้ำหนักล่าสุด' });
      els.weights.body.append(h('p', 'sweep-axis', st.rebalance === 'none'
        ? 'ไม่ปรับสัดส่วน: น้ำหนักนี้คือตอนเริ่ม หลังจากนั้นจะเปลี่ยนไปตามราคา'
        : 'ปรับครั้งล่าสุดวันที่ ' + isoDate(r.dates[r.runs[st.method].last.t]) + ' โดยใช้ข้อมูล 1 ปีก่อนหน้า'));
    }

    function renderCorr(r) {
      const sd = r.est.cov.map((row, i) => Math.sqrt(row[i]));
      const corr = r.est.cov.map((row, i) => row.map((c, j) => c / (sd[i] * sd[j])));
      C.heatmap(els.corr.body, {
        cols: st.tickers,
        rows: st.tickers.map((t, i) => ({ label: t, values: corr[i] })),
        total: false,
        lim: 1,
        cls: 'sweep',
        corner: '',
        format: (v) => num(v),
        valueName: 'Correlation',
        cellLabel: (i, j) => st.tickers[i] + ' กับ ' + st.tickers[j],
        caption: 'Correlation ของผลตอบแทนรายวัน',
      });
    }

    function renderFrontier(r) {
      const groups = [
        { name: 'หุ้นแต่ละตัว', color: 2, shape: 'dot' },
        { name: 'วิธีจัดน้ำหนัก (ผลจริง)', color: 3, shape: 'rect' },
      ];
      const pts = r.singles.map((x) => ({ x: x.vol, y: x.mu, group: 0, label: x.t, name: x.t }));
      const short = { equal: 'EW', invvol: 'IV', minvar: 'MV', maxsharpe: 'MS', momentum: 'MO', trend: 'TR' };
      for (const [k, M] of Object.entries(METHODS)) {
        const m = r.runs[k].metrics;
        const rets = r.runs[k].rets.slice(1);
        const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
        pts.push({ x: m.vol, y: mean * YEAR, group: 1, label: short[k], name: M.name + ' (' + short[k] + ')' });
      }
      const line = r.front.map((p) => ({ x: p.vol, y: p.ret }));
      if (st.tableView.frontier) {
        C.table(els.frontier.body, [
          { key: 'name', label: 'จุด' },
          { key: 'y', label: 'ผลตอบแทนเฉลี่ย/ปี', num: true },
          { key: 'x', label: 'ความผันผวน/ปี', num: true },
        ], pts.map((p) => ({ name: p.name, y: pct(p.y), x: pct(p.x, 1, false) }))
          .concat(line.filter((_, i) => i % 8 === 0).map((p, i) => ({ name: 'frontier จุดที่ ' + (i + 1), y: pct(p.y), x: pct(p.x, 1, false) }))),
        { caption: 'จุดบนกราฟ efficient frontier' });
        return;
      }
      C.scatter(els.frontier.body, {
        groups, points: pts, line, lineName: 'Efficient frontier (มองย้อนหลัง)', lineColor: 1,
        xFormat: (v) => (v * 100).toFixed(0) + '%', yFormat: (v) => (v * 100).toFixed(0) + '%',
        xLabel: 'ความผันผวน/ปี (ความเสี่ยง)', yLabel: 'ผลตอบแทนเฉลี่ย/ปี', ariaLabel: 'Efficient frontier',
      });
      els.frontier.body.append(h('p', 'sweep-axis', 'EW = เท่ากัน · IV = ตามความผันผวน · MV = ความเสี่ยงต่ำสุด · MS = Sharpe สูงสุด · MO = Momentum · TR = ตามเทรนด์ · จุดของวิธีจัดน้ำหนักใช้ผลจริงที่ไม่รู้อนาคต จึงมักอยู่ใต้เส้น'));
    }

    function renderDiv(r) {
      const body = els.div.body;
      body.textContent = '';
      const n = st.tickers.length;
      const avgVol = r.singles.reduce((a, x) => a + x.metrics.vol, 0) / n;
      const ewVol = r.runs.equal.metrics.vol;
      const sd = r.est.cov.map((row, i) => Math.sqrt(row[i]));
      let sum = 0, cnt = 0;
      for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) { sum += r.est.cov[i][j] / (sd[i] * sd[j]); cnt++; }
      const rho = cnt ? sum / cnt : NaN;
      const floor = avgVol * Math.sqrt(Math.max(rho, 0));
      const tiles = h('div', 'math-tiles');
      const tile = (title, value, sub, pages) => {
        const t = h('div', 'math-tile');
        t.append(h('h3', 'kpi-label', title), h('p', 'math-value', value), h('p', 'kpi-sub', sub), h('p', 'math-ref', 'Paulos หน้า ' + pages));
        return t;
      };
      tiles.append(
        tile('ความเสี่ยงลดลง', pct(ewVol / avgVol - 1),
          'หุ้นเดี่ยวผันผวนเฉลี่ย ' + pct(avgVol, 1, false) + '/ปี แต่ถือรวมกันแบบน้ำหนักเท่ากันเหลือ ' + pct(ewVol, 1, false) + '/ปี', '149–154'),
        tile('Correlation เฉลี่ย', num(rho),
          'ยิ่งต่ำยิ่งกระจายความเสี่ยงได้ดี ถ้าทุกคู่เป็น 1 การถือหลายตัวจะไม่ช่วยลดความเสี่ยงเลย', '151–154'),
        tile('ความเสี่ยงที่ลดไม่ได้', '≈ ' + pct(floor, 1, false),
          'ต่อให้ถือหุ้นแบบนี้เป็นร้อยตัว ความผันผวนจะไม่ต่ำกว่าราวนี้ เพราะหุ้นทุกตัวขยับตามตลาด (systematic risk) ส่วนที่เหลือเป็นความเสี่ยงเฉพาะตัวที่กระจายออกได้', '162'));
      body.append(tiles);
      const p = h('p', 'math-verdict ' + (ewVol < avgVol ? 'is-good' : 'is-bad'));
      const icon = h('span', null, ewVol < avgVol ? '✓ ' : '⚠ ');
      icon.setAttribute('aria-hidden', 'true');
      p.append(icon, document.createTextNode(ewVol < avgVol
        ? 'การถือ ' + n + ' ตัวลดความผันผวนได้ ' + pct(1 - ewVol / avgVol, 0, false) + ' เทียบกับถือตัวเดียว ลองเพิ่มหุ้นต่างกลุ่มเพื่อดูว่าลดได้อีกแค่ไหน'
        : 'หุ้นที่เลือกเคลื่อนไหวไปทางเดียวกันมาก การถือหลายตัวแทบไม่ลดความเสี่ยง ลองเพิ่มหุ้นจากกลุ่มอื่น'));
      body.append(p);
    }

    let resizeTimer = null;
    window.addEventListener('resize', () => {
      if (!built || container.hidden) return;
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(render, 150);
    });

    return { show: () => { if (!built) build(); else render(); } };
  }

  QL.portfolioView = { init };
})((window.QL = window.QL || {}));
