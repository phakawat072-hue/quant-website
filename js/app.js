(function (QL) {
  'use strict';

  const { ASSETS, simulate, parseCsv, DAY } = QL.data;
  const { STRATEGIES, defaults } = QL.strategies;
  const BT = QL.backtest;
  const C = QL.charts;
  const $ = (id) => document.getElementById(id);

  const state = {
    assetId: 'index',
    seed: 42,
    data: null,
    csvData: null,
    range: '5Y',
    s: 0,
    e: 0,
    strategy: 'sma',
    params: Object.fromEntries(Object.keys(STRATEGIES).map((k) => [k, defaults(k)])),
    costBps: 5,
    rf: 2,
    allowShort: false,
    log: false,
    tableView: {},
    pos: null,
    res: null,
  };

  // ---------- formatting ----------
  const pct = (v, d = 1, sign = true) => {
    if (!isFinite(v)) return '—';
    const s = (v * 100).toFixed(d);
    if (+s === 0) return (0).toFixed(d) + '%';
    return (sign && v > 0 ? '+' : '') + s + '%';
  };
  const num = (v, d = 2) => (!isFinite(v) ? (v === Infinity ? '∞' : '—') : v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }));
  const compact = (v) => {
    const a = Math.abs(v);
    if (a >= 1e6) return (v / 1e6).toFixed(a >= 1e7 ? 0 : 1) + 'M';
    if (a >= 1e4) return (v / 1e3).toFixed(a >= 1e5 ? 0 : 1) + 'K';
    if (a >= 100) return v.toLocaleString('en-US', { maximumFractionDigits: 0 });
    if (a >= 1) return v.toLocaleString('en-US', { maximumFractionDigits: 2 });
    return v.toPrecision(2);
  };
  const isoDate = (t) => new Date(t).toISOString().slice(0, 10);

  function setStatus(msg, isError) {
    const el = $('status');
    el.textContent = msg || '';
    el.classList.toggle('is-error', !!isError);
  }

  // ---------- data & range ----------
  function loadData() {
    if (state.assetId === 'csv' && state.csvData) state.data = state.csvData;
    else state.data = simulate(ASSETS.find((a) => a.id === state.assetId) || ASSETS[0], state.seed);
    applyRange(state.range);
  }

  function indexAtOrAfter(t) {
    const d = state.data.dates;
    let i = d.findIndex((x) => x >= t);
    return i < 0 ? d.length - 1 : i;
  }

  function applyRange(range) {
    const d = state.data.dates;
    state.range = range;
    state.e = d.length - 1;
    if (range === 'ALL') state.s = 0;
    else {
      const years = parseInt(range, 10);
      const end = new Date(d[state.e]);
      const start = Date.UTC(end.getUTCFullYear() - years, end.getUTCMonth(), end.getUTCDate());
      state.s = indexAtOrAfter(start);
    }
    ensureMinWindow();
    syncRangeUi();
  }

  function ensureMinWindow() {
    if (state.e - state.s < 20) state.s = Math.max(0, state.e - 20);
  }

  function syncRangeUi() {
    const d = state.data.dates;
    for (const b of $('rangeGroup').querySelectorAll('button')) {
      const on = b.dataset.range === state.range;
      b.classList.toggle('is-active', on);
      b.setAttribute('aria-pressed', on);
    }
    const min = isoDate(d[0]), max = isoDate(d[d.length - 1]);
    for (const id of ['startDate', 'endDate']) { $(id).min = min; $(id).max = max; }
    $('startDate').value = isoDate(d[state.s]);
    $('endDate').value = isoDate(d[state.e]);
  }

  // ---------- controls ----------
  function buildControls() {
    const sel = $('assetSelect');
    for (const a of ASSETS) {
      const o = document.createElement('option');
      o.value = a.id;
      o.textContent = a.ticker + ' · ' + a.label + ' (จำลอง)';
      sel.appendChild(o);
    }
    sel.value = state.assetId;
    sel.addEventListener('change', () => {
      state.assetId = sel.value;
      loadData();
      run();
    });

    const ss = $('strategySelect');
    for (const [k, s] of Object.entries(STRATEGIES)) {
      const o = document.createElement('option');
      o.value = k;
      o.textContent = s.name;
      ss.appendChild(o);
    }
    ss.value = state.strategy;
    ss.addEventListener('change', () => selectStrategy(ss.value));

    $('rangeGroup').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-range]');
      if (!b) return;
      applyRange(b.dataset.range);
      run();
    });

    const onDate = () => {
      const s = Date.parse($('startDate').value), e = Date.parse($('endDate').value);
      if (!isFinite(s) || !isFinite(e)) return;
      if (s >= e) { setStatus('วันเริ่มต้นต้องมาก่อนวันสิ้นสุด', true); return; }
      state.range = 'CUSTOM';
      state.s = indexAtOrAfter(s);
      const d = state.data.dates;
      let ei = d.length - 1;
      while (ei > 0 && d[ei] > e) ei--;
      state.e = ei;
      ensureMinWindow();
      syncRangeUi();
      run();
    };
    $('startDate').addEventListener('change', onDate);
    $('endDate').addEventListener('change', onDate);

    $('costInput').addEventListener('change', (e) => {
      state.costBps = clamp(parseFloat(e.target.value), 0, 200, 5);
      e.target.value = state.costBps;
      run();
    });
    $('rfInput').addEventListener('change', (e) => {
      state.rf = clamp(parseFloat(e.target.value), 0, 20, 2);
      e.target.value = state.rf;
      run();
    });
    $('shortInput').addEventListener('change', (e) => { state.allowShort = e.target.checked; run(); });
    $('logInput').addEventListener('change', (e) => { state.log = e.target.checked; renderEquity(); });

    $('reseedBtn').addEventListener('click', () => {
      state.seed = (Math.random() * 1e9) >>> 0;
      if (state.assetId === 'csv') { state.assetId = ASSETS[0].id; $('assetSelect').value = state.assetId; }
      loadData();
      run();
      setStatus('สุ่มราคาจำลองชุดใหม่แล้ว (seed ' + state.seed + ')');
    });

    $('csvInput').addEventListener('change', (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          state.csvData = parseCsv(String(reader.result), file.name);
          let opt = sel.querySelector('option[value="csv"]');
          if (!opt) { opt = document.createElement('option'); opt.value = 'csv'; sel.appendChild(opt); }
          opt.textContent = 'ไฟล์: ' + state.csvData.name;
          state.assetId = 'csv';
          sel.value = 'csv';
          loadData();
          run();
          setStatus('โหลด ' + state.csvData.name + ' แล้ว: ' + state.csvData.dates.length.toLocaleString('en-US') + ' แถว');
        } catch (err) {
          setStatus('อ่านไฟล์ไม่สำเร็จ: ' + err.message, true);
        }
        e.target.value = '';
      };
      reader.onerror = () => setStatus('อ่านไฟล์ไม่สำเร็จ', true);
      reader.readAsText(file);
    });

    $('exportBtn').addEventListener('click', exportCsv);

    for (const btn of document.querySelectorAll('[data-toggle-table]')) {
      btn.addEventListener('click', () => {
        const key = btn.closest('[data-chart]').dataset.chart;
        state.tableView[key] = !state.tableView[key];
        btn.setAttribute('aria-pressed', state.tableView[key]);
        btn.textContent = state.tableView[key] ? 'ดูเป็นกราฟ' : 'ดูเป็นตาราง';
        renderCharts();
      });
    }

    $('themeToggle').addEventListener('click', toggleTheme);
    syncThemeLabel();
    buildParams();
  }

  function clamp(v, lo, hi, fallback) {
    if (!isFinite(v)) return fallback;
    return Math.min(hi, Math.max(lo, v));
  }

  function selectStrategy(key) {
    state.strategy = key;
    $('strategySelect').value = key;
    buildParams();
    run();
  }

  function buildParams() {
    const box = $('paramFields');
    box.textContent = '';
    const strat = STRATEGIES[state.strategy];
    $('strategyDesc').textContent = strat.desc;
    for (const p of strat.params) {
      const label = document.createElement('label');
      label.className = 'field field-sm';
      const span = document.createElement('span');
      span.className = 'field-label';
      span.textContent = p.label;
      const input = document.createElement('input');
      Object.assign(input, { type: 'number', min: p.min, max: p.max, step: p.step, value: state.params[state.strategy][p.key] });
      input.addEventListener('change', () => {
        const v = clamp(parseFloat(input.value), p.min, p.max, p.def);
        const rounded = p.step >= 1 ? Math.round(v) : v;
        input.value = rounded;
        state.params[state.strategy][p.key] = rounded;
        run();
      });
      label.append(span, input);
      box.appendChild(label);
    }
  }

  // ---------- theme ----------
  function effectiveTheme() {
    const t = document.documentElement.getAttribute('data-theme');
    if (t) return t;
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  function syncThemeLabel() {
    $('themeLabel').textContent = effectiveTheme() === 'dark' ? 'ธีมสว่าง' : 'ธีมมืด';
  }
  function toggleTheme() {
    const next = effectiveTheme() === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    try { localStorage.setItem('ql-theme', next); } catch (e) { /* storage unavailable */ }
    syncThemeLabel();
    if (state.res) renderHeatmap();
  }
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    syncThemeLabel();
    if (state.res) renderHeatmap();
  });

  // ---------- run ----------
  function runStrategy(key, params) {
    const strat = STRATEGIES[key];
    const pos = strat.signal(state.data.close, params, state.allowShort);
    return { pos, res: BT.run(state.data, pos, state.s, state.e, { costBps: state.costBps, rf: state.rf }) };
  }

  function run() {
    const strat = STRATEGIES[state.strategy];
    const p = state.params[state.strategy];
    const err = strat.validate && strat.validate(p);
    if (err) { setStatus(err, true); return; }
    if ($('status').classList.contains('is-error')) setStatus('');
    document.body.classList.add('is-busy');
    const out = runStrategy(state.strategy, p);
    state.pos = out.pos;
    state.res = out.res;
    renderKpis();
    renderCharts();
    renderHeatmap();
    renderCompare();
    renderTrades();
    document.body.classList.remove('is-busy');
  }

  // ---------- KPIs ----------
  function kpiTile(label, value, sub, delta) {
    const art = document.createElement('article');
    art.className = 'card kpi';
    const h = document.createElement('h3');
    h.className = 'kpi-label';
    h.textContent = label;
    const v = document.createElement('p');
    v.className = 'kpi-value';
    v.textContent = value;
    art.append(h, v);
    if (delta) art.appendChild(deltaEl(delta));
    if (sub) {
      const s = document.createElement('p');
      s.className = 'kpi-sub';
      s.textContent = sub;
      art.appendChild(s);
    }
    return art;
  }

  function deltaEl({ diff, text, higherIsBetter }) {
    const p = document.createElement('p');
    p.className = 'delta';
    if (!isFinite(diff) || Math.abs(diff) < 1e-9) {
      p.textContent = '= เท่ากับ Buy & Hold';
      return p;
    }
    const good = higherIsBetter ? diff > 0 : diff < 0;
    p.classList.add(good ? 'is-good' : 'is-bad');
    const icon = document.createElement('span');
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = diff > 0 ? '▲ ' : '▼ ';
    p.append(icon, document.createTextNode(text + ' vs Buy & Hold ' + (good ? '(ดีกว่า)' : '(แย่กว่า)')));
    return p;
  }

  function renderKpis() {
    const m = state.res.metrics, b = state.res.benchMetrics;
    const d = state.data.dates;
    $('heroValue').textContent = pct(m.total, 1);
    const hd = $('heroDelta');
    hd.replaceWith(Object.assign(deltaEl({ diff: m.total - b.total, text: pct(m.total - b.total, 1).replace('%', ' pp'), higherIsBetter: true }), { id: 'heroDelta' }));
    $('heroSub').textContent =
      'เงิน 100 → ' + num(state.res.equity[state.res.equity.length - 1], 2) +
      ' · ' + state.data.name + ' · ' + isoDate(d[state.s]) + ' ถึง ' + isoDate(d[state.e]) +
      ' (' + m.years.toFixed(1) + ' ปี)';

    const pp = (x) => (x > 0 ? '+' : '') + (x * 100).toFixed(1) + ' pp';
    const sd = (x) => (x > 0 ? '+' : '') + x.toFixed(2);
    const grid = $('kpiGrid');
    grid.textContent = '';
    grid.append(
      kpiTile('CAGR (ต่อปี)', pct(m.cagr), 'Buy & Hold ' + pct(b.cagr), { diff: m.cagr - b.cagr, text: pp(m.cagr - b.cagr), higherIsBetter: true }),
      kpiTile('Sharpe Ratio', num(m.sharpe), 'Buy & Hold ' + num(b.sharpe), { diff: m.sharpe - b.sharpe, text: sd(m.sharpe - b.sharpe), higherIsBetter: true }),
      kpiTile('Sortino Ratio', num(m.sortino), 'Buy & Hold ' + num(b.sortino), { diff: m.sortino - b.sortino, text: sd(m.sortino - b.sortino), higherIsBetter: true }),
      kpiTile('Max Drawdown', pct(m.maxDD), 'Buy & Hold ' + pct(b.maxDD), { diff: m.maxDD - b.maxDD, text: pp(m.maxDD - b.maxDD), higherIsBetter: true }),
      kpiTile('ความผันผวนต่อปี', pct(m.vol, 1, false), 'Buy & Hold ' + pct(b.vol, 1, false), { diff: m.vol - b.vol, text: pp(m.vol - b.vol), higherIsBetter: false }),
      kpiTile('Calmar Ratio', num(m.calmar), 'Buy & Hold ' + num(b.calmar), { diff: m.calmar - b.calmar, text: sd(m.calmar - b.calmar), higherIsBetter: true }),
      kpiTile('อัตราชนะ (Win rate)', pct(m.winRate, 0, false), 'Profit factor ' + num(m.profitFactor)),
      kpiTile('จำนวนเทรด', m.trades.toLocaleString('en-US'), 'ถือสถานะ ' + pct(m.exposure, 0, false) + ' ของเวลา'),
    );
  }

  // ---------- charts ----------
  function monthEndIndices(times) {
    const out = [];
    for (let i = 0; i < times.length; i++) {
      const next = times[i + 1];
      if (next === undefined || new Date(next).getUTCMonth() !== new Date(times[i]).getUTCMonth()) out.push(i);
    }
    return out;
  }

  function renderCharts() {
    if (!state.res) return;
    renderEquity();
    renderPrice();
    renderDrawdown();
    renderHist();
  }

  function renderEquity() {
    const r = state.res;
    const el = $('equityChart');
    const name = STRATEGIES[state.strategy].name;
    if (state.tableView.equity) {
      const dd = BT.drawdown(r.equity);
      C.table(el, [
        { key: 'date', label: 'วันที่ (สิ้นเดือน)' },
        { key: 'eq', label: name, num: true },
        { key: 'bh', label: 'Buy & Hold', num: true },
        { key: 'dd', label: 'Drawdown', num: true },
      ], monthEndIndices(r.times).reverse().map((i) => ({ date: isoDate(r.times[i]), eq: num(r.equity[i]), bh: num(r.bench[i]), dd: pct(dd[i]) })), { caption: 'Equity curve รายเดือน' });
      return;
    }
    C.lineChart(el, {
      times: r.times,
      series: [
        { name, values: r.equity, color: 1 },
        { name: 'Buy & Hold', values: r.bench, color: 2 },
      ],
      yFormat: (v) => compact(v),
      tipFormat: (v) => num(v),
      log: state.log,
      height: 320,
      ariaLabel: 'กราฟ Equity curve ของ ' + name + ' เทียบกับ Buy & Hold',
    });
  }

  function renderPrice() {
    const r = state.res;
    const el = $('priceChart');
    const strat = STRATEGIES[state.strategy];
    const close = state.data.close.slice(state.s, state.e + 1);
    const overlays = strat.overlays(state.data.close, state.params[state.strategy]).map((o) => ({ ...o, values: o.values.slice(state.s, state.e + 1) }));
    $('priceTitle').textContent = 'ราคา ' + state.data.name + ' และสัญญาณ';

    if (state.tableView.price) {
      const cols = [{ key: 'date', label: 'วันที่ (สิ้นเดือน)' }, { key: 'close', label: 'ราคาปิด', num: true }];
      overlays.forEach((o, k) => cols.push({ key: 'o' + k, label: o.legend === false ? o.name + ' (ล่าง)' : o.name, num: true }));
      cols.push({ key: 'pos', label: 'สถานะ' });
      const rows = monthEndIndices(r.times).reverse().map((i) => {
        const row = { date: isoDate(r.times[i]), close: num(close[i]), pos: posLabel(state.pos[state.s + i]) };
        overlays.forEach((o, k) => (row['o' + k] = num(o.values[i])));
        return row;
      });
      C.table(el, cols, rows, { caption: 'ราคาและอินดิเคเตอร์รายเดือน' });
      return;
    }

    const markers = [];
    let prev = 0;
    for (let k = 0; k < close.length; k++) {
      const p = state.pos[state.s + k];
      if (p !== prev) markers.push({ i: k, dir: Math.sign(p - prev) });
      prev = p;
    }
    C.lineChart(el, {
      times: r.times,
      series: [{ name: 'ราคาปิด', values: close, color: 1 }, ...overlays],
      markers: markers.length <= 400 ? markers : [],
      yFormat: (v) => compact(v),
      tipFormat: (v) => num(v),
      extraTip: (i) => [{ value: posLabel(state.pos[state.s + i]), name: 'สถานะหลังปิดวัน' }],
      height: 320,
      ariaLabel: 'กราฟราคา ' + state.data.name + ' พร้อมอินดิเคเตอร์และจุดซื้อขาย',
    });
  }

  function posLabel(p) {
    return p > 0 ? 'Long' : p < 0 ? 'Short' : 'ไม่มีสถานะ';
  }

  function renderDrawdown() {
    const r = state.res;
    const el = $('ddChart');
    const dd = BT.drawdown(r.equity);
    if (state.tableView.drawdown) {
      C.table(el, [{ key: 'date', label: 'วันที่ (สิ้นเดือน)' }, { key: 'dd', label: 'Drawdown', num: true }],
        monthEndIndices(r.times).reverse().map((i) => ({ date: isoDate(r.times[i]), dd: pct(dd[i]) })), { caption: 'Drawdown รายเดือน' });
      return;
    }
    C.lineChart(el, {
      times: r.times,
      series: [{ name: 'Drawdown', values: dd, color: 1, area: true }],
      yFormat: (v) => pct(v, 0),
      tipFormat: (v) => pct(v, 2),
      zero: true,
      height: 260,
      ariaLabel: 'กราฟ Drawdown ของกลยุทธ์',
    });
  }

  function renderHist() {
    const r = state.res;
    const el = $('histChart');
    const active = [];
    for (let k = 1; k < r.rets.length; k++) if (r.held[k] !== 0) active.push(r.rets[k]);
    $('histSub').textContent = 'เฉพาะวันที่ถือสถานะ (' + active.length.toLocaleString('en-US') + ' วัน) · จำนวนวันในแต่ละช่วงผลตอบแทน';
    if (active.length < 5) {
      el.textContent = '';
      const p = document.createElement('p');
      p.className = 'empty-state';
      p.textContent = 'กลยุทธ์ไม่ได้ถือสถานะในช่วงเวลานี้';
      el.appendChild(p);
      return;
    }
    const bins = BT.histogram(active, 31);
    if (state.tableView.hist) {
      C.table(el, [{ key: 'range', label: 'ช่วงผลตอบแทน' }, { key: 'count', label: 'จำนวนวัน', num: true }, { key: 'share', label: 'สัดส่วน', num: true }],
        bins.map((b) => ({ range: pct(b.x0, 2) + ' ถึง ' + pct(b.x1, 2), count: b.count, share: pct(b.count / bins.total, 1, false) })), { caption: 'การกระจายผลตอบแทนรายวัน' });
      return;
    }
    C.histogram(el, { bins, xFormat: (v) => pct(v, 1), color: 1, height: 260, ariaLabel: 'ฮิสโตแกรมผลตอบแทนรายวันของกลยุทธ์' });
  }

  function renderHeatmap() {
    const r = state.res;
    C.heatmap($('heatmap'), {
      rows: BT.monthlyReturns(r.times, r.equity).reverse(),
      format: (v) => pct(v, 1),
      caption: 'ผลตอบแทนรายเดือนของกลยุทธ์',
    });
  }

  function renderCompare() {
    const rows = [];
    let bestSharpe = -Infinity;
    const results = Object.keys(STRATEGIES).map((k) => {
      const p = state.params[k];
      const err = STRATEGIES[k].validate && STRATEGIES[k].validate(p);
      const res = err ? null : k === state.strategy ? state.res : runStrategy(k, p).res;
      if (res) bestSharpe = Math.max(bestSharpe, res.metrics.sharpe);
      return { k, res };
    });
    for (const { k, res } of results) {
      const s = STRATEGIES[k];
      const params = s.params.map((d) => state.params[k][d.key]).join(' / ');
      if (!res) { rows.push({ name: s.name, params, total: 'พารามิเตอร์ไม่ถูกต้อง' }); continue; }
      const m = res.metrics;
      const cls = (k === state.strategy ? 'is-selected' : '');
      rows.push({
        _cls: cls,
        _onClick: () => selectStrategy(k),
        name: (k === state.strategy ? '● ' : '') + s.name + (m.sharpe === bestSharpe ? '  ★ Sharpe สูงสุด' : ''),
        params: params || '—',
        total: pct(m.total),
        cagr: pct(m.cagr),
        sharpe: num(m.sharpe),
        maxdd: pct(m.maxDD),
        vol: pct(m.vol, 1, false),
        trades: m.trades.toLocaleString('en-US'),
      });
    }
    C.table($('compareTable'), [
      { key: 'name', label: 'กลยุทธ์' },
      { key: 'params', label: 'พารามิเตอร์' },
      { key: 'total', label: 'ผลตอบแทนรวม', num: true },
      { key: 'cagr', label: 'CAGR', num: true },
      { key: 'sharpe', label: 'Sharpe', num: true },
      { key: 'maxdd', label: 'Max DD', num: true },
      { key: 'vol', label: 'ความผันผวน', num: true },
      { key: 'trades', label: 'เทรด', num: true },
    ], rows, { caption: 'ตารางเปรียบเทียบกลยุทธ์', cls: 'clickable' });
  }

  function renderTrades() {
    const r = state.res;
    const d = state.data.dates, c = state.data.close;
    const trades = r.trades.slice().reverse();
    const shown = trades.slice(0, 200);
    $('tradeSub').textContent = trades.length
      ? 'ทั้งหมด ' + trades.length.toLocaleString('en-US') + ' เทรด' + (trades.length > shown.length ? ' · แสดงล่าสุด ' + shown.length + ' รายการ' : '') + ' · ผลตอบแทนหักค่าธรรมเนียมแล้ว'
      : 'ไม่มีการเทรดในช่วงเวลานี้';
    const rows = shown.map((t, i) => {
      const exitIdx = t.openEnd ? state.e : t.exit;
      return {
        n: trades.length - i,
        side: t.side > 0 ? 'Long' : 'Short',
        entry: isoDate(d[t.entry]),
        entryPx: num(c[t.entry]),
        exit: t.openEnd ? 'ยังถืออยู่' : isoDate(d[t.exit]),
        exitPx: num(c[exitIdx]),
        days: Math.round((d[exitIdx] - d[t.entry]) / DAY),
        ret: { text: (t.ret > 0 ? '▲ ' : t.ret < 0 ? '▼ ' : '') + pct(t.ret, 2), cls: t.ret > 0 ? 'is-good' : t.ret < 0 ? 'is-bad' : null },
      };
    });
    C.table($('tradeTable'), [
      { key: 'n', label: '#', num: true },
      { key: 'side', label: 'ฝั่ง' },
      { key: 'entry', label: 'วันเข้า' },
      { key: 'entryPx', label: 'ราคาเข้า', num: true },
      { key: 'exit', label: 'วันออก' },
      { key: 'exitPx', label: 'ราคาออก', num: true },
      { key: 'days', label: 'จำนวนวัน', num: true },
      { key: 'ret', label: 'ผลตอบแทน', num: true },
    ], rows, { caption: 'บันทึกการเทรด' });
  }

  function exportCsv() {
    const r = state.res;
    if (!r) return;
    const dd = BT.drawdown(r.equity);
    const lines = ['date,close,position,strategy_equity,buyhold_equity,drawdown'];
    for (let k = 0; k < r.times.length; k++) {
      const i = state.s + k;
      lines.push([isoDate(r.times[k]), state.data.close[i].toFixed(4), state.pos[i], r.equity[k].toFixed(4), r.bench[k].toFixed(4), dd[k].toFixed(6)].join(','));
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'backtest_' + state.data.name.replace(/[^\w-]+/g, '_') + '_' + state.strategy + '.csv';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  // ---------- init ----------
  buildControls();
  loadData();
  run();

  let lastWidth = 0, raf = 0;
  new ResizeObserver((entries) => {
    const w = entries[0].contentRect.width;
    if (Math.abs(w - lastWidth) < 2) return;
    lastWidth = w;
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(renderCharts);
  }).observe(document.querySelector('.grid'));
})(window.QL);
