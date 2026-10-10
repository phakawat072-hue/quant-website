#!/usr/bin/env python3
"""Annual fundamentals from SEC EDGAR for the stocks in scripts/tickers.json.

Writes data/fundamentals.js: for each ticker, one row per fiscal year taken from the
10-K that first reported it, so a row may only be used from its filing date on
(point in time):

    [filed, fiscal_year_end, eps, book_value_per_share, dividends_per_share]

Per-share values are put on the same basis as the bundled prices (split- and
dividend-adjusted closes): divided by every stock split after the filing date and
multiplied by Adj Close / Close on the filing date. Then adjusted price / eps is a
P/E (to within a few percent of dividend drift during the year).
"""
import gzip
import json
import os
import subprocess
import sys
import time
import urllib.request
from datetime import date, datetime, timezone
from pathlib import Path

import pandas as pd
import yfinance as yf

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "fundamentals.js"
UA = None  # set in main(); SEC rejects requests without a real contact email
SKIP = {"BRK-B"}  # Berkshire reports EPS per class A share, which does not match the B share price
# SEC directory maps some tickers to a new holding company with no filing history yet.
CIK_OVERRIDE = {"XOM": 34088}  # Exxon Mobil Corp (ExxonMobil Holdings Corp, CIK 2115436, has no 10-Ks yet)
FIRST_YEAR = 2008

EPS = [("us-gaap", "EarningsPerShareDiluted"), ("us-gaap", "EarningsPerShareBasic"),
       ("us-gaap", "EarningsPerShareBasicAndDiluted")]
EQUITY = [("us-gaap", "StockholdersEquity"),
          ("us-gaap", "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest")]
DPS = [("us-gaap", "CommonStockDividendsPerShareDeclared"), ("us-gaap", "CommonStockDividendsPerShareCashPaid")]


def get_json(url: str):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept-Encoding": "gzip"})
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                body = r.read()
                if r.headers.get("Content-Encoding") == "gzip":
                    body = gzip.decompress(body)
                return json.loads(body)
        except Exception as err:  # noqa: BLE001 - retry any network error, then give up
            if attempt == 3:
                raise
            print(f"  retry {url}: {err}", flush=True)
            time.sleep(2 + 3 * attempt)
    return None


def annual_any(facts: dict, concepts, unit: str, duration: bool) -> dict:
    """annual() over several equivalent concepts. For the same year the earliest filing wins
    (point in time); on a tie the earlier concept in the list wins."""
    out = {}
    for ns, name in concepts:
        items = facts.get("facts", {}).get(ns, {}).get(name, {}).get("units", {}).get(unit) or []
        for end, row in annual(items, duration).items():
            if end not in out or row[0] < out[end][0]:
                out[end] = row
    return out


def days(a: str, b: str) -> int:
    return (date.fromisoformat(b) - date.fromisoformat(a)).days


def annual(items, duration: bool) -> dict:
    """{fiscal_year_end: (filed, value, accn)} from the earliest 10-K that reported each year."""
    out = {}
    for it in items:
        if it.get("form") not in ("10-K", "10-K/A") or it.get("fp") != "FY":
            continue
        end = it["end"]
        if int(end[:4]) < FIRST_YEAR:
            continue
        if duration and not ("start" in it and 300 <= days(it["start"], end) <= 400):
            continue
        prev = out.get(end)
        if prev is None or it["filed"] < prev[0]:
            out[end] = (it["filed"], float(it["val"]), it["accn"])
    return out


def shares_by_accn(facts: dict) -> dict:
    """Shares outstanding on each filing's cover page, summed over share classes."""
    items = facts.get("facts", {}).get("dei", {}).get("EntityCommonStockSharesOutstanding", {}).get("units", {}).get("shares", [])
    by = {}
    for it in items:
        key = (it["accn"], it["end"])
        by[key] = by.get(key, 0) + float(it["val"])
    out = {}
    for (accn, end), v in by.items():
        if accn not in out or end > out[accn][0]:
            out[accn] = (end, v)
    return {a: v for a, (_, v) in out.items()}


def download_history(symbols: list[str]) -> dict:
    """Unadjusted-for-dividends closes, adjusted closes and splits, in one batched request
    per attempt (per-ticker requests get throttled)."""
    got, missing = {}, list(symbols)
    for attempt in range(3):
        if not missing:
            break
        if attempt:
            time.sleep(30 * attempt)
        df = yf.download(missing, start=f"{FIRST_YEAR}-01-01", auto_adjust=False, actions=True,
                         group_by="ticker", threads=True, progress=False, multi_level_index=True)
        for sym in list(missing):
            try:
                h = df[sym] if isinstance(df.columns, pd.MultiIndex) else df
                h = h[["Close", "Adj Close", "Stock Splits"]].dropna(subset=["Close", "Adj Close"])
            except KeyError:
                continue
            if len(h) > 60:
                got[sym] = h
                missing.remove(sym)
        print(f"prices attempt {attempt + 1}: {len(got)}/{len(symbols)}", flush=True)
    return got


def price_factors(hist):
    """(split factor after a date, Adj Close / Close on a date)."""
    hist.index = hist.index.tz_localize(None) if hist.index.tz is not None else hist.index
    splits = [(ts.date(), float(r)) for ts, r in hist["Stock Splits"].items() if r and r > 0]
    ratio = (hist["Adj Close"] / hist["Close"]).dropna()

    def split_after(d: date) -> float:
        f = 1.0
        for sd, r in splits:
            if sd > d:
                f *= r
        return f

    def div_ratio(d: date) -> float:
        i = ratio.index.searchsorted(pd.Timestamp(d))
        i = min(max(i, 0), len(ratio) - 1)
        return float(ratio.iloc[i])

    return split_after, div_ratio


def sig(v):
    return None if v is None else float(f"{v:.5g}")


def rows_for(cik: int, hist):
    facts = get_json(f"https://data.sec.gov/api/xbrl/companyfacts/CIK{cik:010d}.json")
    eps = annual_any(facts, EPS, "USD/shares", True)
    if not eps:
        return []
    equity = annual_any(facts, EQUITY, "USD", False)
    dps = annual_any(facts, DPS, "USD/shares", True)
    income = annual_any(facts, [("us-gaap", "NetIncomeLoss")], "USD", True)
    paid = annual_any(facts, [("us-gaap", "PaymentsOfDividendsCommonStock"), ("us-gaap", "PaymentsOfDividends")], "USD", True)
    cover = shares_by_accn(facts)
    pf = price_factors(hist)
    if pf is None:
        return []
    split_after, div_ratio = pf
    rows = []
    for end, (filed, e, accn) in sorted(eps.items()):
        d = date.fromisoformat(filed)
        k = div_ratio(d) / split_after(d)
        # Shares in the filing's own basis: the cover page count, else net income / EPS.
        sh = cover.get(accn) or (equity.get(end) and cover.get(equity[end][2]))
        if not sh and end in income and e:
            sh = income[end][1] / e
        bvps = equity[end][1] / sh * k if end in equity and sh and sh > 0 else None
        if end in dps:
            dv = dps[end][1] * k
        elif end in paid and sh and sh > 0:
            dv = paid[end][1] / sh * k
        else:
            dv = None
        rows.append([filed, end, sig(e * k), sig(bvps), sig(dv)])
    return clean(rows)


def clean(rows):
    """Keep one row per fiscal year and make rows increase in both filing date and year end.
    52/53-week years and retagged periods can give two year ends a few days apart; a year
    first reported after a later year adds nothing a reader could have used."""
    rows = sorted(rows, key=lambda r: (r[0], r[1]))
    out = []
    for r in rows:
        if out and days(out[-1][1], r[1]) <= 14:
            continue
        out.append(r)
    return out


def contact_agent() -> str | None:
    """SEC requires a User-Agent with a contact email. Use $SEC_USER_AGENT, else the first
    non-noreply commit author email in this repository (so no address is stored in the code)."""
    if os.environ.get("SEC_USER_AGENT"):
        return os.environ["SEC_USER_AGENT"]
    try:
        emails = subprocess.run(["git", "log", "-400", "--format=%ae"], cwd=ROOT, capture_output=True, text=True, check=True).stdout.split()
    except (OSError, subprocess.CalledProcessError):
        return None
    for e in emails:
        if "@" in e and "noreply" not in e:
            return f"QuantLab research {e}"
    return None


def main() -> int:
    global UA
    UA = contact_agent()
    if not UA:
        print("No contact email for the SEC User-Agent; keeping the previous file", flush=True)
        return 0
    tickers = json.loads((ROOT / "scripts" / "tickers.json").read_text(encoding="utf-8"))
    stocks = [t["ticker"] for t in tickers if "ETF" not in t.get("sector", "") and t["ticker"] not in SKIP]
    hist = download_history(stocks)
    directory = get_json("https://www.sec.gov/files/company_tickers.json")
    cik = {v["ticker"].upper(): int(v["cik_str"]) for v in directory.values()}
    out = {}
    for sym in stocks:
        c = CIK_OVERRIDE.get(sym) or cik.get(sym) or cik.get(sym.replace("-", "."))
        if not c:
            print(f"{sym}: no CIK", flush=True)
            continue
        try:
            rows = rows_for(c, hist[sym]) if sym in hist else []
        except Exception as err:  # noqa: BLE001 - one bad ticker must not stop the rest
            print(f"{sym}: failed ({err})", flush=True)
            continue
        if rows:
            out[sym] = rows
        print(f"{sym}: {len(rows)} years", flush=True)
        time.sleep(0.2)  # SEC limit is 10 requests per second
    if len(out) < len(stocks) // 2:
        print(f"Only {len(out)}/{len(stocks)} tickers; keeping the previous file", flush=True)
        return 1
    payload = {
        "updated": datetime.now(timezone.utc).date().isoformat(),
        "source": "SEC EDGAR companyfacts (10-K)",
        "fields": ["filed", "fiscalYearEnd", "eps", "bvps", "dps"],
        "t": out,
    }
    OUT.write_text("QL.data.setFundamentals(" + json.dumps(payload, separators=(",", ":")) + ");\n", encoding="utf-8")
    print(f"Done: {len(out)}/{len(stocks)} tickers", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
