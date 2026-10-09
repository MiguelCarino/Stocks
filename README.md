# Stocks

An open-source markets monitor for stocks, ETFs, crypto and currencies, part of [Carino Systems](https://carino.systems). Live at **stocks.carino.systems**.

It runs entirely in your browser. You bring your own free API keys, and your watchlist, transactions, alerts and notes are stored in this browser and nowhere else.

> **Monitoring, visualization and education only.** Stocks does not place trades, connect to a brokerage, move money or give advice. Screener presets, calculators and lessons are labelled educational. Quotes may be delayed, and alerts only fire while a Stocks tab is open.

## Who it is for

Stocks has three experience levels: **Beginner**, **Standard** and **Pro**. You choose one on first run ("How familiar are you with markets?") and can change it any time from the level button in the header, the Learn widget, Settings or the command palette.

A level decides what is **offered first**: chart types, indicators, alert conditions, portfolio columns and widgets. It never changes what data is kept, and nothing is locked away. "Show all widgets" and the level switch are always one click away. Changing level never moves your widgets. Each level also has a starting layout, which you can apply from Settings → Experience level.

### New to investing (Beginner)

- **Watchlist cards** with the price, the change since the previous close, today's low–high bar and a sparkline. A one-line key above the cards explains each part.
- **A simple chart** that follows the symbol you click. It offers line, area or candles with up to two indicators.
- **"What am I looking at?" tips**, a **term of the day** and **12 short guided lessons** in four paths: Start here, Reading charts, Money and risk, and Pro tips. Each lesson points at the real controls ("Show me").
- **A glossary of 159 terms** in plain language, each with an example and a "watch out" note. Every `?` next to a term opens its explanation.
- **A one-minute guided tour** on first run, which you can replay from Learn or the command palette.
- **A simple portfolio** showing value, today's change, total gain and weight. Use "Add a holding" to record a purchase.
- **Basic alerts** for price, day change % and new 52-week highs and lows.
- **Safety notes** everywhere: where each price comes from, how old it is, and that nothing here is advice.

### Everyday investors (Standard)

- **Full charting.** Six chart types (candles, OHLC, Heikin-Ashi, line, area, baseline), log scale, volume, compare overlays, and drawings (horizontal line, trend line, ray, rectangle, Fibonacci retracement, text note, measure) saved per symbol. Lines on the chart show your alerts, your average cost, the previous close and the 52-week high and low. Drag an alert line to move the alert, or right-click → "Alert at this price".
- **24 indicators.** Moving averages (SMA, EMA, WMA), VWAP, Bollinger Bands, Keltner and Donchian channels, Ichimoku, Parabolic SAR, SuperTrend, pivot points, RSI, MACD, Stochastic, Stochastic RSI, ATR, ADX/DMI, OBV, MFI, CCI, Williams %R, ROC, Chaikin Money Flow and a volume moving average. Each one has adjustable settings and a glossary entry.
- **A transaction ledger.** Record buys, sells, dividends, fees, splits, deposits, withdrawals, interest and tax, or import a CSV from Interactive Brokers, Schwab, Fidelity, Vanguard, Robinhood, eToro, Trading 212, Degiro, GBM+, Bitso, Coinbase or Kraken. The importer previews new, duplicate, skipped and error rows before anything is saved.
- **Portfolio maths.** FIFO or average cost, realized and unrealized gain, dividends, fees, multiple accounts and currencies converted into a base currency (a missing exchange rate is reported, never assumed to be 1:1), plus a positions CSV.
- **Allocation** by asset class, holding, sector, currency or account, with target percentages and drift.
- **Performance.** Time-weighted return against SPY or any benchmark, XIRR, maximum drawdown, volatility, Sharpe, Sortino and beta.
- **Income.** Dividends received over the last 12 months, an estimate for the next 12, yield on cost and upcoming ex-dates.
- **21 alert conditions.** Price, % change, gap, volume, relative volume, distance from the 52-week high or low, trailing drop from peak, price vs SMA or EMA, RSI, and portfolio value or day P/L. Each alert can fire once or re-arm, and can be limited to a session and given an expiry. A live preview says whether it would fire right now.
- **Research widgets**: news, fundamentals, an earnings and dividend calendar, compare, heatmap, movers and a screener over bundled lists (US mega caps, Dow 30, Nasdaq-100 top, sector ETFs, crypto top 20, FX majors, Mexico BMV leaders).
- **Calculators**: position size, risk/reward with "Alert at stop/target" buttons, break-even, % change, recovery and compounding. They are educational, not a recommendation.
- **Notes**: general notes or one per symbol, in a small Markdown subset (headings, lists, to-dos, bold, links, `$TICKER` links).

### Active traders and analysts (Pro)

- **A dense starting layout**: a tape, a sortable quote table, two charts (one linked to the selection, one pinned to SPY), fundamentals and alerts. A Markets tab holds the screener, heatmap, movers, calendar, news and compare; a Portfolio tab holds performance, income, the calculator and notes.
- **Multi-chart crosshair sync** between linked charts.
- **More alert conditions**: moving-average crossovers (golden and death cross), MACD vs signal, Bollinger Band breaks and moves larger than k × ATR.
- **More risk metrics**: correlation and alpha against the benchmark, on top of the Standard performance figures.
- **The command palette** (Ctrl/⌘+K) and single-key shortcuts (press `?` for the list).
- **Raw provider diagnostics** in Settings → Data & providers: error messages, queued requests and cool-downs.
- **Detached displays**: put any widget in its own window or a Picture-in-Picture tile on another monitor. Panels reuse this window's data and make no API calls of their own.
- **Multi-monitor detection** (Chrome and Edge, via the Window Management API):
  - On load the page reads `screen.isExtended`, which needs no permission. If a second monitor is connected it offers **Set up monitors** once. That click is the only thing that can trigger the browser's "Manage windows on all your displays" prompt.
  - Once permission is granted, later visits load the monitor layout silently. Plugging a monitor in or out updates it live: windows are re-placed, and a panel whose monitor disappeared falls back to this screen.
  - The ⧉ header button shows how many monitors were found. **Settings → Detached displays** draws them to scale; click one to target it.
  - With more than one monitor, each widget's ⧉ button asks which monitor to open on.
  - Firefox and Safari cannot see other monitors: open the panel and drag it across. Wayland and most tiling window managers ignore window placement, and the UI says so when that happens.

## Keyboard shortcuts

| Keys | Action |
|------|--------|
| Ctrl/⌘ + K | Command palette: go to a symbol, add a widget, switch tab, open any dialog, change level, search the glossary |
| `?` | Keyboard shortcuts |
| `/` | Search or add a symbol |
| `1` … `9` | Switch to tab 1–9 |
| `N` | Add a widget |
| `A` / `T` / `,` | Alerts / Transactions / Settings |
| `L` / `G` | Lessons / Glossary |
| `I` | Details for the selected symbol |
| `P` | Blur or show amounts (privacy) |
| `R` / `Shift+P` | Refresh now / pause or resume auto-refresh |
| `Esc` | Close the open dialog, drawer or menu |
| `+` `-`, `Left` `Right`, `Home` `End` | In a focused chart: zoom, pan, jump |

Single-key shortcuts are ignored while you are typing in a field or a dialog is open. Tabs, widgets, the tour and every dialog can be used with the keyboard alone.

## Data providers

Stocks has no server, so every price comes straight from a provider to your browser, using **your own free, read-only keys**. Without a key it runs in **Demo mode** on bundled synthetic data, which is labelled DEMO everywhere and never presented as market prices.

| Provider | Quotes | Charts (candles) | Fundamentals | News | Events | Free tier (as published) | Data quality |
|----------|:-:|:-:|:-:|:-:|:-:|---|---|
| [Finnhub](https://finnhub.io/register) | ✓ | — | ✓ | ✓ | ✓ | 60 calls/min | Near real-time US quotes; no candles on the free plan, so charts route elsewhere |
| [Twelve Data](https://twelvedata.com/pricing) | ✓ | ✓ | ✓ | — | — | 8 credits/min, 800/day | Real-time for US equities where licensed, otherwise delayed; FX and crypto |
| [Polygon](https://polygon.io/) | ✓ | ✓ | ✓ | ✓ | ✓ | 5 calls/min | Delayed and end-of-day on the free plan |
| [Alpaca](https://alpaca.markets/) | ✓ | ✓ | — | ✓ | — | 200 calls/min | IEX exchange only (about 2% of US volume) |
| [Alpha Vantage](https://www.alphavantage.co/support/#api-key) | ✓ | ✓ | ✓ | ✓ | ✓ | 25 calls/day | Mostly end-of-day |
| [CoinGecko](https://www.coingecko.com/en/api) | ✓ | ✓ | ✓ | — | — | ~10 calls/min, keyless | Crypto only, 1–2 minute refresh, 365 days of history |
| Demo | ✓ | ✓ | ✓ | ✓ | ✓ | none (no network) | Synthetic, for trying the tool |

Vendors change their free tiers; the figures above are what the pacer enforces, and Settings → Data & providers shows this browser's use against them live.

- **Universal or auto-route.** Universal mode sends every symbol to one provider. Auto-route sends equities to your stock provider, crypto to CoinGecko and FX to Twelve Data. Either way, symbols are batched so each provider gets one call per refresh.
- **Pacing.** A per-provider pacer queues requests under each published limit. A visible chart goes first, then alert data, the screener and sparklines. Scans show their estimated cost before they start.
- **Honesty.** Every number shows its source and time. Charts show chips when data is demo, partial, stale or IEX-only. A live provider's gap is never filled with demo data. A symbol a provider does not cover reads "Not covered" rather than a dash. Market sessions come from a local exchange calendar, and a disagreement with the provider is shown, not hidden.
- **Symbols.** Use `BTC` or `BTC-USD` for crypto, `EURUSD` for currencies and `WALMEX.MX` for Mexican listings. A bare coin ticker that a company also uses (LINK, DASH) is the stock; write `LINK-USD` for the coin.

> ⚠️ Alpaca keys grant account access, and its data API may be blocked by browser CORS. Use a paper or read-only key.

## Privacy

- **Everything stays in this browser** (localStorage): watchlist, transactions, alert rules, layout, drawings, notes, learning progress and API keys. Keys are sent only to the provider they belong to. There is no account, no server and no analytics.
- **Export / Import** in Settings writes or reads one JSON file. Keys are never exported.
- **Privacy blur** (the eye button or `P`) hides amounts, including in detached panels.
- **Shared links** such as `#AAPL,MSFT,NVDA` open a read-only view. Nothing from the link is saved unless you choose "Save to my browser", and your own watchlist is left untouched.
- **Clear all data** in Settings erases everything Stocks stored in this browser.

## Languages

The interface is available in English, Spanish, Brazilian Portuguese, Japanese and Russian, following the fleet language switch. The glossary and lessons are fully written in English, Spanish and Brazilian Portuguese, with local examples (BMV, FIBRAS and PEPS for Mexico; B3, JCP and the average-cost rule for Brazil). Japanese and Russian show them in English.

## Running it

It is a static site: serve the folder with any web server (for example `python3 -m http.server`) or use GitHub Pages. There is no build step, no npm runtime dependency and no CDN; fonts are self-hosted.

## Tests

The tests use Node's built-in test runner and need no install:

```sh
node --test tests/*.test.mjs        # all suites (Node 22: pass the glob, not the folder)
node tests/i18n-coverage.mjs        # translation report: UI strings missing per locale
node tests/i18n-coverage.mjs --verbose
```

| Suite | Covers |
|-------|--------|
| `providers.test.mjs` | provider facade, candle routing, pacing, demo flagging |
| `indicators.test.mjs` | every indicator against published examples and on empty, flat, gappy and no-volume input |
| `portfolio.test.mjs` | FIFO/average cost, splits, dividends, FX, XIRR, TWR, risk metrics, allocation, drift |
| `csvimport.test.mjs` | CSV parsing, number and date locales, every broker preset (fixtures in `tests/fixtures/`) |
| `folio.test.mjs` | the shared portfolio valuation, FX legs and CSV escaping |
| `alerts.test.mjs` | all alert types, once/re-arm, expiry, cross detection |
| `store.test.mjs` | storage schema, migration, import/export, validation |
| `scan.test.mjs` | screener metrics, presets and the treemap layout |
| `i18n.test.mjs` | every UI string has an es, pt-BR, ja and ru translation, with its `{placeholders}` kept (keys are found statically by `i18n-coverage.mjs`: `i18nT()` calls, label tables, tuple lists, `data-i18n` markup) |

`tests/smoke.mjs` is the end-to-end run in headless Chromium, in Demo mode: onboarding at every level, a symbol added, the drawer chart through every range and type with RSI and MACD, a drawing kept across a reload, every widget kind added and popped out, price/technical/portfolio alerts (one must actually fire), buy/sell/dividend transactions and their realized P/L, a broker CSV import, the four translations, and no sideways scroll at 390px. Any console error fails it. It serves the repo itself; Playwright is the only thing it needs, imported from a local path at the top of the file (change it to yours):

```sh
node tests/smoke.mjs                   # exit 1 on any failed check or console error
SHOTS=/tmp/shots node tests/smoke.mjs  # also keep screenshots
```

`tests/chart-harness.html` and `tests/learn-harness.html` are browser harnesses for the chart engine and the education layer. Open them through the local server.

## Architecture

Plain ES modules with no dependencies. The UI is a workspace of tabs holding **widgets**. Each widget is built once, then patched on every tick from a single `ctx` snapshot the controller hands it. Widgets never fetch data and never write storage, which is why the same widget can run in a detached window.

```
index.html, popout.html     app shell and the detached-panel page
i18n.js                     UI dictionary (English text is the key) for es, pt-BR, ja, ru
css/                        stocks.css (chrome), workspace.css (widgets), chart.css, learn.css
js/app.js                   controller: header, rail, drawer, dialogs, settings, level, tour
js/workspace.js             tabs, tiling grid, linking, per-level layout templates, widget picker
js/widgets.js               widget registry + cards, quote, tape, alerts, session, chart
js/widget-table.js          the dense quote table
js/widgets-market.js        screener, heatmap, movers, compare, news, calendar, fundamentals
js/widgets-portfolio.js     portfolio, allocation, performance, income, calculator
js/widgets-learn.js         learn (tips + lessons), glossary, notes
js/chart.js                 canvas chart engine (types, panes, drawings, levels, touch, keyboard)
js/chartpanel.js            chart toolbar shared by the chart widget and the details drawer
js/indicators.js            pure indicator maths
js/alerttypes.js            alert condition registry (pure)
js/engine.js                scheduler and alert evaluation
js/alerts-ui.js             alert rules dialog
js/portfolio.js             pure portfolio maths (lots, returns, risk, allocation, income)
js/folio.js                 one shared valuation of the ledger
js/csvimport.js             CSV parsing and broker presets
js/ledger-ui.js             transactions dialog and CSV import flow
js/scan.js                  screener metrics and presets
js/learn.js                 glossary, lessons, help icons, tour, experience levels
js/palette.js               command palette, shortcuts, cheat sheet
js/store.js                 localStorage schema, migration, import/export
js/session.js               exchange calendars and sessions
js/peers.js, displays.js    cross-window leadership and detached panels
js/popout.js                detached-panel controller
js/format.js, viz.js        number formatting, sparklines
js/providers/               provider adapters, candle cache, pacer, demo generator
data/                       demo data, glossary and lessons (en, es, pt-BR), bundled screener lists
tests/                      node:test suites, fixtures, browser harnesses
```

## License

GNU AGPL-3.0. See [LICENSE](LICENSE). Part of the Carino Systems fleet.
