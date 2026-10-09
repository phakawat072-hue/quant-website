#!/usr/bin/env python3
"""Daily scanner over S&P 500 + Nasdaq-100 members; writes data/scan.js.

Only the computed signals are stored (a small file), not the price history,
so the repository does not grow with the size of the universe.
"""
import io
import json
import math
import sys
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd
import yfinance as yf

from fetch_prices import clean_name, close_series

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "scan.js"
UA = "Mozilla/5.0 (compatible; QuantLab-scanner/1.0; +https://github.com/phakawat072-hue/quant-website)"
SP500_URLS = ["https://en.wikipedia.org/wiki/List_of_S%26P_500_companies"]
NDX_URLS = ["https://api.nasdaq.com/api/quote/list-type/nasdaq100", "https://en.wikipedia.org/wiki/Nasdaq-100"]
BROWSER_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
SIGNAL_DAYS = 5  # a cross counts as "today's signal" if it happened in the last 5 sessions

SECTOR_TH = {
    "Information Technology": "เทคโนโลยี",
    "Communication Services": "สื่อสาร",
    "Consumer Discretionary": "สินค้าฟุ่มเฟือย",
    "Consumer Staples": "สินค้าจำเป็น",
    "Health Care": "สุขภาพ",
    "Financials": "การเงิน",
    "Industrials": "อุตสาหกรรม",
    "Energy": "พลังงาน",
    "Materials": "วัสดุ",
    "Utilities": "สาธารณูปโภค",
    "Real Estate": "อสังหาริมทรัพย์",
    # ICB names used by the Nasdaq-100 page
    "Technology": "เทคโนโลยี",
    "Telecommunications": "สื่อสาร",
    "Basic Materials": "วัสดุ",
}


def read_tables(url: str) -> list[pd.DataFrame]:
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=60) as res:
        return pd.read_html(io.StringIO(res.read().decode("utf-8", "replace")))


def find_col(cols: dict, *needles: str):
    return next((cols[c] for n in needles for c in cols if n in c), None)


def nasdaq_api_members(url: str) -> list[tuple[str, str, str]]:
    req = urllib.request.Request(url, headers={"User-Agent": BROWSER_UA, "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as res:
        body = json.loads(res.read().decode("utf-8", "replace"))
    data = body.get("data") or {}
    rows = (data.get("data") or {}).get("rows") or data.get("rows") or []
    return [(str(r["symbol"]).strip().upper(), clean_name(str(r.get("companyName", r["symbol"]))), "")
            for r in rows if r.get("symbol")]


def constituents(url: str, min_rows: int, max_rows: int) -> list[tuple[str, str, str]]:
    if "api.nasdaq.com" in url:
        found = nasdaq_api_members(url)
        if not (min_rows <= len(found) <= max_rows):
            raise ValueError(f"unexpected member count {len(found)}")
        return found
    seen = []
    for t in read_tables(url):
        if isinstance(t.columns, pd.MultiIndex):
            t.columns = [" ".join(str(x) for x in c if not str(x).startswith("Unnamed")) for c in t.columns]
        cols = {str(c).strip().lower(): c for c in t.columns}
        seen.append(f"{len(t)} rows {list(cols)[:6]}")
        sym = find_col(cols, "ticker", "symbol")
        name = find_col(cols, "security", "company", "name")
        sector = find_col(cols, "gics sector", "icb industry", "sector", "industry")
        if sym is None or name is None or not (min_rows <= len(t) <= max_rows):
            continue
        out = [(str(r[sym]).strip().upper(), str(r[name]).strip(),
                str(r[sector]).strip() if sector is not None else "") for _, r in t.iterrows()]
        return [x for x in out if x[0] and x[0] != "NAN"]
    raise ValueError(f"constituents table not found; tables seen: {seen[:8]}")


def previous_rows() -> list[dict]:
    try:
        text = OUT.read_text()
        return json.loads(text[text.index("{"): text.rindex("}") + 1])["rows"]
    except (OSError, ValueError, KeyError):
        return []


def universe() -> dict[str, dict]:
    members: dict[str, dict] = {}
    for flag, urls, lo, hi in (("S", SP500_URLS, 450, 560), ("N", NDX_URLS, 95, 130)):
        for url in urls:
            try:
                found = constituents(url, lo, hi)
            except Exception as e:  # Wikipedia layout or network change: try the next page
                print(f"::warning::Could not read index members from {url}: {e}")
                continue
            for sym, name, sector in found:
                m = members.setdefault(sym, {"n": name, "s": SECTOR_TH.get(sector, sector), "i": ""})
                if flag not in m["i"]:
                    m["i"] += flag
            break
    if len(members) < 400:
        print(f"::warning::Universe looks incomplete ({len(members)}); reusing the previous scan's members")
        for r in previous_rows():
            members.setdefault(r["t"], {"n": r["n"], "s": r["s"], "i": r.get("i", "")})
    return members


def download(yahoo: list[str]) -> dict[str, pd.Series]:
    got: dict[str, pd.Series] = {}
    missing = list(yahoo)
    for attempt in range(3):
        if not missing:
            break
        if attempt:
            time.sleep(30 * attempt)
        df = yf.download(missing, period="2y", auto_adjust=True, group_by="ticker",
                         threads=True, progress=False, multi_level_index=True)
        for sym in list(missing):
            s = close_series(df, sym)
            if s is not None:
                got[sym] = s
                missing.remove(sym)
        print(f"attempt {attempt + 1}: {len(got)}/{len(yahoo)} downloaded", flush=True)
    return got


def rsi(s: pd.Series, n: int = 14) -> pd.Series:
    d = s.diff()
    gain = d.clip(lower=0).ewm(alpha=1 / n, adjust=False).mean()
    loss = (-d.clip(upper=0)).ewm(alpha=1 / n, adjust=False).mean()
    return 100 - 100 / (1 + gain / loss)


def sessions_since_cross(diff: pd.Series, up: bool) -> int | None:
    """Sessions since `diff` last changed sign into the given direction (0 = today), within SIGNAL_DAYS."""
    tail = (diff.dropna() > 0).iloc[-(SIGNAL_DAYS + 1):]
    if len(tail) < 2 or bool(tail.iloc[-1]) != up:
        return None
    for k in range(len(tail) - 1, 0, -1):
        if tail.iloc[k] != tail.iloc[k - 1]:
            return len(tail) - 1 - k
    return None


def num(x, digits: int = 4):
    if x is None:
        return None
    x = float(x)
    return round(x, digits) if math.isfinite(x) else None


def ret(s: pd.Series, back: int, skip: int = 0):
    if len(s) <= back:
        return None
    return s.iloc[-1 - skip] / s.iloc[-1 - back] - 1


def metrics(s: pd.Series) -> dict:
    last = s.iloc[-1]
    year_start = pd.Timestamp(year=s.index[-1].year, month=1, day=1, tz=s.index.tz)
    before = s[s.index < year_start]
    window = s.iloc[-252:]
    sma50, sma200 = s.rolling(50).mean(), s.rolling(200).mean()
    ema200 = s.ewm(span=200, adjust=False).mean()
    r = rsi(s)
    long_enough = len(s) >= 200
    return {
        "c": num(last, 2 if last >= 1 else 4),
        "d1": num(ret(s, 1)),
        "m1": num(ret(s, 21)),
        "m3": num(ret(s, 63)),
        "m6": num(ret(s, 126)),
        "m12": num(ret(s, 252)),
        "mom": num(ret(s, 252, skip=21)),
        "ytd": num(last / before.iloc[-1] - 1) if len(before) else None,
        "fh": num(last / window.max() - 1),
        "hi": bool(last >= window.max() * 0.999) if len(s) >= 252 else False,
        "vol": num(s.pct_change().iloc[-63:].std() * math.sqrt(252)),
        "rsi": num(r.iloc[-1], 1),
        "gc": sessions_since_cross(sma50 - sma200, True) if long_enough else None,
        "dc": sessions_since_cross(sma50 - sma200, False) if long_enough else None,
        "eu": sessions_since_cross(s - ema200, True) if long_enough else None,
        "ed": sessions_since_cross(s - ema200, False) if long_enough else None,
    }


def main() -> int:
    members = universe()
    if not members:
        print("::error::No universe to scan")
        return 1
    to_yahoo = {sym: sym.replace(".", "-") for sym in members}
    series = download(sorted(set(to_yahoo.values())))

    rows = []
    for sym, info in sorted(members.items()):
        s = series.get(to_yahoo[sym])
        if s is None or len(s) < 60:
            continue
        rows.append({"t": sym, "n": info["n"], "s": info["s"], "i": info["i"], **metrics(s)})

    if len(rows) < 0.5 * len(members):
        print(f"::warning::Only {len(rows)}/{len(members)} stocks downloaded; keeping the previous scan")
        return 0

    as_of = max(series[to_yahoo[r["t"]]].index[-1] for r in rows).date().isoformat()
    payload = {
        "asOf": as_of,
        "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "signalDays": SIGNAL_DAYS,
        "counts": {"sp500": sum("S" in r["i"] for r in rows), "ndx": sum("N" in r["i"] for r in rows)},
        "rows": rows,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text("QL.data.setScan(" + json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + ");\n")
    print(f"Scan: {len(rows)}/{len(members)} stocks as of {as_of}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
