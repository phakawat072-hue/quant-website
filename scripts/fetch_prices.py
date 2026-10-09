#!/usr/bin/env python3
"""Download adjusted daily closes for every ticker in scripts/tickers.json.

Writes data/prices/<TICKER>.js plus a manifest (data/prices/index.js). The files
are JS rather than JSON so the static site can load them from file:// as well.
"""
import json
import re
import sys
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd
import yfinance as yf

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "prices"
START = "2010-01-01"
MIN_ROWS = 60


def close_series(df: pd.DataFrame, symbol: str) -> pd.Series | None:
    if df is None or df.empty:
        return None
    try:
        if isinstance(df.columns, pd.MultiIndex):
            col = df[symbol]["Close"] if symbol in df.columns.get_level_values(0) else df["Close"][symbol]
        else:
            col = df["Close"]
    except KeyError:
        return None
    s = pd.to_numeric(col, errors="coerce").dropna()
    s = s[s > 0]
    return s if len(s) >= MIN_ROWS else None


def download(symbols: list[str]) -> dict[str, pd.Series]:
    got: dict[str, pd.Series] = {}
    missing = list(symbols)
    for attempt in range(3):
        if not missing:
            break
        if attempt:
            time.sleep(30 * attempt)
        df = yf.download(missing, start=START, auto_adjust=True, group_by="ticker",
                         threads=True, progress=False, multi_level_index=True)
        for sym in list(missing):
            s = close_series(df, sym)
            if s is not None:
                got[sym] = s
                missing.remove(sym)
        print(f"attempt {attempt + 1}: {len(got)}/{len(symbols)} downloaded", flush=True)
    return got


def encode(s: pd.Series) -> dict:
    dates = [ts.date() for ts in s.index]
    gaps = [0] + [(b - a).days for a, b in zip(dates, dates[1:])]
    closes = [float(f"{v:.6g}") for v in s.to_numpy()]
    return {"start": dates[0].isoformat(), "d": gaps, "c": closes}


def read_existing(ticker: str) -> dict | None:
    path = OUT / f"{ticker}.js"
    try:
        text = path.read_text()
        data = json.loads(text[text.index("{"): text.rindex("}") + 1])
    except (OSError, ValueError):
        return None
    last = pd.Timestamp(data["start"]) + pd.Timedelta(days=sum(data["d"]))
    return {"first": data["start"], "last": last.date().isoformat(), "rows": len(data["c"])}


SYMDIR = "https://www.nasdaqtrader.com/dynamic/SymDir/"
EXCHANGES = {"N": "NYSE", "A": "NYSE American", "P": "NYSE Arca", "Z": "Cboe", "V": "IEX"}
SYMBOL_RE = re.compile(r"^[A-Z]{1,5}(\.[A-Z])?$")
SKIP_NAME_RE = re.compile(r"\b(warrants?|rights?|units?|preferred|notes? due|debentures?|subordinated)\b|%", re.I)
SUFFIX_RE = re.compile(r"\s*(common stock|common shares|ordinary shares|class [a-z] common stock)\b.*$", re.I)


def fetch_text(url: str) -> str:
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=60) as res:
        return res.read().decode("utf-8", "replace")


def clean_name(name: str) -> str:
    cls = re.search(r"\bClass ([A-Z])\b", name)
    base = SUFFIX_RE.sub("", name.split(" - ")[0]).strip(" ,-")
    if cls and f"Class {cls.group(1)}" not in base:
        base += f" Class {cls.group(1)}"
    return base or name


def parse_symdir(text: str, symbol_col: str, exchange_of) -> list[list]:
    lines = [l for l in text.splitlines() if l and not l.startswith("File Creation Time")]
    header = lines[0].split("|")
    col = {h: i for i, h in enumerate(header)}
    out = []
    for line in lines[1:]:
        f = line.split("|")
        if len(f) < len(header) or f[col["Test Issue"]] == "Y":
            continue
        sym, name = f[col[symbol_col]].strip(), f[col["Security Name"]].strip()
        if not SYMBOL_RE.match(sym) or SKIP_NAME_RE.search(name):
            continue
        out.append([sym, clean_name(name), exchange_of(f, col), 1 if f[col["ETF"]] == "Y" else 0])
    return out


def build_symbol_directory() -> int:
    """Every US-listed stock/ETF for the site's search box (prices for these are fetched live)."""
    try:
        rows = parse_symdir(fetch_text(SYMDIR + "nasdaqlisted.txt"), "Symbol", lambda f, c: "NASDAQ")
        rows += parse_symdir(fetch_text(SYMDIR + "otherlisted.txt"), "ACT Symbol",
                             lambda f, c: EXCHANGES.get(f[c["Exchange"]], f[c["Exchange"]]))
    except Exception as e:  # keep the previous directory if the source is down
        print(f"::warning::Symbol directory download failed: {e}")
        return 0
    if len(rows) < 1000:
        print(f"::warning::Symbol directory looks incomplete ({len(rows)} rows); keeping the old one")
        return 0
    rows.sort(key=lambda r: r[0])
    (ROOT / "data" / "symbols.js").write_text(
        "QL.data.setSymbols(" + json.dumps(rows, ensure_ascii=False, separators=(",", ":")) + ");\n")
    print(f"Symbol directory: {len(rows)} symbols")
    return len(rows)


def main() -> int:
    build_symbol_directory()
    tickers = json.loads((ROOT / "scripts" / "tickers.json").read_text())
    OUT.mkdir(parents=True, exist_ok=True)
    series = download([t["ticker"] for t in tickers])

    entries, failed = [], []
    for t in tickers:
        sym = t["ticker"]
        s = series.get(sym)
        if s is not None:
            payload = encode(s)
            (OUT / f"{sym}.js").write_text(
                f"QL.data.register({json.dumps(sym)},{json.dumps(payload, separators=(',', ':'))});\n")
            entries.append({**t, "first": payload["start"], "last": s.index[-1].date().isoformat(),
                            "rows": len(s), "source": "Yahoo Finance"})
        else:
            failed.append(sym)
            prev = read_existing(sym)
            if prev:
                entries.append({**t, **prev, "source": "Yahoo Finance"})

    if not entries:
        print("::error::No price data could be downloaded.")
        return 1

    manifest = {
        "updated": max(e["last"] for e in entries),
        "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "tickers": entries,
    }
    (OUT / "index.js").write_text(
        "QL.data.setManifest(" + json.dumps(manifest, ensure_ascii=False, indent=1) + ");\n")

    keep = {f"{e['ticker']}.js" for e in entries} | {"index.js"}
    for f in OUT.glob("*.js"):
        if f.name not in keep:
            f.unlink()

    if failed:
        print(f"::warning::Could not download: {', '.join(failed)}")
    print(f"Done: {len(entries)}/{len(tickers)} tickers, latest {manifest['updated']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
