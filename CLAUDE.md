# QuantLab: notes for Claude

Static quant backtesting dashboard (Thai UI) for US stocks. No build step, no
dependencies: plain HTML/CSS/JS loaded as classic `<script>` tags so the page
also works when opened straight from disk (`file://`).

- Live site: https://phakawat072-hue.github.io/quant-website/ (GitHub Pages, `main` branch, repo root)
- Scanner view: same page with `#scan`
- Portfolio view: same page with `#portfolio`
- Shareable links: query string (`?a=AAPL&st=sma&p=20,100&r=5Y...` for the backtest, `?pt=AAPL,JPM&pm=minvar...#portfolio` for portfolios), read once on load by `applyLink()` / the portfolio `init`

## Working with the user

- Reply in **Thai**, in plain language. The user is not a programmer: give
  click-by-click / command-by-command steps, explain jargon, and use tables
  where they help.
- The user works on **Windows** (PowerShell, Claude desktop app). Give
  PowerShell commands, not bash, when they run things locally.
- Workflow the user expects: work on a branch → open a PR → **merge it** when
  asked ("merge"/"merg"). After merging, the site updates in 1–2 minutes;
  tell them to hard-refresh (Ctrl+F5).
- Anything about investing must carry a short risk note (backtests ≠ future
  returns, scanner results ≠ buy/sell advice).
- The repo is **public**: never commit personal data, API keys, or long
  copyrighted text (book notes stay in chat; only cite page numbers).

## Layout

| Path | What it does |
|---|---|
| `index.html` | Single page: backtest view (`#backtestView`) and scanner view (`#scanView`, shown for `#scan`) |
| `css/style.css` | Design tokens on `:root`, light/dark themes (`data-theme` + `prefers-color-scheme`), all component styles |
| `js/data.js` | Simulated assets (regime-switching GBM), CSV parser, loaders for bundled prices (`register`/`setManifest`), symbol directory, scan and movers data |
| `js/strategies.js` | Indicators (SMA, EMA, RSI, Bollinger, rolling high/low, month positions) and the `STRATEGIES` table |
| `js/backtest.js` | Backtest engine, metrics, stop-loss, monthly returns, histogram, `returnStats`, `beta` |
| `js/charts.js` | Hand-written SVG charts (line with crosshair, histogram, heatmap) and data tables |
| `js/search.js` | Accessible stock-search combobox (`/` shortcut) |
| `js/live.js` | Live daily prices from Twelve Data using the viewer's own API key (localStorage, 12 h cache) |
| `js/scan.js` | Scanner view: signals, hot stocks (movers), momentum, YTD, full table |
| `js/portfolio.js` | Portfolio view: aligns bundled tickers, long-only weights (equal, inverse vol, min variance, max Sharpe via projected gradient), periodic rebalancing on trailing 1-year estimates, correlation heatmap, efficient-frontier scatter |
| `js/app.js` | State, controls, rendering, routing between views |
| `data/prices/*.js` | Bundled adjusted daily closes for the tickers in `scripts/tickers.json` (generated) |
| `data/symbols.js` | Every US-listed stock/ETF from NASDAQ Trader for search (generated) |
| `data/scan.js` | Daily signals for S&P 500 + Nasdaq-100 (generated) |
| `data/movers.js` | Daily top movers across all liquid US common stocks (generated) |
| `scripts/fetch_prices.py` | Builds `data/prices/*` and `data/symbols.js` (yfinance) |
| `scripts/scan.py` | Builds `data/scan.js` (members: Wikipedia S&P 500, Nasdaq API for Nasdaq-100) |
| `scripts/movers.py` | Builds `data/movers.js` (chunks of 400 tickers, $1 price / $1M dollar-volume filters) |
| `.github/workflows/update-prices.yml` | Runs the three scripts Mon–Fri 22:30 UTC, on manual dispatch, and on pushes that touch the scripts; commits `data/` as "Update stock prices YYYY-MM-DD" |

Everything under `data/` is generated: never edit it by hand. If a merge
conflicts only in `data/`, take either side (`git checkout --ours -- data/`);
the next workflow run regenerates it.

## Engine rules (keep these invariants)

- A signal decided at the close of day t earns day t+1's return (no look-ahead).
  `signal(close, params, allowShort, dates)` returns a position per day in {-1, 0, 1}.
- Costs are charged on turnover (`costBps`) at the trade close, including size changes.
- Every run goes through `engineOpts()`: `delay` (trade one close later), `size` (vol-targeting
  scale from `BT.volScale`, 20-day realised vol, capped at 1), `cash` (uninvested capital earns `rf`)
  and `borrowPct` (yearly cost of short exposure). With all of them off the engine matches the
  original results exactly. `held` holds the effective exposure; `target` holds the side.
- Stop-loss (`fixed` from entry, or `trailing` from the best close) exits at the
  breaching close, then the strategy stays flat until its own raw signal changes.
  Use `res.target` (the effective position), not the raw signal, for markers, tooltips and CSV.
- Metrics annualise with periods-per-year measured from the data (works for
  weekend-trading CSVs too).
- Bundled and scanned prices are split/dividend-adjusted closes, so trade prices
  differ from historical quotes; the UI says so.

## Adding things

- **Strategy:** add an entry to `STRATEGIES` in `js/strategies.js` with `name`,
  `desc`, `params` (numeric inputs), optional `validate`, `signal`, `overlays`
  (≤ 3 colour slots; `legend: false` for a paired band). It shows up in the
  selector and the comparison table automatically.
- **Bundled ticker:** add it to `scripts/tickers.json` and push; the workflow downloads it.
- **UI text:** Thai. Insert any data-derived text with `textContent`, never `innerHTML`.
- **Charts:** follow the existing marks (2px lines, hairline grid, one y-axis,
  legend for ≥ 2 series, a table view for every chart). Status colours always
  carry an icon and a label (▲/▼, ✓/⚠).

## Testing before a PR

There is no test suite. Before opening a PR:

1. Run quick Node checks of any changed math. The modules attach to `window.QL`;
   use `global.window = {}` and then `require('./js/strategies.js')`.
2. Run a headless Chromium pass with Playwright against `file:///…/index.html`:
   - no console errors
   - the new UI renders
   - the page has no horizontal scroll at 1300 px and at 390 px width
3. For Python scripts, mock `yf.download` / `urllib` and run them in a scratch
   copy, because the network can't be used for real tests (see below).

## Known environment constraints

- The **cloud Claude Code sandbox cannot reach** Yahoo Finance, Stooq,
  Twelve Data, Wikipedia or github.io. Real data is only fetched by GitHub
  Actions, so verify a script change by pushing and reading the workflow run
  and its job logs.
- Plain HTTP requests to Yahoo's chart API get HTTP 429 from GitHub runners;
  use `yfinance` (it handles cookies/crumb).
- Wikipedia's "Nasdaq-100" article has no members table any more, so
  `scan.py` uses `https://api.nasdaq.com/api/quote/list-type/nasdaq100`.
- The claude.ai artifact preview blocks external `fetch`, so live Twelve Data
  prices only work on GitHub Pages or a local `file://` copy. The page shows a
  message when the fetch is blocked.
- Storing full history for all ~5,000 US stocks was rejected (repo bloat).
  Bundle a small set and fetch everything else live.

## Book-based features

The user shared notes on John Allen Paulos, *A Mathematician Plays the Stock
Market* (2003). Features built from it, with the page numbers shown in the UI:

| Feature | Pages |
|---|---|
| Stop-loss and the with/without comparison | 115, 198–202 |
| Breakout support/resistance strategy | 45–47 |
| Turn-of-month and January calendar strategies | 48 |
| Arithmetic vs geometric mean | 95–99 |
| Fat tails (3σ days vs normal, kurtosis) | 136–140, 175–181 |
| Beta and correlation vs SPY | 159–162 |
| First-half vs second-half out-of-sample check | 28–30 |
| Survivorship-bias note on the scanner | 30–31 |
| Parameter-sweep heatmaps (first-half Sharpe picks, second-half Sharpe tests; click a cell to apply) | 28–30, 44 |
| Bootstrap 90% intervals for Sharpe/CAGR and P(Sharpe > 0) | 63–67 |
| Walk-forward (pick best of the sweep on 2 years, trade the next year, roll) | 28–30, 44 |
| Multi-stock portfolio: diversification, covariance, efficient frontier, Sharpe-based weights, systematic risk | 141–162 |
| Portfolio momentum (top half by 12-1 month return) and trend (above SMA200, rest in cash) | 41–48 |
| Risk KPIs (VaR/CVaR 95%, longest drawdown, average exposure), rolling 1-year Sharpe, alpha vs SPY | 136–140, 159–162 |
| Deflated Sharpe for the best of the sweep (Bailey & López de Prado) | 28–30 |

The sweep uses the strategy's first two params, 7 values each around the defaults
(`BT.gridValues`), and caches by data + window + settings so re-renders are cheap.
Sweep and walk-forward share positions through `signalFor` (memoised per strategy,
short setting and data). `BT.bootstrap` is a seeded circular block bootstrap (20-day
blocks, 1,000 draws); `BT.walkForward` stitches the test windows, each starting flat.

Ideas from the book not built yet:
- Value ratios (P/E, P/B, PEG, Dogs of the Dow). These need fundamentals data, which isn't available.
- DeBondt–Thaler 3–5 year contrarian losers. This needs a longer scan history than the current 2 years.
