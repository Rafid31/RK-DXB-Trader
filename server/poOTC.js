// ================================================================
// RK DXB Trader — Pocket Option OTC Engine
// Fetches ALL 12 OTC pairs via PO's public SVG API
// Builds 1-min OHLC candles, runs full signal engine
// No auth needed — po-static.com is public
// ================================================================

const fetch = require('node-fetch');
const { calculateOTCSignal } = require('./otcSignalEngine');

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

const lastSlopes = {};
OTC_PAIRS.forEach(sym => {
  tickHistory[sym] = [];
  candleStore[sym] = [];
  lastSignals[sym] = { signal: 'WAIT', confidence: 0 };
  lastSlopes[sym] = { slope: 0, slopeDir: 'FLAT', slopeStrong: false };
  currentCandle[sym] = null;
});

// Parse SVG polyline → extract price points (normalized 0-1)
function parseSVG(svgText) {
  const match = svgText.match(/points="([^"]+)"/);
  if (!match) return [];
  const rawPts = match[1].trim().split(' ').map(p => {
    const parts = p.split(',');
    return { x: parseFloat(parts[0]), y: parseFloat(parts[1]) };
  }).filter(p => !isNaN(p.x) && !isNaN(p.y) && p.y !== 55);
  
  if (rawPts.length === 0) return [];
  
  // Normalize Y to 0-100 using the frame's own min/max
  // This handles the SVG rescaling correctly
  const ys = rawPts.map(p => p.y);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const range = maxY - minY || 1;
  
  const pts = rawPts.map(p => ({
    x: p.x,
    price: parseFloat(((maxY - p.y) / range * 100).toFixed(4))
  }));
  
  return pts;
}

// Linear regression slope on last N price points
function calcSlope(pts, n = 10) {
  const last = pts.slice(-Math.min(n, pts.length));
  if (last.length < 3) return 0;
  const len = last.length;
  const sumX = last.reduce((s,p) => s+p.x, 0);
  const sumY = last.reduce((s,p) => s+p.price, 0);
  const sumXY = last.reduce((s,p) => s+p.x*p.price, 0);
  const sumX2 = last.reduce((s,p) => s+p.x*p.x, 0);
  const denom = len*sumX2 - sumX*sumX;
  if (denom === 0) return 0;
  return (len*sumXY - sumX*sumY) / denom;
}

// Fetch one OTC pair — returns full SVG point array
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

// Build a candle directly from SVG points
// SVG has ~60 points covering last ~60 seconds = 1 complete minute
// Split into halves: 1st half = previous candle context, 2nd half = current forming candle
function buildCandleFromSVG(pts) {
  const prices = pts.map(p => p.price);
  if (prices.length < 4) return null;
  
  // Use all points as one candle (this SVG = 1-min window)
  const open  = prices[0];
  const close = prices[prices.length - 1];
  const high  = Math.max(...prices);
  const low   = Math.min(...prices);
  
  return { open, high, low, close, volume: prices.length };
}

// Update candle store every fetch — push new SVG-derived candle
function updateCandle(symbol, pts, timestamp) {
  const ticks = tickHistory[symbol];
  
  // Track last price for display
  const currentPrice = pts[pts.length - 1].price;
  ticks.push({ price: currentPrice, ts: timestamp });
  if (ticks.length > 300) ticks.shift();
  
  // Each SVG fetch = snapshot of last 60s
  // We use minute-based bucketing to avoid duplicate candles
  const candleMinute = Math.floor(timestamp / 60000) * 60000;
  
  if (!currentCandle[symbol] || currentCandle[symbol].minute !== candleMinute) {
    // Close previous candle
    if (currentCandle[symbol] && currentCandle[symbol].tickCount > 0) {
      const c = currentCandle[symbol];
      candleStore[symbol].push({
        time: new Date(c.minute).toISOString(),
        open: c.open, high: c.high, low: c.low, close: c.close,
        volume: c.tickCount, minute: c.minute
      });
      if (candleStore[symbol].length > 100) candleStore[symbol].shift();
    }
    
    // Start new candle from SVG data
    const svgCandle = buildCandleFromSVG(pts);
    currentCandle[symbol] = {
      minute: candleMinute,
      open: svgCandle ? svgCandle.open : currentPrice,
      high: svgCandle ? svgCandle.high : currentPrice,
      low:  svgCandle ? svgCandle.low  : currentPrice,
      close: currentPrice,
      tickCount: 1
    };
  } else {
    // Update current candle with latest SVG data
    const svgCandle = buildCandleFromSVG(pts);
    const c = currentCandle[symbol];
    if (svgCandle) {
      if (svgCandle.high > c.high) c.high = svgCandle.high;
      if (svgCandle.low < c.low) c.low = svgCandle.low;
    }
    c.close = currentPrice;
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
  
  if (candles.length < 5) {
    return { signal: 'WAIT', confidence: 0, reason: 'Building data...' };
  }
  
  // Pass symbol for confirmation tracking
  return calculateOTCSignal(symbol, candles);
}

// Main update loop — fetch all OTC pairs every second
let lastPrices = {};
let updateCount = 0;

async function updateOTCPair(symbol) {
  const pts = await fetchOTCTick(symbol);
  if (!pts || pts.length === 0) return;
  
  const currentPrice = pts[pts.length - 1].price;
  lastPrices[symbol] = currentPrice;
  
  // Calculate slope from this SVG's points (most reliable indicator)
  const slope = calcSlope(pts, 10);
  const slopeStrong = Math.abs(slope) > 0.5;  // Strong directional move
  const slopeDir = slope > 0.5 ? 'UP' : slope < -0.5 ? 'DOWN' : 'FLAT';
  lastSlopes[symbol] = { slope: parseFloat(slope.toFixed(3)), slopeDir, slopeStrong };
  
  // Update candle using full SVG point array
  updateCandle(symbol, pts, Date.now());
  
  // Recalculate signal every 2 ticks
  if (updateCount % 2 === 0) {
    const result = calcOTCSignal(symbol);
    lastSignals[symbol] = { ...result, slope: parseFloat(slope.toFixed(3)), slopeDir, slopeStrong, updatedAt: new Date().toISOString() };
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
      recentPrices: tickHistory[symbol].slice(-10).map(t => t.price),
      rsi: signal.rsi,
      macd: signal.macd,
      emaTrend: signal.emaTrend,
      streak: signal.streak,
      pattern: signal.pattern,
      reasons: signal.reasons || [],
      updatedAt: signal.updatedAt || null,
      slope: parseFloat(lastSlopes[symbol]?.slope || 0),
      slopeDir: lastSlopes[symbol]?.slopeDir || 'FLAT',
      slopeStrong: !!lastSlopes[symbol]?.slopeStrong,
      isOTC: true,
      isCrypto: symbol.toLowerCase().includes('btc') || symbol.toLowerCase().includes('eth')
    };
  });
}

module.exports = { updateAllOTC, getOTCState, OTC_PAIRS };
