(function (QL) {
  'use strict';

  // Live daily prices from Twelve Data (https://twelvedata.com), using the viewer's own API key.
  const KEY_STORE = 'ql-twelvedata-key';
  const CACHE_PREFIX = 'ql-td:';
  const CACHE_MS = 12 * 3600 * 1000;
  const memory = {};

  function store(fn) {
    try { return fn(window.localStorage); } catch (e) { return null; }
  }

  const getKey = () => store((s) => s.getItem(KEY_STORE)) || '';
  const setKey = (k) => store((s) => (k ? s.setItem(KEY_STORE, k) : s.removeItem(KEY_STORE)));

  class LiveError extends Error {
    constructor(code, message) {
      super(message);
      this.code = code;
    }
  }

  async function request(symbol, key, adjust) {
    const params = new URLSearchParams({ symbol, interval: '1day', outputsize: '5000', apikey: key });
    if (adjust) params.set('adjust', 'all');
    let res;
    try {
      res = await fetch('https://api.twelvedata.com/time_series?' + params.toString());
    } catch (e) {
      throw new LiveError('network', 'เชื่อมต่อ Twelve Data ไม่ได้ ถ้าเปิดผ่านลิงก์ claude.ai อาจถูกบล็อก ให้เปิดผ่าน GitHub Pages หรือไฟล์ในเครื่องแทน');
    }
    let json;
    try { json = await res.json(); } catch (e) { json = null; }
    if (!json) throw new LiveError('bad_response', 'Twelve Data ตอบกลับไม่ถูกต้อง (HTTP ' + res.status + ')');
    if (json.status === 'error' || !Array.isArray(json.values)) {
      const code = Number(json.code) || res.status;
      const msg = String(json.message || '');
      if (code === 401 || /api ?key/i.test(msg)) throw new LiveError('bad_key', 'API key ไม่ถูกต้อง ตรวจสอบแล้วบันทึกใหม่');
      if (code === 429) throw new LiveError('rate_limited', 'เกินโควต้าของ Twelve Data (แพ็กเกจฟรี 8 ครั้ง/นาที, 800 ครั้ง/วัน) รอสักครู่แล้วลองใหม่');
      if (code === 400 && adjust && /adjust/i.test(msg)) return request(symbol, key, false);
      if (code === 404 || code === 400) throw new LiveError('not_found', 'Twelve Data ไม่มีข้อมูล ' + symbol + ' (บางตัวต้องใช้แพ็กเกจเสียเงิน)');
      throw new LiveError('api_error', 'Twelve Data: ' + (msg || 'เกิดข้อผิดพลาด ' + code));
    }
    return { json, adjusted: adjust };
  }

  function toSeries(symbol, name, json, adjusted) {
    const rows = [];
    for (const v of json.values) {
      const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(v.datetime || '');
      const c = parseFloat(v.close);
      if (m && isFinite(c) && c > 0) rows.push([Date.UTC(+m[1], +m[2] - 1, +m[3]), c]);
    }
    rows.sort((a, b) => a[0] - b[0]);
    const dates = [], close = [];
    for (const [t, c] of rows) {
      if (dates.length && dates[dates.length - 1] === t) continue;
      dates.push(t);
      close.push(c);
    }
    if (dates.length < 60) throw new LiveError('too_short', symbol + ' มีข้อมูลน้อยเกินไป (' + dates.length + ' วัน)');
    return {
      source: 'live',
      name: symbol,
      label: name || symbol,
      provider: 'Twelve Data',
      adjustedNote: adjusted ? 'ราคาปิดปรับปันผลและการแตกหุ้นแล้ว' : 'ราคาปิดปรับการแตกหุ้นแล้ว',
      dates,
      close,
    };
  }

  async function fetchSeries(symbol, name) {
    if (memory[symbol]) return memory[symbol];
    const cached = store((s) => JSON.parse(s.getItem(CACHE_PREFIX + symbol) || 'null'));
    if (cached && Date.now() - cached.at < CACHE_MS) {
      memory[symbol] = cached.series;
      return cached.series;
    }
    const key = getKey();
    if (!key) throw new LiveError('no_key', 'ต้องใส่ API key ของ Twelve Data ก่อน');
    const { json, adjusted } = await request(symbol, key, true);
    const series = toSeries(symbol, name, json, adjusted);
    memory[symbol] = series;
    const payload = JSON.stringify({ at: Date.now(), series });
    store((s) => {
      try {
        s.setItem(CACHE_PREFIX + symbol, payload);
      } catch (e) {
        Object.keys(s).filter((k) => k.startsWith(CACHE_PREFIX)).forEach((k) => s.removeItem(k));
      }
    });
    return series;
  }

  QL.live = { getKey, setKey, fetchSeries, LiveError };
})((window.QL = window.QL || {}));
