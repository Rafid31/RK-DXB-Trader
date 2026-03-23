// ================================================================
// RK DXB Trader — Pocket Option OTC Engine
// Fetches ALL 12 OTC pairs via PO's public SVG API
// Builds 1-min OHLC candles, runs full signal engine
// No auth needed — po-static.com is public
// ================================================================

const fetch = require('node-fetch');
const { calculateSignal } = require('./signalEngine');

// All 12 OTC pairs confirmed working
const OTC_PAIRS = [
  'EURUSD_otc', 'GBPUSD_otc', 'USDJPY_otc', 'AUDUSD_otc',
  'USDCAD_otc', 'EURGBP_otc', 'GBPJPY_otc', 'EURJPY_otc',
  'USDCHF_otc', 'NZDUSD_otc', 'BTCUSD_otc', 'ETHUSD_otc'
];

// Display names
const DISPLAY_NAMES = {
  'EURUSD_otc': 'EUR/USD OTC', 'GBPUSD_otc': 'GBP/USD OTC',
  'USDJPY_otc': 'USD/JPY OTC', 'AUDUSD_otc': 'AUD/USD OTC',
  'USDCAD_otc': 'USD/CAD OTC', 'EURGBP_otc': 'EUR/GBP OTC',
  'GBPJPY_otc': 'GBP/JPY OTC', 'EURJPY_otc': 'EUR/JPY OTC',
  'USDCHF_otc': 'USD/CHF OTC', 'NZDUSD_otc': 'NZD/USD OTC',
  'BTCUSD_otc': 'BTC/USD OTC', 'ETHUSD_otc': 'ETH/USD OTC'
};

// State
const tickHistory = {};    // symbol -> last 300 ticks (normalized 0-1 price)
const candleStore = {};    // symbol -> last 100 OHLC candles
const lastSignals = {};    // symbol -> signal result
const currentCandle = {};  // symbol -> building candle

OTC_PAIRS.forEach(sym => {
  tickHistory[sym] = [];
  candleStore[sym] = [];
  lastSignals[sym] = { signal: 'WAIT', confidence: 0 };
  currentCandle[sym] = null;
});

// Parse SVG polyline → extract price points (normalized 0-1)
function parseSVG(svgText) {
  const match = svgText.match(/points="([^"]+)"/);
  if (!match) return [];
  const pts = match[1].trim().split(' ').map(p => {
    const parts = p.split(',');
    return { x: parseFloat(parts[0]), y: parseFloat(parts[1]) };
  }).filter(p => !isNaN(p.x) && !isNaN(p.y) && p.y !== 55 && p.y !== 0);
  
  if (pts.length === 0) return [];
  
  // Find actual price range in this SVG
  const ys = pts.map(p => p.y);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const range = maxY - minY;
  
  if (range === 0) return pts.map(p => ({ x: p.x, price: 0.5 }));
  
  // Normalize: lower Y = higher price
  return pts.map(p => ({
    x: p.x,
    price: parseFloat(((maxY - p.y) / range).toFixed(4))
  }));
}

// Fetch one OTC pair
async function fetchOTCTick(symbol) {
  const ts = Date.now() / 1000;
  const url = `https://po-static.com/uploads/img_favourites_symbols/${symbol}.svg?v=${ts}`;
  
  try {
    const res = await fetch(url, { timeout: 5000 });
    if (!res.ok) return null;
    const text = await res.text();
    const pts = parseSVG(text);
    if (pts.length < 5) return null;
    return pts;
  } catch (e) {
    return null;
  }
}

// Build/update 1-minute candle from ticks
function updateCandle(symbol, normalizedPrice, timestamp) {
  const ticks = tickHistory[symbol];
  
  // Keep last 300 ticks (5 min)
  ticks.push({ price: normalizedPrice, ts: timestamp });
  if (ticks.length > 300) ticks.shift();
  
  // Build 1-minute candle
  const now = new Date(timestamp);
  const candleMinute = Math.floor(timestamp / 60000) * 60000;
  
  if (!currentCandle[symbol] || currentCandle[symbol].minute !== candleMinute) {
    // Close previous candle
    if (currentCandle[symbol] && currentCandle[symbol].tickCount > 0) {
      const closed = {
        time: new Date(currentCandle[symbol].minute).toISOString(),
        open: currentCandle[symbol].open,
        high: currentCandle[symbol].high,
        low: currentCandle[symbol].low,
        close: currentCandle[symbol].close,
        volume: currentCandle[symbol].tickCount,
        minute: currentCandle[symbol].minute
      };
      candleStore[symbol].push(closed);
      if (candleStore[symbol].length > 100) candleStore[symbol].shift();
    }
    
    // Start new candle
    currentCandle[symbol] = {
      minute: candleMinute,
      open: normalizedPrice,
      high: normalizedPrice,
      low: normalizedPrice,
      close: normalizedPrice,
      tickCount: 1
    };
  } else {
    // Update current candle
    const c = currentCandle[symbol];
    if (normalizedPrice > c.high) c.high = normalizedPrice;
    if (normalizedPrice < c.low) c.low = normalizedPrice;
    c.close = normalizedPrice;
    c.tickCount++;
  }
}

// Calculate signal from candles
function calcOTCSignal(symbol) {
  const candles = [...candleStore[symbol]];
  
  // Add current forming candle
  if (currentCandle[symbol] && currentCandle[symbol].tickCount > 0) {
    const c = currentCandle[symbol];
    candles.push({ open: c.open, high: c.high, low: c.low, close: c.close, volume: c.tickCount });
  }
  
  if (candles.length < 10) {
    return { signal: 'WAIT', confidence: 0, reason: 'Building data...' };
  }
  
  return calculateSignal(candles);
}

// Main update loop — fetch all OTC pairs every second
let lastPrices = {};
let updateCount = 0;

async function updateOTCPair(symbol) {
  const pts = await fetchOTCTick(symbol);
  if (!pts || pts.length === 0) return;
  
  // Current price = last point in SVG (most recent tick)
  const currentPt = pts[pts.length - 1];
  const currentPrice = currentPt.price;
  const prevPrice = lastPrices[symbol];
  
  lastPrices[symbol] = currentPrice;
  
  // Update candle with this tick
  updateCandle(symbol, currentPrice, Date.now());
  
  // Recalculate signal every 5 ticks
  if (updateCount % 5 === 0) {
    const result = calcOTCSignal(symbol);
    lastSignals[symbol] = { ...result, updatedAt: new Date().toISOString() };
  }
}

async function updateAllOTC() {
  // Fetch all 12 pairs in parallel (no rate limit on po-static.com)
  await Promise.all(OTC_PAIRS.map(sym => updateOTCPair(sym)));
  updateCount++;
}

// Get current state for broadcasting
function getOTCState() {
  return OTC_PAIRS.map(symbol => {
    const signal = lastSignals[symbol];
    const ticks = tickHistory[symbol];
    const lastTick = ticks[ticks.length - 1];
    const prevTick = ticks[ticks.length - 2];
    
    // Trend from last 10 ticks
    let trend = 'FLAT';
    if (ticks.length >= 10) {
      const recent = ticks.slice(-10).map(t => t.price);
      const avg = recent.reduce((s, p) => s + p, 0) / recent.length;
      trend = lastTick?.price > avg ? 'UP' : lastTick?.price < avg ? 'DOWN' : 'FLAT';
    }
    
    return {
      symbol,
      displayName: DISPLAY_NAMES[symbol],
      signal: signal.signal || 'WAIT',
      confidence: signal.confidence || 0,
      trend,
      currentPrice: lastTick?.price || null,
      candleCount: candleStore[symbol].length,
      rsi: signal.rsi,
      macd: signal.macd,
      emaTrend: signal.emaTrend,
      streak: signal.streak,
      pattern: signal.pattern,
      reasons: signal.reasons || [],
      updatedAt: signal.updatedAt || null,
      isOTC: true,
      isCrypto: symbol.includes('BTC') || symbol.includes('ETH')
    };
  });
}

module.exports = { updateAllOTC, getOTCState, OTC_PAIRS };
