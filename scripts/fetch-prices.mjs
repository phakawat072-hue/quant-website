#!/usr/bin/env node
// Downloads daily adjusted closes for every ticker in scripts/tickers.json
// and writes them as script files the static site can load from file:// too.
import { readFile, writeFile, mkdir, readdir, rm } from 'node:fs/promises';

const ROOT = new URL('..', import.meta.url);
const OUT = new URL('data/prices/', ROOT);
const START = '2010-01-01';
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fromYahoo(symbol) {
  const p1 = Math.floor(Date.parse(START) / 1000);
  const p2 = Math.floor(Date.now() / 1000);
  let lastErr;
  for (const host of ['query1', 'query2']) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const url = `https://${host}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
          `?period1=${p1}&period2=${p2}&interval=1d&events=div%2Csplit&includeAdjustedClose=true`;
        const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
        if (!res.ok) throw new Error(`Yahoo HTTP ${res.status}`);
        const json = await res.json();
        const r = json?.chart?.result?.[0];
        if (!r?.timestamp) throw new Error(json?.chart?.error?.description || 'Yahoo: no data');
        const offset = r.meta?.gmtoffset ?? -18000;
        const adj = r.indicators?.adjclose?.[0]?.adjclose;
        const close = r.indicators?.quote?.[0]?.close;
        const src = adj && adj.some((v) => v != null) ? adj : close;
        return r.timestamp.map((ts, i) => [new Date((ts + offset) * 1000).toISOString().slice(0, 10), src?.[i]]);
      } catch (e) {
        lastErr = e;
        await sleep(1500 * attempt);
      }
    }
  }
  throw lastErr;
}

async function fromStooq(symbol) {
  const res = await fetch(`https://stooq.com/q/d/l/?s=${encodeURIComponent(symbol.toLowerCase())}.us&i=d`, { headers: { 'User-Agent': UA } });
  const text = await res.text();
  if (!res.ok || !/^Date,/i.test(text)) throw new Error('Stooq: no data');
  return text.trim().split(/\r?\n/).slice(1).map((line) => {
    const cells = line.split(',');
    return [cells[0], parseFloat(cells[4])];
  });
}

function clean(rows) {
  const byDate = new Map();
  for (const [d, v] of rows) {
    if (d >= START && typeof v === 'number' && isFinite(v) && v > 0) byDate.set(d, v);
  }
  return [...byDate.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
}

function encode(rows) {
  const DAY = 86400000;
  let prev = Date.parse(rows[0][0] + 'T00:00:00Z');
  const d = rows.map(([date]) => {
    const t = Date.parse(date + 'T00:00:00Z');
    const gap = Math.round((t - prev) / DAY);
    prev = t;
    return gap;
  });
  const c = rows.map(([, v]) => Number(v.toPrecision(6)));
  return { start: rows[0][0], d, c };
}

async function readExisting(ticker) {
  try {
    const text = await readFile(new URL(`${ticker}.js`, OUT), 'utf8');
    const json = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
    const DAY = 86400000;
    const last = Date.parse(json.start + 'T00:00:00Z') + json.d.reduce((a, b) => a + b, 0) * DAY;
    return { first: json.start, last: new Date(last).toISOString().slice(0, 10), rows: json.c.length };
  } catch {
    return null;
  }
}

const tickers = JSON.parse(await readFile(new URL('scripts/tickers.json', ROOT), 'utf8'));
await mkdir(OUT, { recursive: true });

const entries = [];
const failed = [];
for (const t of tickers) {
  let rows = [];
  let source = 'Yahoo Finance';
  try {
    rows = clean(await fromYahoo(t.ticker));
  } catch (e) {
    console.warn(`${t.ticker}: ${e.message}, trying Stooq`);
    try {
      rows = clean(await fromStooq(t.ticker));
      source = 'Stooq';
    } catch (e2) {
      console.warn(`${t.ticker}: ${e2.message}`);
    }
  }

  if (rows.length >= 60) {
    const payload = encode(rows);
    await writeFile(new URL(`${t.ticker}.js`, OUT), `QL.data.register(${JSON.stringify(t.ticker)},${JSON.stringify(payload)});\n`);
    entries.push({ ...t, first: rows[0][0], last: rows[rows.length - 1][0], rows: rows.length, source });
    console.log(`${t.ticker}: ${rows.length} rows ${rows[0][0]} → ${rows[rows.length - 1][0]} (${source})`);
  } else {
    failed.push(t.ticker);
    const prev = await readExisting(t.ticker);
    if (prev) entries.push({ ...t, ...prev, source: 'cached' });
  }
  await sleep(400);
}

if (!entries.length) {
  console.error('No price data could be downloaded.');
  process.exit(1);
}

const updated = entries.reduce((m, e) => (e.last > m ? e.last : m), '');
const manifest = { updated, generatedAt: new Date().toISOString(), tickers: entries };
await writeFile(new URL('index.js', OUT), `QL.data.setManifest(${JSON.stringify(manifest, null, 1)});\n`);

// Remove data for tickers no longer listed so the folder mirrors tickers.json.
const keep = new Set(entries.map((e) => `${e.ticker}.js`).concat('index.js'));
for (const f of await readdir(OUT)) {
  if (f.endsWith('.js') && !keep.has(f)) await rm(new URL(f, OUT));
}

if (failed.length) console.log(`::warning::Could not download: ${failed.join(', ')}`);
console.log(`Done: ${entries.length}/${tickers.length} tickers, latest ${updated}`);
