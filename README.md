# Stocks

Client-side markets watchlist, portfolio and alerts — part of [Carino Systems](https://carino.systems). Live at **stocks.carino.systems**.

Your keys, your device. **Monitoring and visualization only — it does not place trades, connect to brokerages, move money, or give advice.**

## What it does

- **Watchlist** of quote cards — last price, day change chip, day range bar, and a dependency-free SVG sparkline. Add/remove/reorder tickers; seed a read-only view from the URL hash (`#AAPL,MSFT,NVDA`).
- **Local alerts** — per-ticker price / percent-change thresholds that fire in-page and (optionally) via the browser Notification API. Edge-triggered with a cooldown; alerts only fire while a tab is open.
- **Optional portfolio view** — manual holdings (shares × cost basis), live valuation, day and total P/L, and position weights. No brokerage link, no order entry.
- **Detail drawer** — per-symbol key stats and a themed line chart with 1D / 1M / 1Y ranges.
- **Market strip** — SPY / QQQ / DIA index proxies and market status.
- **Privacy blur**, JSON **export/import**, and a keyless **Demo mode**.

## Setup

Static site — just serve the folder (or open on GitHub Pages). No build step.

Bring your own free, read-only API keys in **Settings** (stored only in your browser, sent only to the provider):

| Provider | Powers | Free tier |
|----------|--------|-----------|
| [Finnhub](https://finnhub.io/register) | real-time-ish US quotes, profiles, search, market status | ~60 req/min |
| [Twelve Data](https://twelvedata.com/pricing) | sparklines + detail charts, batched fallback quotes | ~800 req/day |

With no key it runs in **Demo mode** on bundled sample data. Provider selection is automatic by which keys exist; the refresh loop is visibility-aware (pauses on hidden tabs) and backs off on rate limits.

## Architecture

Plain ES modules, no dependencies, no CDN. The whole app talks to one **provider adapter** interface (`js/providers/`) returning a single normalized quote/series shape, so new providers, streaming, or more chart types are additive modules — never a rewrite.

```
index.html · css/stocks.css
js/app.js            controller + view
js/store.js          state + localStorage + export/import
js/providers/        base contract, finnhub, twelvedata, demo, facade
js/viz.js            SVG sparkline + canvas line chart
js/engine.js         scheduler, alert evaluation, portfolio math
data/demo.json       keyless demo dataset
```

## Safety

Not investment advice. Quotes may be delayed. Data (watchlist, holdings, rules, keys) stays in your browser. Use only your own free, read-only, non-trading API keys.

## License

See [LICENSE](LICENSE). Part of the Carino Systems fleet.
