// ── Binance Free API — Crypto Candles ────────────────────────
// No API key needed. Rate limit: 1200 requests/min (very generous)
// Endpoint: /api/v3/klines (1m candles)

const fetch = require('node-fetch');

const BINANCE_BASE = 'https://api.binance.com';

// Binance symbol map: our display name -> Binance symbol
const CRYPTO_SYMBOLS = {
  'BTC/USD': 'BTCUSDT',
  'ETH/USD': 'ETHUSDT'
};

async function fetchCryptoCandles(symbol, limit = 90) {
  const binanceSymbol = CRYPTO_SYMBOLS[symbol];
  if (!binanceSymbol) return null;

  const url = `${BINANCE_BASE}/api/v3/klines?symbol=${binanceSymbol}&interval=1m&limit=${limit}`;

  try {
    const res = await fetch(url, { timeout: 10000 });
    if (!res.ok) {
      console.warn(`[${symbol}] Binance HTTP ${res.status}`);
      return null;
    }
    const data = await res.json();
    if (!Array.isArray(data) || data.length === 0) return null;

    // Binance kline format:
    // [openTime, open, high, low, close, volume, closeTime, ...]
    return data.map(k => ({
      time: new Date(k[0]).toISOString(),
      open:   parseFloat(k[1]),
      high:   parseFloat(k[2]),
      low:    parseFloat(k[3]),
      close:  parseFloat(k[4]),
      volume: parseFloat(k[5])
    }));
  } catch (err) {
    console.error(`[${symbol}] Binance fetch failed: ${err.message}`);
    return null;
  }
}

// Check if crypto market is in high-volume hours
// Crypto is 24/7 but best accuracy: 08:00–23:00 UTC
function isCryptoActiveHours() {
  const h = new Date().getUTCHours();
  return h >= 8 && h < 23;
}

module.exports = { fetchCryptoCandles, isCryptoActiveHours, CRYPTO_SYMBOLS };
