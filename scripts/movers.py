#!/usr/bin/env python3
"""Daily "hot stocks" (big movers / unusual volume) across every US-listed common stock.

Reads the symbol directory written by fetch_prices.py (data/symbols.js), downloads one
month of daily bars in chunks, and writes only the ranked lists to data/movers.js.
"""
import json
import math
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd
import yfinance as yf

ROOT = Path(__file__).resolve().parent.parent
SYMBOLS = ROOT / "data" / "symbols.js"
OUT = ROOT / "data" / "movers.js"
CHUNK = 400
TOP = 40
MIN_PRICE = 1.0            # skip penny stocks
MIN_DOLLAR_VOLUME = 1e6    # skip illiquid names (20-day average, USD)


def load_symbols() -> list[list]:
    text = SYMBOLS.read_text()
    rows = json.loads(text[text.index("["): text.rindex("]") + 1])
    return [r for r in rows if not r[3]]  # common stocks only, no ETFs


def frame_for(df: pd.DataFrame, sym: str) -> pd.DataFrame | None:
    if df is None or df.empty:
        return None
    try:
        if isinstance(df.columns, pd.MultiIndex):
            if sym not in df.columns.get_level_values(0):
                return None
            sub = df[sym]
        else:
            sub = df
        out = sub[["Close", "Volume"]].apply(pd.to_numeric, errors="coerce").dropna()
    except KeyError:
        return None
    return out if len(out) >= 7 else None


def download(yahoo: list[str]) -> dict[str, pd.DataFrame]:
    got: dict[str, pd.DataFrame] = {}
    for start in range(0, len(yahoo), CHUNK):
        chunk = yahoo[start: start + CHUNK]
        for attempt in range(2):
            try:
                df = yf.download(chunk, period="1mo", auto_adjust=True, group_by="ticker",
                                 threads=True, progress=False, multi_level_index=True)
            except Exception as e:
                print(f"chunk {start}: {e}")
                df = None
            found = {s: f for s in chunk if (f := frame_for(df, s)) is not None}
            if len(found) >= 0.5 * len(chunk) or attempt:
                got.update(found)
                break
            time.sleep(20)
        print(f"{min(start + CHUNK, len(yahoo))}/{len(yahoo)} requested, {len(got)} with data", flush=True)
        time.sleep(2)
    return got


def num(x, digits=4):
    x = float(x)
    return round(x, digits) if math.isfinite(x) else None


def main() -> int:
    symbols = load_symbols()
    by_yahoo = {s.replace(".", "-"): (s, name, exch) for s, name, exch, _ in symbols}
    frames = download(list(by_yahoo))
    if len(frames) < 0.5 * len(by_yahoo):
        print(f"::warning::Only {len(frames)}/{len(by_yahoo)} downloaded; keeping the previous movers file")
        return 0

    as_of = max(f.index[-1] for f in frames.values())
    rows = []
    for ysym, f in frames.items():
        if f.index[-1] != as_of:
            continue  # halted / stale quotes
        close, vol = f["Close"], f["Volume"]
        prev = vol.iloc[-21:-1]
        avg_vol = prev.mean()
        last = close.iloc[-1]
        dollar_vol = (close.iloc[-21:-1] * prev).mean()
        if last < MIN_PRICE or not dollar_vol >= MIN_DOLLAR_VOLUME or not avg_vol > 0:
            continue
        sym, name, exch = by_yahoo[ysym]
        rows.append({
            "t": sym, "n": name, "ex": exch,
            "c": num(last, 2 if last >= 1 else 4),
            "d1": num(last / close.iloc[-2] - 1),
            "d5": num(last / close.iloc[-6] - 1) if len(close) >= 6 else None,
            "vr": num(vol.iloc[-1] / avg_vol, 2),
            "dv": num(close.iloc[-1] * vol.iloc[-1] / 1e6, 1),
        })

    def top(key, reverse=True, cond=lambda r: True):
        ok = [r for r in rows if r[key] is not None and cond(r)]
        return sorted(ok, key=lambda r: r[key], reverse=reverse)[:TOP]

    payload = {
        "asOf": as_of.date().isoformat(),
        "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "universe": len(rows),
        "minPrice": MIN_PRICE,
        "minDollarVolumeM": MIN_DOLLAR_VOLUME / 1e6,
        "lists": {
            "gainers": top("d1"),
            "volume": top("vr", cond=lambda r: r["vr"] >= 2),
            "week": top("d5"),
            "losers": top("d1", reverse=False),
        },
    }
    OUT.write_text("QL.data.setMovers(" + json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + ");\n")
    print(f"Movers: {len(rows)} liquid stocks as of {payload['asOf']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
