(function (QL) {
  'use strict';

  const { ASSETS, simulate, parseCsv, DAY } = QL.data;
  const { STRATEGIES, defaults } = QL.strategies;
  const BT = QL.backtest;
  const C = QL.charts;
  const $ = (id) => document.getElementById(id);

  const manifest = QL.data.getManifest();
  const stocks = manifest ? manifest.tickers : [];

  const state = {
    assetId: stocks.length ? 'stock:' + (stocks.find((t) => t.ticker === 'AAPL') || stocks[0]).ticker : 'sim:index',
    loadedId: null,
    pendingLive: null,
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
    stop: { type: 'none', pct: 10 },
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
  let loadToken = 0;
  let assetSearch = null;

  async function loadData() {
    const token = ++loadToken;
    const id = state.assetId;
    let data;
    if (id === 'csv' && state.csvData) data = state.csvData;
    else if (id.startsWith('stock:') || id.startsWith('live:')) {
      const live = id.startsWith('live:');
      const sym = id.slice(id.indexOf(':') + 1);
      setStatus((live ? 'กำลังดึงข้อมูล ' + sym + ' จาก Twelve Data…' : 'กำลังโหลดข้อมูล ' + sym + '…'));
      document.body.classList.add('is-busy');
      try {
        data = live ? await QL.live.fetchSeries(sym, liveName(sym)) : await QL.data.loadStock(sym);
      } catch (err) {
        if (live && (err.code === 'no_key' || err.code === 'bad_key')) {
          state.pendingLive = id;
          showKeyPanel(true);
          if (err.code === 'no_key') err.message = 'ใส่ API key ของ Twelve Data (ฟรี) ในกล่องด้านบน เพื่อดึงราคา ' + sym;
        }
        throw err;
      } finally {
        if (token === loadToken) document.body.classList.remove('is-busy');
      }
      if (token !== loadToken) return false;
      setStatus('');
    } else {
      data = simulate(ASSETS.find((a) => 'sim:' + a.id === id) || ASSETS[0], state.seed);
    }
    state.data = data;
    state.loadedId = id;
    state.pendingLive = null;
    applyRange(state.range === 'CUSTOM' ? '5Y' : state.range);
    syncDataUi();
    return true;
  }

  async function loadAndRun() {
    try {
      if (await loadData()) run();
    } catch (err) {
      setStatus(err.message, err.code !== 'no_key');
      if (state.loadedId) {
        state.assetId = state.loadedId;
        syncDataUi();
        if (assetSearch) assetSearch.refresh(true);
      }
    }
  }

  function syncDataUi() {
    const id = state.assetId;
    $('reseedBtn').hidden = !id.startsWith('sim:');
    if (assetSearch) assetSearch.refresh();
    const info = $('dataInfo');
    const d = state.data;
    if (!d) { info.textContent = ''; return; }
    const span = isoDate(d.dates[0]) + ' ถึง ' + isoDate(d.dates[d.dates.length - 1]);
    if (d.source === 'stock') {
      info.textContent = d.name + ' · ' + d.label + ' · ราคาปิดปรับปันผลและการแตกหุ้นแล้ว จาก ' + (d.provider || 'Yahoo Finance') + ' · ' + span;
    } else if (d.source === 'live') {
      info.textContent = d.name + ' · ' + d.label + ' · ' + d.adjustedNote + ' · ดึงสดจาก Twelve Data · ' + span;
    } else if (d.source === 'csv') {
      info.textContent = 'ไฟล์ของคุณ · ' + d.dates.length.toLocaleString('en-US') + ' แถว · ' + span;
    } else {
      info.textContent = 'ราคาจำลองเพื่อทดลองระบบ ไม่ใช่ข้อมูลจริง';
    }
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
  const symbolKey = (s) => s.toUpperCase().replace(/[.\-]/g, '');
  let baseItems = null;

  function buildBaseItems() {
    const items = stocks.map((t) => ({ id: 'stock:' + t.ticker, ticker: t.ticker, name: t.name, group: 'หุ้นยอดนิยม (โหลดทันที) · ' + t.sector, tag: t.sector }));
    const bundled = new Set(stocks.map((t) => symbolKey(t.ticker)));
    for (const [sym, name, exch, etf] of QL.data.getSymbols()) {
      if (bundled.has(symbolKey(sym))) continue;
      items.push({ id: 'live:' + sym, ticker: sym, name, group: 'หุ้นสหรัฐทั้งหมด (ดึงสด)', tag: exch + (etf ? ' · ETF' : '') + ' · ดึงสด', searchOnly: true });
    }
    for (const a of ASSETS) items.push({ id: 'sim:' + a.id, ticker: a.ticker, name: a.label + ' (จำลอง)', group: 'ข้อมูลจำลอง (ทดลอง)', tag: 'จำลอง' });
    return items;
  }

  function assetItems() {
    if (!baseItems) baseItems = buildBaseItems();
    if (!state.csvData) return baseItems;
    return [{ id: 'csv', ticker: state.csvData.name, name: 'ไฟล์ CSV ของคุณ', group: 'ไฟล์ของคุณ', tag: 'CSV' }].concat(baseItems);
  }

  function liveName(sym) {
    const row = QL.data.getSymbols().find((r) => r[0] === sym);
    return row ? row[1] : sym;
  }

  // ---------- live data key panel ----------
  function showKeyPanel(show) {
    $('livePanel').hidden = !show;
    if (show) {
      $('keyInput').value = QL.live.getKey();
      $('keyInput').focus();
    }
  }

  function syncKeyButton() {
    const has = !!QL.live.getKey();
    $('keyBtn').textContent = has ? 'API key ✓' : 'ตั้งค่า API key';
    $('keyClear').hidden = !has;
  }

  function buildKeyPanel() {
    syncKeyButton();
    $('keyBtn').addEventListener('click', () => showKeyPanel($('livePanel').hidden));
    $('keyClose').addEventListener('click', () => showKeyPanel(false));
    $('keyClear').addEventListener('click', () => {
      QL.live.setKey('');
      $('keyInput').value = '';
      syncKeyButton();
      setStatus('ลบ API key ออกจากเบราว์เซอร์นี้แล้ว');
    });
    $('keyForm').addEventListener('submit', (e) => {
      e.preventDefault();
      const key = $('keyInput').value.trim();
      if (!key) { setStatus('กรุณาวาง API key ก่อนบันทึก', true); return; }
      QL.live.setKey(key);
      syncKeyButton();
      showKeyPanel(false);
      if (state.pendingLive) {
        state.assetId = state.pendingLive;
        state.pendingLive = null;
        loadAndRun();
      } else setStatus('บันทึก API key แล้ว เลือกหุ้นที่ต้องการจากช่องค้นหาได้เลย');
    });
  }

  function buildControls() {
    if (manifest) $('dataUpdated').textContent = ' (ข้อมูลล่าสุดถึง ' + manifest.updated + ')';
    assetSearch = QL.search.create({
      input: $('assetSearch'),
      list: $('assetList'),
      getItems: assetItems,
      getCurrent: () => state.assetId,
      onSelect: (id) => {
        state.assetId = id;
        loadAndRun();
      },
      emptyText: (q) => 'ไม่พบ “' + q + '” ในรายชื่อหุ้นสหรัฐ · ลองพิมพ์ตัวย่อ หรือใช้ปุ่ม “อัปโหลด CSV”',
      footerText: (q) => {
        const n = QL.data.getSymbols().length;
        return !q && n ? 'พิมพ์เพื่อค้นหาหุ้นสหรัฐทั้งหมด ' + n.toLocaleString('en-US') + ' ตัว' : '';
      },
    });
    buildKeyPanel();

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
    $('stopType').addEventListener('change', (e) => {
      state.stop.type = e.target.value;
      $('stopPct').disabled = state.stop.type === 'none';
      run();
    });
    $('stopPct').addEventListener('change', (e) => {
      state.stop.pct = clamp(parseFloat(e.target.value), 1, 50, 10);
      e.target.value = state.stop.pct;
      run();
    });
    $('logInput').addEventListener('change', (e) => { state.log = e.target.checked; renderEquity(); });

    $('reseedBtn').addEventListener('click', () => {
      state.seed = (Math.random() * 1e9) >>> 0;
      loadAndRun().then(() => setStatus('สุ่มราคาจำลองชุดใหม่แล้ว (seed ' + state.seed + ')'));
    });

    $('csvInput').addEventListener('change', (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          state.csvData = parseCsv(String(reader.result), file.name);
          state.assetId = 'csv';
          const msg = 'โหลด ' + state.csvData.name + ' แล้ว: ' + state.csvData.dates.length.toLocaleString('en-US') + ' แถว';
          loadAndRun().then(() => setStatus(msg));
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
  function runStrategy(key, params, opts) {
    const strat = STRATEGIES[key];
    const pos = strat.signal(state.data.close, params, state.allowShort, state.data.dates);
    const o = Object.assign({ costBps: state.costBps, rf: state.rf, stop: state.stop, s: state.s, e: state.e }, opts);
    return { pos, res: BT.run(state.data, pos, o.s, o.e, o) };
  }

  function run() {
    if (!state.data) return;
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
    renderMath();
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
    if (!isFinite(diff) || !/[1-9]/.test(text)) {
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
      kpiTile('จำนวนเทรด', m.trades.toLocaleString('en-US'), 'ถือสถานะ ' + pct(m.exposure, 0, false) + ' ของเวลา' +
        (state.stop.type !== 'none' ? ' · โดน stop ' + m.stops + ' ครั้ง' : '')),
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
        const row = { date: isoDate(r.times[i]), close: num(close[i]), pos: posLabel(r.target[i]) };
        overlays.forEach((o, k) => (row['o' + k] = num(o.values[i])));
        return row;
      });
      C.table(el, cols, rows, { caption: 'ราคาและอินดิเคเตอร์รายเดือน' });
      return;
    }

    const markers = [];
    let prev = 0;
    for (let k = 0; k < close.length; k++) {
      const p = r.target[k];
      if (p !== prev) markers.push({ i: k, dir: Math.sign(p - prev) });
      prev = p;
    }
    C.lineChart(el, {
      times: r.times,
      series: [{ name: 'ราคาปิด', values: close, color: 1 }, ...overlays],
      markers: markers.length <= 400 ? markers : [],
      yFormat: (v) => compact(v),
      tipFormat: (v) => num(v),
      extraTip: (i) => [{ value: posLabel(r.target[i]), name: 'สถานะหลังปิดวัน' }],
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
      ? 'ทั้งหมด ' + trades.length.toLocaleString('en-US') + ' เทรด' + (trades.length > shown.length ? ' · แสดงล่าสุด ' + shown.length + ' รายการ' : '') + ' · ผลตอบแทนหักค่าธรรมเนียมแล้ว' +
        (state.data.source === 'stock' || state.data.source === 'live' ? ' · ราคาเป็นราคาที่ปรับแล้ว (ปันผล/แตกหุ้น)' : '')
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
        note: t.stopped ? 'โดน stop-loss' : '',
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
      { key: 'note', label: 'หมายเหตุ' },
    ], rows, { caption: 'บันทึกการเทรด' });
  }

  // ---------- math check card (Paulos, A Mathematician Plays the Stock Market) ----------
  let spy = null;
  let spyLoading = false;

  function ensureSpy() {
    if (spy || spyLoading || !stocks.some((t) => t.ticker === 'SPY')) return;
    spyLoading = true;
    QL.data.loadStock('SPY').then((d) => {
      const map = new Map();
      for (let i = 1; i < d.dates.length; i++) map.set(d.dates[i], d.close[i] / d.close[i - 1] - 1);
      spy = { map };
      if (state.res) renderMath();
    }).catch(() => { spyLoading = false; });
  }

  function mk(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function mathTile(title, value, sub, pages) {
    const t = mk('div', 'math-tile');
    t.append(mk('h3', 'kpi-label', title), mk('p', 'math-value', value), mk('p', 'kpi-sub', sub), mk('p', 'math-ref', 'Paulos หน้า ' + pages));
    return t;
  }

  function mathSection(title, desc) {
    const s = mk('section', 'math-section');
    s.appendChild(mk('h3', null, title));
    if (desc) s.appendChild(mk('p', 'card-sub', desc));
    return s;
  }

  function verdict(ok, text) {
    const p = mk('p', 'math-verdict ' + (ok ? 'is-good' : 'is-bad'));
    const icon = mk('span', null, ok ? '✓ ' : '⚠ ');
    icon.setAttribute('aria-hidden', 'true');
    p.append(icon, document.createTextNode(text));
    return p;
  }

  function renderMath() {
    const box = $('mathCard');
    const r = state.res, d = state.data;
    if (!box || !r) return;
    box.textContent = '';
    const ppy = (r.times.length - 1) / r.metrics.years;

    // 1. Statistics tiles
    const tiles = mk('div', 'math-tiles');
    const st = BT.returnStats(r.rets.slice(1), ppy);
    if (st) {
      tiles.appendChild(mathTile('ค่าเฉลี่ยหลอกตา', pct(st.arithAnnual) + ' vs ' + pct(st.geoAnnual),
        'ค่าเฉลี่ยเลขคณิตต่อปีของกลยุทธ์ เทียบกับผลที่ได้จริง (ค่าเฉลี่ยเรขาคณิต) ส่วนต่างเกิดจากความผันผวน ≈ σ²/2 ยิ่งผันผวนยิ่งห่าง',
        '95–99'));
    }
    const at = BT.returnStats(r.benchRets.slice(1), ppy);
    if (at) {
      tiles.appendChild(mathTile('หางอ้วน (Fat tails)', at.tails + ' วัน',
        'วันที่ราคา ' + d.name + ' เหวี่ยงเกิน 3σ ถ้าเป็น bell curve ควรมีราว ' + at.tailsExpected.toFixed(1) + ' วัน (' +
        (at.tailsExpected > 0 ? (at.tails / at.tailsExpected).toFixed(1) : '—') + ' เท่า) · kurtosis ' + num(at.kurtosis, 1) +
        ' (bell curve = 3) · วันที่แย่สุด ' + pct(at.worst) + ' = ' + num(-at.worstSigma, 1) + 'σ',
        '136–140, 175–181'));
    }
    let betaTile;
    if (d.source === 'sim') {
      betaTile = mathTile('Beta เทียบ S&P 500', '—', 'ข้อมูลจำลองไม่มีความสัมพันธ์กับตลาดจริง', '159–162');
    } else if (!spy) {
      betaTile = mathTile('Beta เทียบ S&P 500', '…', 'กำลังโหลดข้อมูล SPY', '159–162');
      ensureSpy();
    } else {
      const x = [], ya = [], ys = [];
      for (let k = 1; k < r.times.length; k++) {
        const m = spy.map.get(r.times[k]);
        if (m === undefined) continue;
        x.push(m);
        ya.push(r.benchRets[k]);
        ys.push(r.rets[k]);
      }
      const ba = BT.beta(ya, x), bs = BT.beta(ys, x);
      betaTile = ba
        ? mathTile('Beta เทียบ S&P 500', num(ba.beta),
          'หุ้น ' + d.name + ' ขยับประมาณ ' + num(ba.beta) + ' เท่าของตลาด (correlation ' + num(ba.corr) + ') · กลยุทธ์นี้มี beta ' +
          num(bs.beta) + ' เพราะไม่ได้ถือหุ้นตลอดเวลา', '159–162')
        : mathTile('Beta เทียบ S&P 500', '—', 'วันที่ตรงกับข้อมูล SPY มีน้อยเกินไป', '159–162');
    }
    tiles.appendChild(betaTile);
    box.appendChild(tiles);

    // 2. Out-of-sample check: first half vs second half
    const sec = mathSection('ทดสอบนอกตัวอย่าง: ครึ่งแรก vs ครึ่งหลัง',
      'ค้นข้อมูลมากพอย่อมเจอกฎที่ "เคยได้ผล" เสมอ (data mining) กลยุทธ์ที่ดีจริงควรได้ผลทั้งสองช่วง ไม่ใช่แค่ช่วงที่บังเอิญ · Paulos หน้า 28–30');
    const s = state.s, e = state.e, mid = Math.floor((s + e) / 2);
    const p = state.params[state.strategy];
    if (mid - s < 60 || e - mid < 60) {
      sec.appendChild(mk('p', 'empty-state scan-empty', 'ช่วงเวลาสั้นเกินไป เลือกช่วงอย่างน้อยประมาณ 1 ปี'));
    } else {
      const a = runStrategy(state.strategy, p, { s, e: mid }).res;
      const b = runStrategy(state.strategy, p, { s: mid, e }).res;
      const row = (label, x, from, to) => ({
        label,
        range: isoDate(d.dates[from]) + ' ถึง ' + isoDate(d.dates[to]),
        cagr: pct(x.metrics.cagr),
        sharpe: num(x.metrics.sharpe),
        dd: pct(x.metrics.maxDD),
        bh: pct(x.benchMetrics.cagr),
        win: x.metrics.cagr > x.benchMetrics.cagr ? { text: '✓ ชนะ', cls: 'is-good' } : { text: '✗ แพ้', cls: 'is-bad' },
      });
      C.table(sec.appendChild(mk('div')), [
        { key: 'label', label: 'ช่วง' },
        { key: 'range', label: 'วันที่' },
        { key: 'cagr', label: 'CAGR กลยุทธ์', num: true },
        { key: 'sharpe', label: 'Sharpe', num: true },
        { key: 'dd', label: 'Max DD', num: true },
        { key: 'bh', label: 'CAGR Buy & Hold', num: true },
        { key: 'win', label: 'เทียบ B&H' },
      ], [row('ครึ่งแรก', a, s, mid), row('ครึ่งหลัง', b, mid, e), row('ทั้งช่วง', r, s, e)], { caption: 'ผลแยกครึ่งแรกและครึ่งหลัง' });
      const am = a.metrics, bm = b.metrics;
      const collapsed = (am.cagr > 0 && bm.cagr <= 0) || (am.sharpe > 0.3 && bm.sharpe < am.sharpe * 0.5);
      sec.appendChild(collapsed
        ? verdict(false, 'ผลครึ่งหลังแย่ลงมากเมื่อเทียบกับครึ่งแรก อาจเป็นการเลือกพารามิเตอร์ให้เข้ากับอดีต ลองเปลี่ยนพารามิเตอร์หรือหุ้นดูว่ายังได้ผลไหม')
        : verdict(true, 'ผลทั้งสองช่วงไปในทางเดียวกัน กลยุทธ์ไม่ได้ดีแค่ช่วงเดียว (แต่ยังไม่รับประกันอนาคต)'));
    }
    box.appendChild(sec);

    // 3. Stop-loss comparison
    const ss = mathSection('ผลของ Stop-loss',
      'ผู้เขียนขาดทุนหนักจาก WorldCom เพราะทุ่มหุ้นตัวเดียว ไม่ตั้ง stop-loss และซื้อถัวขาลง · Paulos หน้า 115, 198–202');
    if (state.stop.type === 'none') {
      ss.appendChild(mk('p', 'card-sub', 'เลือก "Stop-loss" ในแถวตั้งค่าด้านบน เพื่อเปรียบเทียบผลระหว่างมีและไม่มี stop-loss'));
    } else {
      const off = runStrategy(state.strategy, p, { stop: null }).res;
      const label = (state.stop.type === 'trailing' ? 'เลื่อนตาม ' : 'คงที่ ') + state.stop.pct + '%';
      const row = (name, x) => ({
        name,
        total: pct(x.metrics.total),
        cagr: pct(x.metrics.cagr),
        dd: pct(x.metrics.maxDD),
        sharpe: num(x.metrics.sharpe),
        trades: x.metrics.trades.toLocaleString('en-US'),
        stops: x.metrics.stops.toLocaleString('en-US'),
      });
      C.table(ss.appendChild(mk('div')), [
        { key: 'name', label: 'แบบ' },
        { key: 'total', label: 'ผลตอบแทนรวม', num: true },
        { key: 'cagr', label: 'CAGR', num: true },
        { key: 'dd', label: 'Max DD', num: true },
        { key: 'sharpe', label: 'Sharpe', num: true },
        { key: 'trades', label: 'เทรด', num: true },
        { key: 'stops', label: 'โดน stop', num: true },
      ], [row('ไม่ใช้ stop-loss', off), row('ใช้ stop-loss ' + label, r)], { caption: 'เทียบผลมีและไม่มี stop-loss' });
      const better = r.metrics.maxDD > off.metrics.maxDD;
      ss.appendChild(verdict(better, better
        ? 'Stop-loss ช่วยลดการขาดทุนสูงสุดจาก ' + pct(off.metrics.maxDD) + ' เหลือ ' + pct(r.metrics.maxDD) +
          (r.metrics.total < off.metrics.total ? ' แลกกับผลตอบแทนรวมที่ลดลง' : '')
        : 'Stop-loss ไม่ได้ช่วยลดการขาดทุนสูงสุดในช่วงนี้ อาจโดนขายบ่อยจนพลาดช่วงราคาฟื้นตัว ลองปรับ % ดู'));
    }
    box.appendChild(ss);
  }

  function exportCsv() {
    const r = state.res;
    if (!r) return;
    const dd = BT.drawdown(r.equity);
    const lines = ['date,close,position,strategy_equity,buyhold_equity,drawdown'];
    for (let k = 0; k < r.times.length; k++) {
      const i = state.s + k;
      lines.push([isoDate(r.times[k]), state.data.close[i].toFixed(4), r.target[k], r.equity[k].toFixed(4), r.bench[k].toFixed(4), dd[k].toFixed(6)].join(','));
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
  // ---------- views (backtest / scan) ----------
  const scanView = QL.scanView.init({ container: $('scanView'), onOpen: openTicker });

  function route() {
    const view = location.hash === '#scan' ? 'scan' : 'backtest';
    $('scanView').hidden = view !== 'scan';
    $('backtestView').hidden = view !== 'backtest';
    for (const a of document.querySelectorAll('.view-nav a')) {
      if (a.dataset.view === view) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    }
    if (view === 'scan') scanView.show();
  }

  function goToBacktest() {
    if (location.hash !== '#scan') return;
    try {
      history.pushState(null, '', location.pathname + location.search);
    } catch (e) {
      location.hash = '';
    }
    route();
  }

  function openTicker(ticker, hint) {
    const key = symbolKey(ticker);
    const items = assetItems();
    const found = items.find((it) => it.id.startsWith('stock:') && symbolKey(it.ticker) === key) ||
      items.find((it) => it.id.startsWith('live:') && symbolKey(it.ticker) === key);
    state.assetId = found ? found.id : 'live:' + ticker;
    if (hint && STRATEGIES[hint.strategy]) {
      Object.assign(state.params[hint.strategy], hint.params || {});
      state.strategy = hint.strategy;
      $('strategySelect').value = hint.strategy;
      buildParams();
    }
    goToBacktest();
    window.scrollTo(0, 0);
    loadAndRun();
  }

  window.addEventListener('hashchange', route);
  window.addEventListener('popstate', route);

  buildControls();
  route();
  loadAndRun();

  let lastWidth = 0, raf = 0;
  new ResizeObserver((entries) => {
    const w = entries[0].contentRect.width;
    if (Math.abs(w - lastWidth) < 2) return;
    lastWidth = w;
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(renderCharts);
  }).observe(document.querySelector('.grid'));
})(window.QL);
