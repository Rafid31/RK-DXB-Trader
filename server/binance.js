// ── Crypto Candles — Multi-source with fallback ──────────────
// Primary: Binance Global API (api.binance.com)
// Fallback 1: Binance US (api.binance.us)
// Fallback 2: Bybit (api.bybit.com) - no geo-restrictions
// Fallback 3: Kraken (api.kraken.com)

const fetch = require('node-fetch');

const SYMBOL_MAP = {
  'BTC/USD': {
    binance:   'BTCUSDT',
    binanceUs: 'BTCUSDT',
    bybit:     'BTCUSDT',
    kraken:    'XBTUSD'
  },
  'ETH/USD': {
    binance:   'ETHUSDT',
    binanceUs: 'ETHUSDT',
    bybit:     'ETHUSDT',
    kraken:    'ETHUSD'
  }
};

// Bybit kline fetch (most globally accessible, no geo-block)
async function fetchBybit(symbol, limit = 90) {
  const sym = SYMBOL_MAP[symbol]?.bybit;
  if (!sym) return null;
  const url = `https://api.bybit.com/v5/market/kline?category=spot&symbol=${sym}&interval=1&limit=${limit}`;
  try {
    const res = await fetch(url, { timeout: 10000 });
    const data = await res.json();
    if (data.retCode !== 0 || !data.result?.list?.length) {
      console.warn(`[${symbol}] Bybit error: ${data.retMsg}`);
      return null;
    }
    // Bybit returns newest first: [startTime, open, high, low, close, volume, turnover]
    return data.result.list.reverse().map(k => ({
      time:   new Date(parseInt(k[0])).toISOString(),
      open:   parseFloat(k[1]),
      high:   parseFloat(k[2]),
      low:    parseFloat(k[3]),
      close:  parseFloat(k[4]),
      volume: parseFloat(k[5])
    }));
  } catch (err) {
    console.error(`[${symbol}] Bybit failed: ${err.message}`);
    return null;
  }
}

// Binance Global (may be blocked in US)
async function fetchBinanceGlobal(symbol, limit = 90) {
  const sym = SYMBOL_MAP[symbol]?.binance;
  if (!sym) return null;
  const url = `https://api.binance.com/api/v3/klines?symbol=${sym}&interval=1m&limit=${limit}`;
  try {
    const res = await fetch(url, { timeout: 10000 });
    if (!res.ok) { console.warn(`[${symbol}] Binance.com HTTP ${res.status}`); return null; }
    const data = await res.json();
    if (!Array.isArray(data)) return null;
    return data.map(k => ({
      time:   new Date(k[0]).toISOString(),
      open:   parseFloat(k[1]), high:   parseFloat(k[2]),
      low:    parseFloat(k[3]), close:  parseFloat(k[4]),
      volume: parseFloat(k[5])
    }));
  } catch (err) {
    console.error(`[${symbol}] Binance.com failed: ${err.message}`);
    return null;
  }
}

// Binance US (separate domain, different geo rules)
async function fetchBinanceUS(symbol, limit = 90) {
  const sym = SYMBOL_MAP[symbol]?.binanceUs;
  if (!sym) return null;
  const url = `https://api.binance.us/api/v3/klines?symbol=${sym}&interval=1m&limit=${limit}`;
  try {
    const res = await fetch(url, { timeout: 10000 });
    if (!res.ok) { console.warn(`[${symbol}] Binance.us HTTP ${res.status}`); return null; }
    const data = await res.json();
    if (!Array.isArray(data)) return null;
    return data.map(k => ({
      time:   new Date(k[0]).toISOString(),
      open:   parseFloat(k[1]), high:   parseFloat(k[2]),
      low:    parseFloat(k[3]), close:  parseFloat(k[4]),
      volume: parseFloat(k[5])
    }));
  } catch (err) {
    console.error(`[${symbol}] Binance.us failed: ${err.message}`);
    return null;
  }
}

// Main function — tries all sources in order
async function fetchCryptoCandles(symbol, limit = 90) {
  // Try Bybit first (most globally accessible)
  let candles = await fetchBybit(symbol, limit);
  if (candles && candles.length > 20) {
    console.log(`[${symbol}] ✅ Bybit`);
    return candles;
  }

  // Try Binance Global
  candles = await fetchBinanceGlobal(symbol, limit);
  if (candles && candles.length > 20) {
    console.log(`[${symbol}] ✅ Binance.com`);
    return candles;
  }

  // Try Binance US
  candles = await fetchBinanceUS(symbol, limit);
  if (candles && candles.length > 20) {
    console.log(`[${symbol}] ✅ Binance.us`);
    return candles;
  }

  console.error(`[${symbol}] ❌ All crypto sources failed`);
  return null;
}

module.exports = { fetchCryptoCandles };
