/* providers/assetclass.js — best-effort symbol classification so the facade can
   auto-route each ticker to a provider that actually covers its asset class.
   Symbols are already normalized to [A-Z0-9.-] (store.normalizeSymbol), so pairs
   arrive compact (BTC, BTCUSD, EURUSD) or dashed (LINK-USD, EUR-USD). This is a
   heuristic, not authoritative — explicit forms and setClassOverrides() are the
   escape hatches when a guess is wrong.

   THE COLLISION RULE. Coin tickers and stock tickers share one namespace: LINK
   is Chainlink and Interlink Electronics, DASH is a coin and DoorDash, COMP is
   Compound and Compass. The old rule (any bare ticker in a ~70-coin list is
   crypto) sent DoorDash to CoinGecko. Now:
     1. A per-symbol override (setClassOverrides) wins outright.
     2. An explicit pair is crypto: LINK-USD, LINK-USDT, LINKUSDT, BTCUSD, ETH-EUR.
     3. A BARE ticker is crypto only if it is in TOP_COINS — the large coins
        people actually hold — and NOT in EQUITY_FIRST, the tickers where a
        listed company of real size owns the symbol. Everything else bare is an
        equity.
   So DASH is DoorDash and Dash-the-coin is DASH-USD; SOL and LTC stay coins
   (Emeren and LTC Properties are small, and existing watchlists store CoinGecko
   picks as bare bases). The CoinGecko search hit is turned into the dashed
   form by the caller when it collides (see isAmbiguousBare). */

// Fiat suffixes a compacted crypto/fx pair can end with (longest matched first).
const FIAT = ['USDT', 'USDC', 'USD', 'EUR', 'GBP', 'JPY', 'AUD', 'CAD', 'CHF', 'CNY', 'KRW', 'INR', 'BRL', 'MXN', 'SGD', 'HKD', 'NZD', 'ZAR', 'TRY'];

// ISO-4217 currency codes, for detecting 6-letter FX pairs like EURUSD.
const ISO4217 = new Set(['USD', 'EUR', 'JPY', 'GBP', 'AUD', 'CAD', 'CHF', 'CNY', 'HKD', 'NZD', 'SEK', 'KRW', 'SGD', 'NOK', 'MXN', 'INR', 'RUB', 'ZAR', 'TRY', 'BRL', 'TWD', 'DKK', 'PLN', 'THB', 'IDR', 'HUF', 'CZK', 'ILS', 'CLP', 'PHP', 'AED', 'COP', 'SAR', 'MYR', 'RON']);

// Every coin the router knows by ticker — used for explicit pairs (LINKUSD).
const CRYPTO = new Set(['BTC', 'ETH', 'USDT', 'USDC', 'BNB', 'XRP', 'SOL', 'ADA', 'DOGE', 'TRX', 'TON', 'DOT', 'MATIC', 'POL', 'LTC', 'SHIB', 'DAI', 'AVAX', 'LINK', 'BCH', 'XLM', 'UNI', 'ATOM', 'XMR', 'ETC', 'FIL', 'APT', 'ARB', 'OP', 'NEAR', 'ICP', 'HBAR', 'VET', 'ALGO', 'AAVE', 'GRT', 'SAND', 'MANA', 'AXS', 'EGLD', 'THETA', 'FTM', 'XTZ', 'FLOW', 'CHZ', 'ZEC', 'DASH', 'ENJ', 'BAT', 'CRV', 'MKR', 'COMP', 'SNX', 'SUSHI', 'YFI', 'RUNE', 'KSM', 'CAKE', 'LDO', 'PEPE', 'WIF', 'BONK', 'SUI', 'SEI', 'INJ', 'TIA', 'RNDR', 'RENDER', 'IMX', 'STX', 'HYPE', 'ENA', 'ONDO', 'JUP', 'PYTH', 'WLD', 'TAO', 'KAS', 'FET']);

// Bare tickers that mean a coin. Short on purpose.
export const TOP_COINS = new Set(['BTC', 'ETH', 'USDT', 'USDC', 'BNB', 'XRP', 'SOL', 'ADA', 'DOGE', 'TRX', 'TON', 'DOT', 'MATIC', 'POL', 'LTC', 'SHIB', 'DAI', 'AVAX', 'BCH', 'XLM', 'UNI', 'XMR', 'ETC', 'FIL', 'ARB', 'NEAR', 'ICP', 'HBAR', 'ALGO', 'AAVE', 'PEPE', 'WIF', 'BONK', 'SUI', 'SEI', 'INJ', 'TIA', 'RNDR', 'HYPE', 'ENA', 'ONDO', 'KAS']);

// Coin tickers owned on a stock exchange by a company users are likely to mean.
// These are equities when bare; the coin is reached as LINK-USD / LINKUSD.
export const EQUITY_FIRST = new Set(['LINK', 'DASH', 'COMP', 'CAKE', 'SAND', 'AXS', 'SNX', 'STX', 'APT', 'ATOM', 'FLOW', 'OP', 'IMX', 'GRT', 'MANA', 'BAT', 'CRV', 'FET', 'TAO', 'JUP', 'ENJ', 'VET', 'RUNE', 'KSM', 'LDO', 'MKR', 'YFI', 'CHZ', 'ZEC', 'XTZ', 'FTM', 'EGLD', 'THETA', 'SUSHI', 'WLD', 'PYTH', 'RENDER']);

let OVERRIDES = new Map();
// { SYMBOL: 'equity'|'crypto'|'fx' } — the app passes the user's per-symbol
// corrections here. Replaces the whole map.
export function setClassOverrides(map) {
  OVERRIDES = new Map();
  if (map && typeof map === 'object') for (const k of Object.keys(map)) if (['equity', 'crypto', 'fx'].includes(map[k])) OVERRIDES.set(String(k).toUpperCase(), map[k]);
}

// 'BTCUSD' -> ['BTC','USD'];  'LINK-USD' -> ['LINK','USD'];  'BTC' -> ['BTC', null]
export function splitFiat(sym) {
  const dash = /^([A-Z0-9]+)-([A-Z]{3,4})$/.exec(sym);
  if (dash && FIAT.includes(dash[2])) return [dash[1], dash[2]];
  for (const f of FIAT) { if (sym.length > f.length && sym.endsWith(f)) return [sym.slice(0, -f.length), f]; }
  return [sym, null];
}

export function isFx(sym) {
  if (/^[A-Z]{3}-[A-Z]{3}$/.test(sym)) return ISO4217.has(sym.slice(0, 3)) && ISO4217.has(sym.slice(4));
  return /^[A-Z]{6}$/.test(sym) && ISO4217.has(sym.slice(0, 3)) && ISO4217.has(sym.slice(3));
}

export function isCrypto(sym) {
  const [base, fiat] = splitFiat(sym);
  if (fiat) {
    // A pair: crypto when the base is a known coin, or when the quote leg is a
    // stablecoin (nothing but crypto quotes in USDT). An unknown base dashed
    // against a fiat (FOO-USD) is still read as crypto — that is the explicit form.
    if (CRYPTO.has(base) || fiat === 'USDT' || fiat === 'USDC') return true;
    if (sym.includes('-') && !ISO4217.has(base)) return true;
    return false;
  }
  return TOP_COINS.has(sym) && !EQUITY_FIRST.has(sym);
}

// Override, then crypto (so BTCUSD is not mistaken for an FX pair), then FX.
export function classify(sym) {
  sym = String(sym || '').toUpperCase();
  const o = OVERRIDES.get(sym);
  if (o) return o;
  if (isCrypto(sym)) return 'crypto';
  if (isFx(sym)) return 'fx';
  return 'equity';
}

// True when a bare ticker is also a coin the router will NOT treat as one —
// search can then offer the dashed form ('LINK-USD') for the coin.
export function isAmbiguousBare(sym) { return CRYPTO.has(sym) && EQUITY_FIRST.has(sym); }

export function cryptoBase(sym) { return splitFiat(sym)[0]; }
// The currency a crypto symbol is quoted in: BTCEUR -> EUR. Stablecoin legs are
// priced in dollars by every source here, so USDT/USDC report USD.
export function cryptoQuote(sym) {
  const f = splitFiat(sym)[1];
  return !f || f === 'USDT' || f === 'USDC' ? 'USD' : f;
}
export function fxPair(sym) {
  if (/^[A-Z]{3}-[A-Z]{3}$/.test(sym)) return [sym.slice(0, 3), sym.slice(4)];
  return sym.length === 6 ? [sym.slice(0, 3), sym.slice(3)] : [sym, 'USD'];
}
