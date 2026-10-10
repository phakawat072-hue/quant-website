(function (QL) {
  'use strict';

  const NS = 'http://www.w3.org/2000/svg';
  const TH_MONTHS = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];

  function svgEl(tag, attrs, parent) {
    const e = document.createElementNS(NS, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  }

  function h(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  const colorVar = (slot) => 'var(--series-' + slot + ')';

  function fmtDate(t) {
    const d = new Date(t);
    return d.getUTCDate() + ' ' + TH_MONTHS[d.getUTCMonth()] + ' ' + d.getUTCFullYear();
  }

  function niceStep(range, count) {
    const raw = range / Math.max(1, count);
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const f = raw / mag;
    return (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) * mag;
  }

  function linearScale(lo, hi, count) {
    if (lo === hi) { lo -= 1; hi += 1; }
    const step = niceStep(hi - lo, count);
    const min = Math.floor(lo / step) * step;
    const max = Math.ceil(hi / step) * step;
    const ticks = [];
    for (let v = min; v <= max + step * 1e-9; v += step) ticks.push(+v.toPrecision(12));
    return { min, max, ticks, map: (v, px) => px * (v - min) / (max - min) };
  }

  function logScale(lo, hi) {
    lo = Math.max(lo, 1e-9);
    const min = Math.log10(lo) - 0.02, max = Math.log10(hi) + 0.02;
    let ticks = [];
    for (let k = Math.floor(min); k <= Math.ceil(max); k++) {
      for (const m of [1, 2, 5]) {
        const v = m * Math.pow(10, k);
        const lv = Math.log10(v);
        if (lv >= min && lv <= max) ticks.push(v);
      }
    }
    if (ticks.length > 8) ticks = ticks.filter((v) => Math.abs(Math.log10(v) % 1) < 1e-9);
    if (ticks.length < 2) ticks = [lo, hi].map((v) => +v.toPrecision(2));
    return { min, max, ticks, map: (v, px) => px * (Math.log10(v) - min) / (max - min) };
  }

  function timeTicks(times, width) {
    const n = times.length;
    const years = (times[n - 1] - times[0]) / (365.25 * 86400000);
    const maxTicks = Math.max(2, Math.floor(width / 72));
    let ticks = [];
    for (let i = 1; i < n; i++) {
      const a = new Date(times[i - 1]), b = new Date(times[i]);
      if (years > 2) {
        if (a.getUTCFullYear() !== b.getUTCFullYear()) ticks.push({ t: times[i], label: String(b.getUTCFullYear()) });
      } else if (a.getUTCMonth() !== b.getUTCMonth()) {
        ticks.push({ t: times[i], label: TH_MONTHS[b.getUTCMonth()] + ' ' + String(b.getUTCFullYear()).slice(2) });
      }
    }
    const step = Math.ceil(ticks.length / maxTicks);
    return ticks.filter((_, k) => k % step === 0);
  }

  function makeTooltip(wrap) {
    const tip = h('div', 'tooltip');
    tip.setAttribute('role', 'status');
    tip.hidden = true;
    wrap.appendChild(tip);
    return tip;
  }

  function fillTooltip(tip, title, rows) {
    tip.textContent = '';
    tip.appendChild(h('div', 'tooltip-title', title));
    for (const r of rows) {
      const row = h('div', 'tooltip-row');
      if (r.color) {
        const key = h('span', 'key-' + (r.shape || 'line'));
        key.style.setProperty('--c', r.color);
        row.appendChild(key);
      }
      row.appendChild(h('strong', null, r.value));
      row.appendChild(h('span', 'tooltip-name', r.name));
      tip.appendChild(row);
    }
    tip.hidden = false;
  }

  function placeTooltip(tip, wrap, x, y) {
    const w = tip.offsetWidth, W = wrap.clientWidth;
    let left = x + 14;
    if (left + w > W - 4) left = x - w - 14;
    tip.style.left = Math.max(4, left) + 'px';
    tip.style.top = y + 'px';
  }

  function legend(container, items) {
    const lg = h('div', 'legend');
    for (const it of items) {
      const li = h('span', 'legend-item');
      const key = h('span', 'key-' + (it.shape || 'line'));
      if (it.color) key.style.setProperty('--c', it.color);
      li.appendChild(key);
      li.appendChild(document.createTextNode(it.name));
      lg.appendChild(li);
    }
    container.appendChild(lg);
  }

  function nearestIndex(times, t) {
    let lo = 0, hi = times.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (times[mid] < t) lo = mid; else hi = mid;
    }
    return t - times[lo] < times[hi] - t ? lo : hi;
  }

  // cfg: { times, series:[{name, values, color, area, legend}], yFormat, tipFormat,
  //        log, zero, height, markers:[{i, dir}], markerOf, ariaLabel, endLabels }
  function lineChart(container, cfg) {
    container.textContent = '';
    const legendItems = cfg.series.filter((s) => s.legend !== false).map((s) => ({ name: s.name, color: colorVar(s.color) }));
    if (cfg.markers && cfg.markers.length) {
      legendItems.push({ name: 'เพิ่มสถานะ (ซื้อ)', shape: 'up' }, { name: 'ลดสถานะ (ขาย)', shape: 'down' });
    }
    if (legendItems.length >= 2) legend(container, legendItems);

    const wrap = h('div', 'chart-wrap');
    container.appendChild(wrap);
    const W = Math.max(280, wrap.clientWidth || container.clientWidth);
    const H = cfg.height || 300;
    const endLabels = cfg.endLabels !== false;
    const m = { t: 12, r: endLabels ? 70 : 16, b: 28, l: 60 };
    const pw = W - m.l - m.r, ph = H - m.t - m.b;
    const T = cfg.times, n = T.length;
    const span = T[n - 1] - T[0] || 1;
    const X = (t) => m.l + ((t - T[0]) / span) * pw;

    let lo = Infinity, hi = -Infinity;
    for (const s of cfg.series) for (const v of s.values) if (isFinite(v)) { if (v < lo) lo = v; if (v > hi) hi = v; }
    if (cfg.zero) { lo = Math.min(lo, 0); hi = Math.max(hi, 0); }
    if (!isFinite(lo)) { lo = 0; hi = 1; }
    const useLog = cfg.log && lo > 0;
    const sc = useLog ? logScale(lo, hi) : linearScale(lo, hi, Math.max(3, Math.floor(ph / 50)));
    const Y = (v) => m.t + ph - sc.map(v, ph);

    const svg = svgEl('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}`, class: 'chart-svg', role: 'img', 'aria-label': cfg.ariaLabel || '' });
    wrap.appendChild(svg);

    const grid = svgEl('g', {}, svg);
    for (const v of sc.ticks) {
      const y = Y(v);
      if (y < m.t - 0.5 || y > m.t + ph + 0.5) continue;
      svgEl('line', { x1: m.l, x2: m.l + pw, y1: y, y2: y, class: 'grid' }, grid);
      svgEl('text', { x: m.l - 8, y: y + 4, class: 'tick', 'text-anchor': 'end' }, grid).textContent = cfg.yFormat(v);
    }
    svgEl('line', { x1: m.l, x2: m.l + pw, y1: m.t + ph, y2: m.t + ph, class: 'axis' }, grid);
    if (cfg.zero && !useLog) svgEl('line', { x1: m.l, x2: m.l + pw, y1: Y(0), y2: Y(0), class: 'axis' }, grid);
    for (const tk of timeTicks(T, pw)) {
      svgEl('text', { x: X(tk.t), y: H - 8, class: 'tick', 'text-anchor': 'middle' }, grid).textContent = tk.label;
    }

    const pathOf = (vals) => {
      let d = '', pen = false;
      for (let i = 0; i < n; i++) {
        const v = vals[i];
        if (!isFinite(v) || (useLog && v <= 0)) { pen = false; continue; }
        d += (pen ? 'L' : 'M') + X(T[i]).toFixed(1) + ',' + Y(v).toFixed(1);
        pen = true;
      }
      return d;
    };

    for (const s of cfg.series) {
      if (s.area) {
        const base = Y(useLog ? Math.pow(10, sc.min) : 0);
        const d = pathOf(s.values);
        if (d) {
          const firstX = X(T[s.values.findIndex(isFinite)]);
          svgEl('path', { d: d + `L${X(T[n - 1]).toFixed(1)},${base}L${firstX.toFixed(1)},${base}Z`, class: 'area', style: `fill:${colorVar(s.color)}` }, svg);
        }
      }
    }
    for (let k = cfg.series.length - 1; k >= 0; k--) {
      const s = cfg.series[k];
      svgEl('path', { d: pathOf(s.values), class: 'line', style: `stroke:${colorVar(s.color)}` }, svg);
    }

    if (cfg.markers && cfg.markers.length) {
      const mg = svgEl('g', { class: 'markers' }, svg);
      const ref = cfg.series[0].values;
      for (const mk of cfg.markers) {
        const x = X(T[mk.i]), y = Y(ref[mk.i]);
        const d = mk.dir > 0
          ? `M${x},${y + 7}l5,9h-10z`
          : `M${x},${y - 7}l5,-9h-10z`;
        svgEl('path', { d, class: 'marker ' + (mk.dir > 0 ? 'marker-up' : 'marker-down') }, mg);
      }
    }

    if (endLabels) {
      const placed = [];
      cfg.series.forEach((s) => {
        if (s.legend === false || s.endLabel === false) return;
        let i = n - 1;
        while (i >= 0 && !isFinite(s.values[i])) i--;
        if (i < 0) return;
        const x = X(T[i]), y = Y(s.values[i]);
        svgEl('circle', { cx: x, cy: y, r: 4, class: 'dot', style: `fill:${colorVar(s.color)}` }, svg);
        if (placed.some((py) => Math.abs(py - y) < 14)) return;
        placed.push(y);
        svgEl('text', { x: x + 9, y: y + 4, class: 'end-label' }, svg).textContent = cfg.yFormat(s.values[i], true);
      });
    }

    const cross = svgEl('g', { class: 'crosshair', visibility: 'hidden' }, svg);
    const vline = svgEl('line', { y1: m.t, y2: m.t + ph, class: 'cross-line' }, cross);
    const dots = cfg.series.map((s) => svgEl('circle', { r: 4, class: 'dot', style: `fill:${colorVar(s.color)}` }, cross));
    const tip = makeTooltip(wrap);

    const hit = svgEl('rect', { x: m.l, y: m.t, width: pw, height: ph, class: 'hit', tabindex: 0, 'aria-label': (cfg.ariaLabel || '') + ' — ใช้ปุ่มลูกศรซ้าย/ขวาเพื่อดูค่า' }, svg);
    let idx = n - 1;

    const show = (i) => {
      idx = Math.max(0, Math.min(n - 1, i));
      const x = X(T[idx]);
      vline.setAttribute('x1', x);
      vline.setAttribute('x2', x);
      cfg.series.forEach((s, k) => {
        const v = s.values[idx];
        const ok = isFinite(v) && !(useLog && v <= 0);
        dots[k].setAttribute('visibility', ok ? 'visible' : 'hidden');
        if (ok) { dots[k].setAttribute('cx', x); dots[k].setAttribute('cy', Y(v)); }
      });
      cross.setAttribute('visibility', 'visible');
      const rows = cfg.series
        .filter((s) => s.legend !== false || s.tooltip)
        .map((s) => ({ name: s.tipName || s.name, value: isFinite(s.values[idx]) ? (cfg.tipFormat || cfg.yFormat)(s.values[idx]) : '—', color: colorVar(s.color) }));
      if (cfg.extraTip) rows.push(...cfg.extraTip(idx));
      fillTooltip(tip, fmtDate(T[idx]), rows);
      placeTooltip(tip, wrap, x, m.t);
    };
    const hide = () => { cross.setAttribute('visibility', 'hidden'); tip.hidden = true; };

    hit.addEventListener('pointermove', (ev) => {
      const r = svg.getBoundingClientRect();
      const t = T[0] + ((ev.clientX - r.left - m.l) / pw) * span;
      show(nearestIndex(T, t));
    });
    hit.addEventListener('pointerleave', hide);
    hit.addEventListener('focus', () => show(idx));
    hit.addEventListener('blur', hide);
    hit.addEventListener('keydown', (ev) => {
      const step = ev.shiftKey ? 20 : 1;
      if (ev.key === 'ArrowLeft') { show(idx - step); ev.preventDefault(); }
      else if (ev.key === 'ArrowRight') { show(idx + step); ev.preventDefault(); }
      else if (ev.key === 'Home') { show(0); ev.preventDefault(); }
      else if (ev.key === 'End') { show(n - 1); ev.preventDefault(); }
      else if (ev.key === 'Escape') hide();
    });
  }

  function roundTopBar(x, y, w, hgt, r) {
    r = Math.min(r, w / 2, hgt);
    return `M${x},${y + hgt}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + hgt}Z`;
  }

  // cfg: { bins, xFormat, color, height, ariaLabel }
  function histogram(container, cfg) {
    container.textContent = '';
    const wrap = h('div', 'chart-wrap');
    container.appendChild(wrap);
    const bins = cfg.bins;
    const W = Math.max(260, wrap.clientWidth || container.clientWidth);
    const H = cfg.height || 260;
    const m = { t: 12, r: 16, b: 28, l: 48 };
    const pw = W - m.l - m.r, ph = H - m.t - m.b;
    const x0 = bins[0].x0, x1 = bins[bins.length - 1].x1;
    const X = (v) => m.l + ((v - x0) / (x1 - x0)) * pw;
    const maxC = Math.max(...bins.map((b) => b.count), 1);
    const ys = linearScale(0, maxC, Math.max(3, Math.floor(ph / 50)));
    const Y = (v) => m.t + ph - ys.map(v, ph);

    const svg = svgEl('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}`, class: 'chart-svg', role: 'img', 'aria-label': cfg.ariaLabel || '' });
    wrap.appendChild(svg);
    for (const v of ys.ticks) {
      svgEl('line', { x1: m.l, x2: m.l + pw, y1: Y(v), y2: Y(v), class: 'grid' }, svg);
      svgEl('text', { x: m.l - 8, y: Y(v) + 4, class: 'tick', 'text-anchor': 'end' }, svg).textContent = v.toLocaleString('en-US');
    }
    const xs = linearScale(x0, x1, Math.max(3, Math.floor(pw / 80)));
    for (const v of xs.ticks) {
      if (v < x0 || v > x1) continue;
      svgEl('text', { x: X(v), y: H - 8, class: 'tick', 'text-anchor': 'middle' }, svg).textContent = cfg.xFormat(v);
    }

    const band = pw / bins.length;
    const bw = Math.min(24, Math.max(1, band - 2));
    const bars = bins.map((b, i) => {
      const x = m.l + i * band + (band - bw) / 2;
      const y = Y(b.count), hh = m.t + ph - y;
      return svgEl('path', { d: hh > 0 ? roundTopBar(x, y, bw, hh, 4) : '', class: 'bar', style: `fill:${colorVar(cfg.color || 1)}` }, svg);
    });
    svgEl('line', { x1: m.l, x2: m.l + pw, y1: m.t + ph, y2: m.t + ph, class: 'axis' }, svg);
    if (x0 < 0 && x1 > 0) svgEl('line', { x1: X(0), x2: X(0), y1: m.t, y2: m.t + ph, class: 'axis' }, svg);

    const tip = makeTooltip(wrap);
    const hit = svgEl('rect', { x: m.l, y: m.t, width: pw, height: ph, class: 'hit', tabindex: 0, 'aria-label': (cfg.ariaLabel || '') + ' — ใช้ปุ่มลูกศรเพื่อดูค่า' }, svg);
    let idx = Math.floor(bins.length / 2);
    const show = (i) => {
      idx = Math.max(0, Math.min(bins.length - 1, i));
      bars.forEach((b, k) => b.classList.toggle('is-hover', k === idx));
      const b = bins[idx];
      fillTooltip(tip, cfg.xFormat(b.x0) + ' ถึง ' + cfg.xFormat(b.x1), [
        { value: b.count.toLocaleString('en-US') + ' วัน', name: ((b.count / (bins.total || 1)) * 100).toFixed(1) + '% ของทั้งหมด' },
      ]);
      placeTooltip(tip, wrap, m.l + (idx + 0.5) * band, m.t);
    };
    const hide = () => { bars.forEach((b) => b.classList.remove('is-hover')); tip.hidden = true; };
    hit.addEventListener('pointermove', (ev) => {
      const r = svg.getBoundingClientRect();
      show(Math.floor((ev.clientX - r.left - m.l) / band));
    });
    hit.addEventListener('pointerleave', hide);
    hit.addEventListener('focus', () => show(idx));
    hit.addEventListener('blur', hide);
    hit.addEventListener('keydown', (ev) => {
      if (ev.key === 'ArrowLeft') { show(idx - 1); ev.preventDefault(); }
      else if (ev.key === 'ArrowRight') { show(idx + 1); ev.preventDefault(); }
      else if (ev.key === 'Escape') hide();
    });
  }

  function parseColor(str) {
    str = str.trim();
    if (str[0] === '#') {
      const v = str.length === 4 ? str.slice(1).split('').map((c) => c + c).join('') : str.slice(1);
      return [0, 2, 4].map((i) => parseInt(v.slice(i, i + 2), 16));
    }
    const m = str.match(/[\d.]+/g);
    return m ? m.slice(0, 3).map(Number) : [128, 128, 128];
  }

  function luminance(rgb) {
    const [r, g, b] = rgb.map((c) => {
      c /= 255;
      return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }

  const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));

  // Diverging heatmap: negative -> red pole, zero -> neutral gray, positive -> blue pole.
  // Defaults to the monthly-returns layout (rows {year, months, total}); a generic grid passes
  // cols, rows {label, values}, total: false, and optionally corner, valueName, cellLabel,
  // mark(ri, ci) -> prefix text, onCell(ri, ci), and lim to share one colour scale across grids.
  function heatmap(container, cfg) {
    container.textContent = '';
    // A container that isn't in the document yet has no computed custom properties.
    const cs = getComputedStyle(container.isConnected ? container : document.documentElement);
    const neg = parseColor(cs.getPropertyValue('--div-neg'));
    const mid = parseColor(cs.getPropertyValue('--div-mid'));
    const pos = parseColor(cs.getPropertyValue('--div-pos'));
    const cols = cfg.cols || TH_MONTHS;
    const withTotal = cfg.total !== false;
    const valsOf = (r) => r.values || r.months;
    const all = [];
    for (const r of cfg.rows) for (const v of valsOf(r)) if (v != null) all.push(Math.abs(v));
    all.sort((a, b) => a - b);
    const lim = cfg.lim || Math.max(all[Math.floor(all.length * 0.95)] || 0.01, 0.005);
    const colorFor = (v) => {
      const t = Math.min(1, Math.abs(v) / lim);
      const rgb = mix(mid, v < 0 ? neg : pos, t);
      return { bg: `rgb(${rgb.join(',')})`, fg: luminance(rgb) < 0.28 ? '#ffffff' : '#0b0b0b' };
    };

    const scroller = h('div', 'table-scroll');
    const table = h('table', 'heatmap' + (cfg.cls ? ' ' + cfg.cls : ''));
    const cap = h('caption', 'sr-only', cfg.caption || '');
    table.appendChild(cap);
    const thead = h('thead');
    const hr = h('tr');
    hr.appendChild(h('th', null, cfg.corner || 'ปี'));
    for (const mn of cols) hr.appendChild(h('th', null, mn));
    if (withTotal) hr.appendChild(h('th', 'col-total', 'ทั้งปี'));
    thead.appendChild(hr);
    table.appendChild(thead);
    const tbody = h('tbody');
    const tip = makeTooltip(scroller);

    cfg.rows.forEach((r, ri) => {
      const tr = h('tr');
      const rowLabel = r.label != null ? String(r.label) : String(r.year);
      tr.appendChild(h('th', null, rowLabel));
      valsOf(r).forEach((v, mi) => {
        const td = h('td');
        if (v == null) { td.className = 'empty'; tr.appendChild(td); return; }
        const c = colorFor(v);
        const mark = cfg.mark ? cfg.mark(ri, mi) : '';
        const cell = h(cfg.onCell ? 'button' : 'span', 'cell', (mark || '') + cfg.format(v));
        if (cfg.onCell) {
          cell.type = 'button';
          cell.addEventListener('click', () => cfg.onCell(ri, mi));
        } else cell.tabIndex = 0;
        cell.style.background = c.bg;
        cell.style.color = c.fg;
        const label = cfg.cellLabel ? cfg.cellLabel(ri, mi) : cols[mi] + ' ' + rowLabel;
        cell.setAttribute('aria-label', label + ': ' + cfg.format(v));
        const on = () => {
          fillTooltip(tip, label, [{ value: cfg.format(v), name: cfg.valueName || 'ผลตอบแทนรายเดือน' }]);
          const cr = cell.getBoundingClientRect(), sr = scroller.getBoundingClientRect();
          placeTooltip(tip, scroller, cr.right - sr.left + scroller.scrollLeft - 10, cr.bottom - sr.top + 4);
        };
        cell.addEventListener('pointerenter', on);
        cell.addEventListener('focus', on);
        cell.addEventListener('pointerleave', () => (tip.hidden = true));
        cell.addEventListener('blur', () => (tip.hidden = true));
        td.appendChild(cell);
        tr.appendChild(td);
      });
      if (withTotal) tr.appendChild(h('td', 'col-total', cfg.format(r.total)));
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    scroller.appendChild(table);
    container.appendChild(scroller);

    const scale = h('div', 'div-scale');
    const bar = h('span', 'div-scale-bar');
    bar.style.background = `linear-gradient(to right, rgb(${neg}), rgb(${mid}), rgb(${pos}))`;
    scale.appendChild(h('span', null, cfg.format(-lim)));
    scale.appendChild(bar);
    scale.appendChild(h('span', null, cfg.format(lim)));
    container.appendChild(scale);
  }

  // Risk/return scatter. cfg: { groups:[{name, color, shape:'dot'|'rect'}], points:[{x, y, group, label, name}],
  //   line:[{x, y}] (drawn in series colour cfg.lineColor), lineName, xFormat, yFormat, xLabel, yLabel, height, ariaLabel }
  function scatter(container, cfg) {
    container.textContent = '';
    const items = cfg.groups.map((g) => ({ name: g.name, color: colorVar(g.color), shape: g.shape === 'rect' ? 'rect' : 'dot' }));
    if (cfg.line && cfg.line.length) items.unshift({ name: cfg.lineName, color: colorVar(cfg.lineColor || 1) });
    legend(container, items);
    const wrap = h('div', 'chart-wrap');
    container.appendChild(wrap);
    const W = Math.max(280, wrap.clientWidth || container.clientWidth);
    const H = cfg.height || 340;
    const m = { t: 14, r: 56, b: 42, l: 60 };
    const pw = W - m.l - m.r, ph = H - m.t - m.b;
    const all = cfg.points.concat(cfg.line || []);
    const xs = all.map((p) => p.x), ys = all.map((p) => p.y);
    const sx = linearScale(Math.min(0, ...xs), Math.max(...xs), Math.max(3, Math.floor(pw / 90)));
    const sy = linearScale(Math.min(0, ...ys), Math.max(...ys), Math.max(3, Math.floor(ph / 50)));
    const X = (v) => m.l + sx.map(v, pw), Y = (v) => m.t + ph - sy.map(v, ph);

    const svg = svgEl('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}`, class: 'chart-svg', role: 'img', 'aria-label': cfg.ariaLabel || '' });
    wrap.appendChild(svg);
    const grid = svgEl('g', {}, svg);
    for (const v of sy.ticks) {
      svgEl('line', { x1: m.l, x2: m.l + pw, y1: Y(v), y2: Y(v), class: 'grid' }, grid);
      svgEl('text', { x: m.l - 8, y: Y(v) + 4, class: 'tick', 'text-anchor': 'end' }, grid).textContent = cfg.yFormat(v);
    }
    for (const v of sx.ticks) {
      svgEl('text', { x: X(v), y: m.t + ph + 16, class: 'tick', 'text-anchor': 'middle' }, grid).textContent = cfg.xFormat(v);
    }
    svgEl('line', { x1: m.l, x2: m.l + pw, y1: Y(0), y2: Y(0), class: 'axis' }, grid);
    svgEl('text', { x: m.l + pw / 2, y: H - 6, class: 'tick', 'text-anchor': 'middle' }, grid).textContent = cfg.xLabel;
    svgEl('text', { x: 12, y: m.t + ph / 2, class: 'tick', 'text-anchor': 'middle', transform: `rotate(-90 12 ${m.t + ph / 2})` }, grid).textContent = cfg.yLabel;

    if (cfg.line && cfg.line.length) {
      const d = cfg.line.map((p, i) => (i ? 'L' : 'M') + X(p.x).toFixed(1) + ',' + Y(p.y).toFixed(1)).join('');
      svgEl('path', { d, class: 'line', style: `stroke:${colorVar(cfg.lineColor || 1)}` }, svg);
    }
    const tip = makeTooltip(wrap);
    for (const p of cfg.points) {
      const g = cfg.groups[p.group];
      const x = X(p.x), y = Y(p.y);
      const mark = g.shape === 'rect'
        ? svgEl('rect', { x: x - 6, y: y - 6, width: 12, height: 12, rx: 2, class: 'dot', style: `fill:${colorVar(g.color)}` }, svg)
        : svgEl('circle', { cx: x, cy: y, r: 5, class: 'dot', style: `fill:${colorVar(g.color)}` }, svg);
      if (p.label) svgEl('text', { x: x + 8, y: y - 6, class: 'end-label' }, svg).textContent = p.label;
      mark.setAttribute('tabindex', 0);
      mark.setAttribute('aria-label', (p.name || p.label) + ': ' + cfg.yLabel + ' ' + cfg.yFormat(p.y) + ', ' + cfg.xLabel + ' ' + cfg.xFormat(p.x));
      const on = () => {
        fillTooltip(tip, p.name || p.label, [
          { value: cfg.yFormat(p.y), name: cfg.yLabel },
          { value: cfg.xFormat(p.x), name: cfg.xLabel },
        ]);
        placeTooltip(tip, wrap, x, Math.max(0, y - 20));
      };
      mark.addEventListener('pointerenter', on);
      mark.addEventListener('focus', on);
      mark.addEventListener('pointerleave', () => (tip.hidden = true));
      mark.addEventListener('blur', () => (tip.hidden = true));
    }
  }

  // Plain data table; all cell text goes through textContent.
  function table(container, columns, rows, opts) {
    container.textContent = '';
    const scroller = h('div', 'table-scroll');
    const t = h('table', 'data-table' + (opts && opts.cls ? ' ' + opts.cls : ''));
    if (opts && opts.caption) t.appendChild(h('caption', 'sr-only', opts.caption));
    const thead = h('thead'), hr = h('tr');
    for (const c of columns) hr.appendChild(h('th', c.num ? 'num' : null, c.label));
    thead.appendChild(hr);
    t.appendChild(thead);
    const tbody = h('tbody');
    for (const r of rows) {
      const tr = h('tr');
      if (r._cls) tr.className = r._cls;
      if (r._onClick) {
        tr.tabIndex = 0;
        tr.addEventListener('click', r._onClick);
        tr.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); r._onClick(); } });
      }
      for (const c of columns) {
        const td = h('td', c.num ? 'num' : null);
        const v = r[c.key];
        if (v && typeof v === 'object' && v.text != null) {
          td.textContent = v.text;
          if (v.cls) td.classList.add(v.cls);
        } else td.textContent = v == null ? '' : String(v);
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
    t.appendChild(tbody);
    scroller.appendChild(t);
    container.appendChild(scroller);
  }

  QL.charts = { lineChart, histogram, heatmap, scatter, table, fmtDate, TH_MONTHS };
})((window.QL = window.QL || {}));
