(function (QL) {
  'use strict';

  function h(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  const pct = (v, d = 1) => (v == null ? '—' : (v > 0 ? '+' : '') + (v * 100).toFixed(d) + '%');
  const delta = (v) => (v == null ? { text: '—' } : {
    text: (v > 0 ? '▲ ' : v < 0 ? '▼ ' : '') + pct(v),
    cls: v > 0 ? 'is-good' : v < 0 ? 'is-bad' : null,
  });
  const price = (v) => (v == null ? '—' : v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: v < 1 ? 4 : 2 }));
  const ago = (n) => (n == null ? '—' : n === 0 ? 'วันนี้' : n + ' วันก่อน');

  const COLS = {
    t: { label: 'หุ้น', value: (r) => r.t, cell: (r) => ({ text: r.t, cls: 'scan-ticker' }) },
    n: { label: 'ชื่อบริษัท', value: (r) => r.n, cell: (r) => ({ text: r.n, cls: 'scan-name' }) },
    s: { label: 'กลุ่ม', value: (r) => r.s, cell: (r) => ({ text: r.s || '—', cls: 'scan-sector' }) },
    c: { label: 'ราคา', num: true, value: (r) => r.c, cell: (r) => ({ text: price(r.c) }) },
    d1: { label: 'วันล่าสุด', num: true, value: (r) => r.d1, cell: (r) => delta(r.d1) },
    m1: { label: '1 เดือน', num: true, value: (r) => r.m1, cell: (r) => delta(r.m1) },
    m3: { label: '3 เดือน', num: true, value: (r) => r.m3, cell: (r) => delta(r.m3) },
    m6: { label: '6 เดือน', num: true, value: (r) => r.m6, cell: (r) => delta(r.m6) },
    mom: { label: '12-1 เดือน', num: true, value: (r) => r.mom, cell: (r) => delta(r.mom) },
    ytd: { label: 'ตั้งแต่ต้นปี', num: true, value: (r) => r.ytd, cell: (r) => delta(r.ytd) },
    fh: { label: 'ห่างจุดสูงสุด 52 สัปดาห์', num: true, value: (r) => r.fh, cell: (r) => ({ text: r.fh == null ? '—' : r.fh > -0.0005 ? 'ที่จุดสูงสุด' : pct(r.fh) }) },
    vol: { label: 'ผันผวน/ปี', num: true, value: (r) => r.vol, cell: (r) => ({ text: r.vol == null ? '—' : (r.vol * 100).toFixed(0) + '%' }) },
    d5: { label: '5 วัน', num: true, value: (r) => r.d5, cell: (r) => delta(r.d5) },
    vr: { label: 'วอลุ่ม/ปกติ', num: true, value: (r) => r.vr, cell: (r) => ({ text: r.vr == null ? '—' : r.vr.toFixed(1) + ' เท่า' }) },
    dv: { label: 'มูลค่าซื้อขาย', num: true, value: (r) => r.dv, cell: (r) => ({ text: r.dv == null ? '—' : r.dv >= 1000 ? '$' + (r.dv / 1000).toFixed(1) + 'B' : '$' + r.dv.toFixed(1) + 'M' }) },
    rsi: { label: 'RSI', num: true, value: (r) => r.rsi, cell: (r) => ({ text: r.rsi == null ? '—' : r.rsi.toFixed(0) }) },
    gc: { label: 'เกิดเมื่อ', value: (r) => r.gc, cell: (r) => ({ text: ago(r.gc) }) },
    dc: { label: 'เกิดเมื่อ', value: (r) => r.dc, cell: (r) => ({ text: ago(r.dc) }) },
    eu: { label: 'เกิดเมื่อ', value: (r) => r.eu, cell: (r) => ({ text: ago(r.eu) }) },
    ed: { label: 'เกิดเมื่อ', value: (r) => r.ed, cell: (r) => ({ text: ago(r.ed) }) },
  };

  const SECTIONS = [
    { id: 'gc', group: 'up', title: 'Golden Cross', desc: 'เส้นเฉลี่ย 50 วันเพิ่งตัดขึ้นเหนือเส้น 200 วัน (SMA)',
      filter: (r) => r.gc != null, sort: ['gc', 1], cols: ['t', 'n', 'c', 'd1', 'm1', 'gc'],
      hint: { strategy: 'sma', params: { fast: 50, slow: 200 } } },
    { id: 'eu', group: 'up', title: 'ราคาตัดขึ้นเหนือ EMA200', desc: 'ราคาปิดเพิ่งกลับขึ้นมายืนเหนือเส้น EMA 200 วัน',
      filter: (r) => r.eu != null, sort: ['eu', 1], cols: ['t', 'n', 'c', 'd1', 'm1', 'eu'],
      hint: { strategy: 'emaTrend', params: { period: 200 } } },
    { id: 'hi', group: 'up', title: 'ทำจุดสูงสุดใหม่ในรอบ 52 สัปดาห์', desc: 'ราคาปิดล่าสุดสูงที่สุดในรอบ 1 ปี แสดงแรงส่งที่ดี',
      filter: (r) => r.hi, sort: ['m3', -1], cols: ['t', 'n', 'c', 'd1', 'm3'],
      hint: { strategy: 'momentum' } },
    { id: 'os', group: 'up', title: 'RSI ต่ำกว่า 30 (Oversold)', desc: 'ราคาลงแรงจนอาจขายมากเกินไป มีโอกาสเด้ง แต่ก็อาจลงต่อได้',
      filter: (r) => r.rsi != null && r.rsi < 30, sort: ['rsi', 1], cols: ['t', 'n', 'c', 'd1', 'm1', 'rsi'],
      hint: { strategy: 'rsi' } },
    { id: 'dc', group: 'down', title: 'Death Cross', desc: 'เส้นเฉลี่ย 50 วันเพิ่งตัดลงใต้เส้น 200 วัน (SMA)',
      filter: (r) => r.dc != null, sort: ['dc', 1], cols: ['t', 'n', 'c', 'd1', 'm1', 'dc'],
      hint: { strategy: 'sma', params: { fast: 50, slow: 200 } } },
    { id: 'ed', group: 'down', title: 'ราคาหลุดใต้ EMA200', desc: 'ราคาปิดเพิ่งหลุดลงใต้เส้น EMA 200 วัน',
      filter: (r) => r.ed != null, sort: ['ed', 1], cols: ['t', 'n', 'c', 'd1', 'm1', 'ed'],
      hint: { strategy: 'emaTrend', params: { period: 200 } } },
    { id: 'ob', group: 'down', title: 'RSI สูงกว่า 70 (Overbought)', desc: 'ราคาขึ้นแรงจนอาจซื้อมากเกินไป ระวังการพักตัว',
      filter: (r) => r.rsi != null && r.rsi > 70, sort: ['rsi', -1], cols: ['t', 'n', 'c', 'd1', 'm1', 'rsi'],
      hint: { strategy: 'rsi' } },
  ];

  const TABS = [
    { id: 'signals', label: 'สัญญาณล่าสุด' },
    { id: 'movers', label: 'หุ้นซิ่งวันนี้' },
    { id: 'momentum', label: 'แรงส่ง (Momentum)' },
    { id: 'ytd', label: 'ปีนี้' },
    { id: 'all', label: 'ทั้งหมด' },
  ];

  function sortRows(rows, key, dir) {
    const value = COLS[key].value;
    return rows.slice().sort((a, b) => {
      const va = value(a), vb = value(b);
      if (va == null && vb == null) return 0;
      if (va == null) return 1;
      if (vb == null) return -1;
      if (typeof va === 'string') return dir * va.localeCompare(vb);
      return dir * (va - vb);
    });
  }

  // Sortable, clickable table; every cell goes through textContent.
  function table(rows, cols, opts) {
    const wrap = h('div', 'table-scroll');
    const t = h('table', 'data-table scan-table clickable');
    if (opts.caption) t.appendChild(h('caption', 'sr-only', opts.caption));
    const hr = h('tr');
    if (opts.rank) hr.appendChild(h('th', 'num', '#'));
    for (const key of cols) {
      const c = COLS[key];
      const th = h('th', c.num ? 'num' : null);
      if (opts.onSort) {
        const active = opts.sort && opts.sort.key === key;
        if (active) th.setAttribute('aria-sort', opts.sort.dir > 0 ? 'ascending' : 'descending');
        const btn = h('button', 'th-sort', c.label + (active ? (opts.sort.dir > 0 ? ' ▲' : ' ▼') : ''));
        btn.type = 'button';
        btn.addEventListener('click', () => opts.onSort(key));
        th.appendChild(btn);
      } else th.textContent = c.label;
      hr.appendChild(th);
    }
    const thead = h('thead');
    thead.appendChild(hr);
    t.appendChild(thead);
    const tbody = h('tbody');
    rows.forEach((r, i) => {
      const tr = h('tr');
      tr.tabIndex = 0;
      tr.setAttribute('aria-label', r.t + ' ' + r.n + ' — เปิดหน้าทดสอบกลยุทธ์');
      const open = () => opts.onOpen(r);
      tr.addEventListener('click', open);
      tr.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
      if (opts.rank) tr.appendChild(h('td', 'num muted', String(i + 1)));
      for (const key of cols) {
        const c = COLS[key];
        const v = c.cell(r);
        const td = h('td', c.num ? 'num' : null, v.text);
        if (v.cls) td.classList.add(v.cls);
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    });
    t.appendChild(tbody);
    wrap.appendChild(t);
    return wrap;
  }

  function init({ container, onOpen }) {
    const data = QL.data.getScan();
    const state = {
      tab: 'signals',
      q: '',
      sector: '',
      index: '',
      sort: { momentum: { key: 'mom', dir: -1 }, all: { key: 'mom', dir: -1 } },
      expanded: {},
    };
    let body = null;
    let built = false;

    function filtered() {
      const q = state.q.trim().toLowerCase();
      return data.rows.filter((r) =>
        (!q || r.t.toLowerCase().includes(q) || r.n.toLowerCase().includes(q)) &&
        (!state.sector || r.s === state.sector) &&
        (!state.index || r.i.includes(state.index)));
    }

    function moreButton(id, total, limit) {
      if (total <= limit && !state.expanded[id]) return null;
      const btn = h('button', 'btn btn-ghost btn-sm scan-more', state.expanded[id] ? 'แสดงน้อยลง' : 'ดูทั้งหมด ' + total + ' ตัว');
      btn.type = 'button';
      btn.addEventListener('click', () => { state.expanded[id] = !state.expanded[id]; render(); });
      return btn;
    }

    function card(title, desc, count, content, more) {
      const art = h('article', 'card scan-card');
      const head = h('header', 'scan-card-head');
      const ttl = h('h3', null, title);
      if (count != null) ttl.appendChild(h('span', 'chip', String(count)));
      head.appendChild(ttl);
      if (desc) head.appendChild(h('p', 'card-sub', desc));
      art.append(head, content);
      if (more) art.appendChild(more);
      return art;
    }

    function renderSignals(rows) {
      const frag = document.createDocumentFragment();
      for (const [group, label] of [['up', 'สัญญาณขาขึ้น'], ['down', 'สัญญาณขาลง / ควรระวัง']]) {
        frag.appendChild(h('h3', 'scan-group', label));
        const grid = h('div', 'scan-grid');
        for (const s of SECTIONS.filter((x) => x.group === group)) {
          const all = sortRows(rows.filter(s.filter), s.sort[0], s.sort[1]);
          const limit = 8;
          const shown = state.expanded[s.id] ? all : all.slice(0, limit);
          const content = all.length
            ? table(shown, s.cols, { onOpen: (r) => onOpen(r.t, s.hint), caption: s.title })
            : h('p', 'empty-state scan-empty', 'ไม่มีหุ้นเข้าเงื่อนไขในช่วงนี้');
          grid.appendChild(card(s.title, s.desc + (s.id === 'gc' || s.id === 'eu' || s.id === 'dc' || s.id === 'ed' ? ' (ภายใน ' + data.signalDays + ' วันทำการล่าสุด)' : ''), all.length, content, moreButton(s.id, all.length, limit)));
        }
        frag.appendChild(grid);
      }
      return frag;
    }

    function sortable(tabId, rows, cols, limit, caption) {
      const sort = state.sort[tabId];
      const all = sortRows(rows, sort.key, sort.dir);
      const shown = state.expanded[tabId] ? all : all.slice(0, limit);
      return {
        all,
        node: table(shown, cols, {
          rank: true,
          sort,
          caption,
          onOpen: (r) => onOpen(r.t, tabId === 'momentum' ? { strategy: 'momentum' } : null),
          onSort: (key) => {
            state.sort[tabId] = { key, dir: sort.key === key ? -sort.dir : COLS[key].num ? -1 : 1 };
            render();
          },
        }),
      };
    }

    function renderMomentum(rows) {
      const { all, node } = sortable('momentum', rows, ['t', 'n', 's', 'c', 'mom', 'm6', 'm3', 'fh', 'vol'], 30, 'อันดับแรงส่ง');
      return card('หุ้นที่มีแรงส่งสูงสุด',
        '12-1 เดือน = ผลตอบแทนย้อนหลัง 12 เดือนโดยไม่นับเดือนล่าสุด เป็นตัววัดโมเมนตัมที่ใช้กันแพร่หลายในงานวิจัย ในอดีตหุ้นที่ขึ้นแรงมักวิ่งต่อได้อีกระยะ แต่กลับตัวรุนแรงได้เช่นกัน · กดหัวคอลัมน์เพื่อเรียงลำดับ',
        null, node, moreButton('momentum', all.length, 30));
    }

    function renderYtd(rows) {
      const grid = h('div', 'scan-grid');
      const withYtd = rows.filter((r) => r.ytd != null);
      for (const [id, title, dir] of [['ytdUp', 'ขึ้นมากที่สุดตั้งแต่ต้นปี', -1], ['ytdDown', 'ลงมากที่สุดตั้งแต่ต้นปี', 1]]) {
        const all = sortRows(withYtd, 'ytd', dir);
        const shown = state.expanded[id] ? all : all.slice(0, 15);
        grid.appendChild(card(title, null, null,
          table(shown, ['t', 'n', 'c', 'ytd', 'm1'], { rank: true, onOpen: (r) => onOpen(r.t, null), caption: title }),
          moreButton(id, all.length, 15)));
      }
      return grid;
    }

    function renderAll(rows) {
      const { all, node } = sortable('all', rows, ['t', 'n', 's', 'c', 'd1', 'm1', 'm3', 'ytd', 'mom', 'fh', 'vol', 'rsi'], 100, 'หุ้นทั้งหมดที่สแกน');
      return card('หุ้นทั้งหมดที่สแกน', 'กดหัวคอลัมน์เพื่อเรียงลำดับ · กดที่แถวเพื่อทดสอบกลยุทธ์กับหุ้นตัวนั้น', all.length, node, moreButton('all', all.length, 100));
    }

    const MOVER_LISTS = [
      ['gainers', 'ขึ้นแรงที่สุดวันนี้', 'เปลี่ยนแปลงจากราคาปิดวันก่อนหน้า', ['t', 'n', 'c', 'd1', 'vr', 'dv']],
      ['volume', 'วอลุ่มพุ่งผิดปกติ', 'ปริมาณซื้อขายวันนี้เทียบค่าเฉลี่ย 20 วัน (ตั้งแต่ 2 เท่าขึ้นไป) มักมีข่าวหรือเหตุการณ์สำคัญ', ['t', 'n', 'c', 'vr', 'd1', 'dv']],
      ['week', 'ซิ่ง 5 วัน', 'ขึ้นแรงที่สุดในรอบ 5 วันทำการ', ['t', 'n', 'c', 'd5', 'd1', 'vr']],
      ['losers', 'ลงแรงที่สุดวันนี้', 'ร่วงหนักที่สุดจากราคาปิดวันก่อนหน้า', ['t', 'n', 'c', 'd1', 'vr', 'dv']],
    ];

    function renderMovers() {
      const mv = QL.data.getMovers();
      const frag = document.createDocumentFragment();
      if (!mv) {
        frag.appendChild(h('p', 'empty-state', 'ยังไม่มีข้อมูลหุ้นซิ่ง ระบบจะสร้างให้อัตโนมัติหลังตลาดสหรัฐปิด'));
        return frag;
      }
      frag.appendChild(h('p', 'scan-note scan-warn',
        'หุ้นซิ่งมีความเสี่ยงสูงมาก ราคาที่พุ่งแรงในวันเดียวมักมาจากข่าว ผลประกอบการ หรือการเก็งกำไร และกลับตัวได้รุนแรงในวันถัดไป ' +
        'ไม่ควรไล่ซื้อตามโดยไม่มีแผนตัดขาดทุน'));
      frag.appendChild(h('p', 'card-sub',
        'สแกนหุ้นสามัญทุกตัวในตลาดสหรัฐที่ราคาตั้งแต่ $' + mv.minPrice + ' และมูลค่าซื้อขายเฉลี่ยตั้งแต่ $' + mv.minDollarVolumeM + 'M ต่อวัน รวม ' +
        mv.universe.toLocaleString('en-US') + ' ตัว · ราคาปิดวันที่ ' + mv.asOf + ' · ตัวกรองกลุ่มอุตสาหกรรมและดัชนีไม่มีผลกับแท็บนี้'));
      const q = state.q.trim().toLowerCase();
      const match = (r) => !q || r.t.toLowerCase().includes(q) || r.n.toLowerCase().includes(q);
      const grid = h('div', 'scan-grid');
      for (const [key, title, desc, cols] of MOVER_LISTS) {
        const all = (mv.lists[key] || []).filter(match);
        const id = 'mv-' + key;
        const shown = state.expanded[id] ? all : all.slice(0, 10);
        const content = all.length
          ? table(shown, cols, { rank: true, onOpen: (r) => onOpen(r.t, null), caption: title })
          : h('p', 'empty-state scan-empty', 'ไม่มีหุ้นเข้าเงื่อนไข');
        grid.appendChild(card(title, desc, all.length, content, moreButton(id, all.length, 10)));
      }
      frag.appendChild(grid);
      return frag;
    }

    function render() {
      if (!body) return;
      body.textContent = '';
      if (state.tab === 'movers') {
        body.appendChild(renderMovers());
        return;
      }
      const rows = filtered();
      if (!rows.length) {
        body.appendChild(h('p', 'empty-state', 'ไม่พบหุ้นที่ตรงกับตัวกรอง'));
        return;
      }
      const view = { signals: renderSignals, momentum: renderMomentum, ytd: renderYtd, all: renderAll }[state.tab];
      body.appendChild(view(rows));
    }

    function build() {
      built = true;
      container.textContent = '';
      const head = h('header', 'scan-head');
      head.appendChild(h('h2', 'scan-title', 'สแกนหุ้น'));
      if (!data) {
        head.appendChild(h('p', 'card-sub', 'ยังไม่มีข้อมูลสแกน ระบบจะสร้างให้อัตโนมัติหลังตลาดสหรัฐปิดในวันทำการถัดไป'));
        container.appendChild(head);
        return;
      }
      head.appendChild(h('p', 'card-sub',
        'S&P 500 และ Nasdaq-100 รวม ' + data.rows.length.toLocaleString('en-US') + ' ตัว · ราคาปิดวันที่ ' + data.asOf + ' · อัปเดตอัตโนมัติทุกวันทำการ'));
      container.appendChild(head);

      const note = h('p', 'scan-note',
        'ผลสแกนคือหุ้นที่ "เข้าเงื่อนไขทางเทคนิค" ตามกฎที่กำหนด ไม่ได้คาดการณ์อนาคตและไม่ใช่คำแนะนำซื้อขาย · กดที่หุ้นเพื่อดูว่ากลยุทธ์นั้นเคยได้ผลกับหุ้นตัวนี้แค่ไหน');
      container.appendChild(note);

      const bar = h('div', 'control-row scan-filters');
      const tabs = h('div', 'segmented');
      tabs.setAttribute('role', 'group');
      tabs.setAttribute('aria-label', 'มุมมองการสแกน');
      for (const tb of TABS) {
        const b = h('button', null, tb.label);
        b.type = 'button';
        b.dataset.tab = tb.id;
        b.addEventListener('click', () => {
          state.tab = tb.id;
          tabs.querySelectorAll('button').forEach((x) => {
            x.classList.toggle('is-active', x.dataset.tab === tb.id);
            x.setAttribute('aria-pressed', String(x.dataset.tab === tb.id));
          });
          render();
        });
        const on = tb.id === state.tab;
        b.classList.toggle('is-active', on);
        b.setAttribute('aria-pressed', String(on));
        tabs.appendChild(b);
      }

      const q = h('input', 'scan-search');
      Object.assign(q, { type: 'search', id: 'scanSearch', placeholder: 'กรองด้วยตัวย่อหรือชื่อ', autocomplete: 'off', spellcheck: false });
      q.setAttribute('aria-label', 'กรองหุ้นด้วยตัวย่อหรือชื่อ');
      q.addEventListener('input', () => { state.q = q.value; render(); });

      const sector = h('select');
      sector.setAttribute('aria-label', 'กลุ่มอุตสาหกรรม');
      sector.appendChild(new Option('ทุกกลุ่มอุตสาหกรรม', ''));
      [...new Set(data.rows.map((r) => r.s).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'th'))
        .forEach((s) => sector.appendChild(new Option(s, s)));
      sector.addEventListener('change', () => { state.sector = sector.value; render(); });

      const index = h('select');
      index.setAttribute('aria-label', 'ดัชนี');
      index.append(new Option('ทุกดัชนี', ''), new Option('S&P 500', 'S'), new Option('Nasdaq-100', 'N'));
      index.addEventListener('change', () => { state.index = index.value; render(); });

      bar.append(tabs, q, sector, index);
      container.appendChild(bar);

      body = h('div', 'scan-body');
      container.appendChild(body);
      render();
    }

    document.addEventListener('keydown', (e) => {
      if (e.key !== '/' || container.hidden || e.ctrlKey || e.metaKey || e.altKey) return;
      const tag = (e.target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
      const q = document.getElementById('scanSearch');
      if (q) { e.preventDefault(); q.focus(); }
    });

    return { show: () => { if (!built) build(); } };
  }

  QL.scanView = { init };
})((window.QL = window.QL || {}));
