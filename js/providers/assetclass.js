/* providers/assetclass.js — best-effort symbol classification so the facade can
   auto-route each ticker to a provider that actually covers its asset class.
   Symbols are already normalized to [A-Z0-9.-] (store.normalizeSymbol), so pairs
   arrive compact: BTC, BTCUSD, EURUSD. This is a heuristic, not authoritative —
   the global provider selector is the escape hatch when a guess is wrong. */

// Fiat suffixes a compacted crypto/fx pair can end with (longest matched first).
const FIAT = ['USDT', 'USDC', 'USD', 'EUR', 'GBP', 'JPY', 'AUD', 'CAD', 'CHF', 'CNY', 'KRW', 'INR', 'BRL', 'MXN', 'SGD', 'HKD', 'NZD', 'ZAR', 'TRY'];

// ISO-4217 currency codes, for detecting 6-letter FX pairs like EURUSD.
const ISO4217 = new Set(['USD', 'EUR', 'JPY', 'GBP', 'AUD', 'CAD', 'CHF', 'CNY', 'HKD', 'NZD', 'SEK', 'KRW', 'SGD', 'NOK', 'MXN', 'INR', 'RUB', 'ZAR', 'TRY', 'BRL', 'TWD', 'DKK', 'PLN', 'THB', 'IDR', 'HUF', 'CZK', 'ILS', 'CLP', 'PHP', 'AED', 'COP', 'SAR', 'MYR', 'RON']);

// Common crypto base tickers. Watchlist crypto symbols come from CoinGecko search
// (stored as the bare base, e.g. SOL), so a decent base set keeps routing correct.
const CRYPTO = new Set(['BTC', 'ETH', 'USDT', 'USDC', 'BNB', 'XRP', 'SOL', 'ADA', 'DOGE', 'TRX', 'TON', 'DOT', 'MATIC', 'LTC', 'SHIB', 'DAI', 'AVAX', 'LINK', 'BCH', 'XLM', 'UNI', 'ATOM', 'XMR', 'ETC', 'FIL', 'APT', 'ARB', 'OP', 'NEAR', 'ICP', 'HBAR', 'VET', 'ALGO', 'AAVE', 'GRT', 'SAND', 'MANA', 'AXS', 'EGLD', 'THETA', 'FTM', 'XTZ', 'FLOW', 'CHZ', 'ZEC', 'DASH', 'ENJ', 'BAT', 'CRV', 'MKR', 'COMP', 'SNX', 'SUSHI', 'YFI', 'RUNE', 'KSM', 'CAKE', 'LDO', 'PEPE', 'WIF', 'BONK', 'SUI', 'SEI', 'INJ', 'TIA', 'RNDR', 'IMX', 'STX']);

// 'BTCUSD' -> ['BTC','USD'];  'BTC' -> ['BTC', null]
export function splitFiat(sym) {
  for (const f of FIAT) { if (sym.length > f.length && sym.endsWith(f)) return [sym.slice(0, -f.length), f]; }
  return [sym, null];
}

export function isFx(sym) {
  return /^[A-Z]{6}$/.test(sym) && ISO4217.has(sym.slice(0, 3)) && ISO4217.has(sym.slice(3));
}

export function isCrypto(sym) {
  if (CRYPTO.has(sym)) return true;
  const [base, fiat] = splitFiat(sym);
  if (fiat && CRYPTO.has(base)) return true;
  return /USDT$|USDC$/.test(sym);
}

// Crypto is checked before FX so BTCUSD (crypto) isn't mistaken for an FX pair.
export function classify(sym) {
  if (isCrypto(sym)) return 'crypto';
  if (isFx(sym)) return 'fx';
  return 'equity';
}

export function cryptoBase(sym) { return splitFiat(sym)[0]; }
export function fxPair(sym) { return sym.length === 6 ? [sym.slice(0, 3), sym.slice(3)] : [sym, 'USD']; }
