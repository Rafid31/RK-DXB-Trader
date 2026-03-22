// ── Crypto Candles — Binance.US (confirmed working on Render) ──
// Binance.com = 451 geo-block on US IPs
// Bybit = HTML response (geo-block)
// Binance.US = ✅ confirmed working

const fetch = require('node-fetch');

const SYMBOL_MAP = {
  'BTC/USD': 'BTCUSDT',
  'ETH/USD': 'ETHUSDT'
};

async function fetchCryptoCandles(symbol, limit = 90) {
  const sym = SYMBOL_MAP[symbol];
  if (!sym) return null;

  const url = `https://api.binance.us/api/v3/klines?symbol=${sym}&interval=1m&limit=${limit}`;
  try {
    const res = await fetch(url, { timeout: 10000 });
    if (!res.ok) {
      console.warn(`[${symbol}] Binance.us HTTP ${res.status}`);
      return null;
    }
    const data = await res.json();
    if (!Array.isArray(data) || data.length === 0) return null;

    console.log(`[${symbol}] ✅ Binance.us (${data.length} candles)`);
    return data.map(k => ({
      time:   new Date(k[0]).toISOString(),
      open:   parseFloat(k[1]),
      high:   parseFloat(k[2]),
      low:    parseFloat(k[3]),
      close:  parseFloat(k[4]),
      volume: parseFloat(k[5])
    }));
  } catch (err) {
    console.error(`[${symbol}] Binance.us failed: ${err.message}`);
    return null;
  }
}

module.exports = { fetchCryptoCandles };
