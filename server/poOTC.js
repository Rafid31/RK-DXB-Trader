// ================================================================
// RK DXB Trader — Pocket Option OTC Engine v2.0
// Fetches 12 OTC pairs via PO's public SVG API
// Builds 1-min AND 5-min OHLC candles
// 5-min candles feed the HTF trend filter in the signal engine
// ================================================================

const fetch = require('node-fetch');
const { calculateOTCSignal } = require('./otcSignalEngine');

const OTC_PAIRS = [
  'EURUSD_otc', 'GBPUSD_otc', 'USDJPY_otc', 'AUDUSD_otc',
  'USDCAD_otc', 'EURGBP_otc', 'GBPJPY_otc', 'EURJPY_otc',
  'USDCHF_otc', 'NZDUSD_otc', 'BTCUSD_otc', 'ETHUSD_otc'
];

const DISPLAY_NAMES = {
  'EURUSD_otc': 'EUR/USD OTC', 'GBPUSD_otc': 'GBP/USD OTC',
  'USDJPY_otc': 'USD/JPY OTC', 'AUDUSD_otc': 'AUD/USD OTC',
  'USDCAD_otc': 'USD/CAD OTC', 'EURGBP_otc': 'EUR/GBP OTC',
  'GBPJPY_otc': 'GBP/JPY OTC', 'EURJPY_otc': 'EUR/JPY OTC',
  'USDCHF_otc': 'USD/CHF OTC', 'NZDUSD_otc': 'NZD/USD OTC',
  'BTCUSD_otc': 'BTC/USD OTC', 'ETHUSD_otc': 'ETH/USD OTC'
};

// Per-pair state
const tickHistory    = {};  // last 300 ticks (normalized price)
const candleStore    = {};  // 1-min candles (up to 100)
const fiveMinStore   = {};  // 5-min candles (up to 50)
const lastSignals    = {};
const currentCandle  = {};  // 1-min forming candle
const current5mCandle = {}; // 5-min forming candle
const lastSlopes     = {};

OTC_PAIRS.forEach(sym => {
  tickHistory[sym]     = [];
  candleStore[sym]     = [];
  fiveMinStore[sym]    = [];
  lastSignals[sym]     = { signal: 'WAIT', confidence: 0 };
  lastSlopes[sym]      = { slope: 0, slopeDir: 'FLAT', slopeStrong: false };
  currentCandle[sym]   = null;
  current5mCandle[sym] = null;
});

// ── Parse SVG polyline ─────────────────────────────────────────
function parseSVG(svgText) {
  const match = svgText.match(/points="([^"]+)"/);
  if (!match) return [];
  const rawPts = match[1].trim().split(/\s+/).map(p => {
    const parts = p.split(',');
    return { x: parseFloat(parts[0]), y: parseFloat(parts[1]) };
  }).filter(p => !isNaN(p.x) && !isNaN(p.y) && p.y !== 55);

  if (rawPts.length === 0) return [];

  const ys = rawPts.map(p => p.y);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const range = maxY - minY || 1;

  return rawPts.map(p => ({
    x: p.x,
    price: parseFloat(((maxY - p.y) / range * 100).toFixed(4))
  }));
}

// ── Slope from SVG points ──────────────────────────────────────
function calcSlope(pts, n) {
  n = n || 10;
  const last = pts.slice(-Math.min(n, pts.length));
  if (last.length < 3) return 0;
  const len = last.length;
  const sumX = last.reduce((s, p) => s + p.x, 0);
  const sumY = last.reduce((s, p) => s + p.price, 0);
  const sumXY = last.reduce((s, p) => s + p.x * p.price, 0);
  const sumX2 = last.reduce((s, p) => s + p.x * p.x, 0);
  const denom = len * sumX2 - sumX * sumX;
  if (denom === 0) return 0;
  return (len * sumXY - sumX * sumY) / denom;
}

// ── OHLC from SVG points ───────────────────────────────────────
function buildCandleFromSVG(pts) {
  const prices = pts.map(p => p.price);
  if (prices.length < 4) return null;
  return {
    open:  prices[0],
    close: prices[prices.length - 1],
    high:  Math.max(...prices),
    low:   Math.min(...prices)
  };
}

// ── Update 1-min candle store ──────────────────────────────────
// svgSlope is the per-fetch reliable slope; stored in the candle so the
// signal engine can use direction-based synthetic prices (Fix 3).
function update1mCandle(symbol, pts, timestamp, svgSlope) {
  const ticks = tickHistory[symbol];
  const currentPrice = pts[pts.length - 1].price;
  ticks.push({ price: currentPrice, ts: timestamp });
  if (ticks.length > 300) ticks.shift();

  const candleMinute = Math.floor(timestamp / 60000) * 60000;

  if (!currentCandle[symbol] || currentCandle[symbol].minute !== candleMinute) {
    // Close previous 1-min candle
    if (currentCandle[symbol] && currentCandle[symbol].tickCount > 0) {
      const c = currentCandle[symbol];
      const closed1m = {
        time: new Date(c.minute).toISOString(),
        open: c.open, high: c.high, low: c.low, close: c.close,
        volume: c.tickCount, minute: c.minute,
        slope: parseFloat((c.slope || 0).toFixed(3))  // Fix 3: carry SVG slope
      };
      candleStore[symbol].push(closed1m);
      if (candleStore[symbol].length > 100) candleStore[symbol].shift();

      // Also feed into 5-min candle
      update5mCandle(symbol, closed1m);
    }

    const svgC = buildCandleFromSVG(pts);
    currentCandle[symbol] = {
      minute: candleMinute,
      open:  svgC ? svgC.open : currentPrice,
      high:  svgC ? svgC.high : currentPrice,
      low:   svgC ? svgC.low  : currentPrice,
      close: currentPrice,
      tickCount: 1,
      slope: svgSlope || 0  // Fix 3: initialise with current fetch slope
    };
  } else {
    const svgC = buildCandleFromSVG(pts);
    const c = currentCandle[symbol];
    if (svgC) {
      if (svgC.high > c.high) c.high = svgC.high;
      if (svgC.low  < c.low)  c.low  = svgC.low;
    }
    c.close = currentPrice;
    c.tickCount++;
    if (svgSlope !== undefined) c.slope = svgSlope;  // Fix 3: keep slope fresh
  }
}

// ── Update 5-min candle store ──────────────────────────────────
function update5mCandle(symbol, closedCandle1m) {
  const fiveMinMs  = 5 * 60000;
  const fiveMinute = Math.floor(closedCandle1m.minute / fiveMinMs) * fiveMinMs;

  if (!current5mCandle[symbol] || current5mCandle[symbol].minute !== fiveMinute) {
    // Close previous 5-min candle
    if (current5mCandle[symbol] && current5mCandle[symbol].count > 0) {
      const c5 = current5mCandle[symbol];
      fiveMinStore[symbol].push({
        time: new Date(c5.minute).toISOString(),
        open: c5.open, high: c5.high, low: c5.low, close: c5.close,
        volume: c5.count, minute: c5.minute
      });
      if (fiveMinStore[symbol].length > 50) fiveMinStore[symbol].shift();
    }

    // Start new 5-min candle from this 1-min candle
    current5mCandle[symbol] = {
      minute: fiveMinute,
      open:  closedCandle1m.open,
      high:  closedCandle1m.high,
      low:   closedCandle1m.low,
      close: closedCandle1m.close,
      count: 1
    };
  } else {
    const c5 = current5mCandle[symbol];
    if (closedCandle1m.high > c5.high) c5.high = closedCandle1m.high;
    if (closedCandle1m.low  < c5.low)  c5.low  = closedCandle1m.low;
    c5.close = closedCandle1m.close;
    c5.count++;
  }
}

// ── Get full 5-min candle array (including forming candle) ────
function get5mCandles(symbol) {
  const store = [...fiveMinStore[symbol]];
  if (current5mCandle[symbol] && current5mCandle[symbol].count > 0) {
    const c5 = current5mCandle[symbol];
    store.push({ open: c5.open, high: c5.high, low: c5.low, close: c5.close, volume: c5.count });
  }
  return store;
}

// ── Calculate signal ───────────────────────────────────────────
function calcOTCSignal(symbol) {
  const candles1m = [...candleStore[symbol]];
  if (currentCandle[symbol] && currentCandle[symbol].tickCount > 0) {
    const c = currentCandle[symbol];
    candles1m.push({ open: c.open, high: c.high, low: c.low, close: c.close, volume: c.tickCount });
  }

  if (candles1m.length < 10) {
    return { signal: 'WAIT', confidence: 0, reason: 'Building data...' };
  }

  const candles5m = get5mCandles(symbol);
  // Pass current minute key so signal history only updates once per candle close
  return calculateOTCSignal(symbol, candles1m, candles5m, Math.floor(Date.now() / 60000));
}

// ── Fetch one pair ─────────────────────────────────────────────
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

// ── Main update loop ───────────────────────────────────────────
let updateCount = 0;

async function updateOTCPair(symbol) {
  const pts = await fetchOTCTick(symbol);
  if (!pts || pts.length === 0) return;

  const currentPrice = pts[pts.length - 1].price;

  // Slope from live SVG points (most reliable direction indicator)
  const slope = calcSlope(pts, 10);
  const slopeStrong = Math.abs(slope) > 0.5;
  const slopeDir = slope > 0.5 ? 'UP' : slope < -0.5 ? 'DOWN' : 'FLAT';
  lastSlopes[symbol] = { slope: parseFloat(slope.toFixed(3)), slopeDir, slopeStrong };

  update1mCandle(symbol, pts, Date.now(), slope);

  // Recalculate signal every 2 ticks (reduce noise)
  if (updateCount % 2 === 0) {
    let result = calcOTCSignal(symbol);

    // Live slope sanity check — only block an UNCONFIRMED signal when slope is
    // very strongly opposing it (|slope| > 2.0). Never block a confirmed signal:
    // confirmed means 3+ consecutive history entries agree, which outweighs a
    // noisy short-term SVG slope that re-normalizes on every fetch.
    if (!result.isConfirmed) {
      if (
        (slopeDir === 'UP'   && result.signal === 'SELL' && Math.abs(slope) > 2.0) ||
        (slopeDir === 'DOWN' && result.signal === 'BUY'  && Math.abs(slope) > 2.0)
      ) {
        result = { ...result, signal: 'WAIT', confidence: 0, isConfirmed: false };
      }
    }

    lastSignals[symbol] = {
      ...result,
      slope: parseFloat(slope.toFixed(3)),
      slopeDir, slopeStrong,
      updatedAt: new Date().toISOString()
    };
  }
}

async function updateAllOTC() {
  await Promise.all(OTC_PAIRS.map(sym => updateOTCPair(sym)));
  updateCount++;
}

// ── State for broadcast ────────────────────────────────────────
function getOTCState() {
  // Seconds remaining in current UTC minute (for client countdown)
  const now = new Date();
  const secsLeft = 60 - now.getUTCSeconds();

  return OTC_PAIRS.map(symbol => {
    const signal = lastSignals[symbol];
    const ticks  = tickHistory[symbol];
    const lastTick = ticks[ticks.length - 1];

    let trend = 'FLAT';
    if (ticks.length >= 10) {
      const recent = ticks.slice(-10).map(t => t.price);
      const avgP = recent.reduce((s, p) => s + p, 0) / recent.length;
      trend = (lastTick && lastTick.price > avgP) ? 'UP' : (lastTick && lastTick.price < avgP) ? 'DOWN' : 'FLAT';
    }

    const candles5m = get5mCandles(symbol);

    return {
      symbol,
      displayName: DISPLAY_NAMES[symbol],
      signal: signal.signal || 'WAIT',
      confidence: signal.confidence || 0,
      trend,
      currentPrice: lastTick ? lastTick.price : null,
      candleCount: candleStore[symbol].length,
      candle5mCount: candles5m.length,
      recentPrices: ticks.slice(-10).map(t => t.price),
      rsi: signal.rsi,
      stoch: signal.stoch,
      macd: signal.macd,
      emaTrend: signal.emaTrend,
      streak: signal.streak,
      pattern: signal.pattern,
      bbPos: signal.bbPos,
      bbSqueeze: signal.bbSqueeze,
      cci: signal.cci,
      sweep: signal.sweep,
      srZone: signal.srZone,
      htfTrend: signal.htfTrend,
      htfStrength: signal.htfStrength,
      reasons: signal.reasons || [],
      updatedAt: signal.updatedAt || null,
      slope: parseFloat(lastSlopes[symbol] ? lastSlopes[symbol].slope : 0),
      slopeDir: lastSlopes[symbol] ? lastSlopes[symbol].slopeDir : 'FLAT',
      slopeStrong: !!(lastSlopes[symbol] && lastSlopes[symbol].slopeStrong),
      isConfirmed: !!signal.isConfirmed,
      rawSignal: signal.rawSignal || 'WAIT',
      signalHistory: signal.signalHistory || [],
      isOTC: true,
      isCrypto: symbol.toLowerCase().includes('btc') || symbol.toLowerCase().includes('eth'),
      secsLeft
    };
  });
}

module.exports = { updateAllOTC, getOTCState, OTC_PAIRS };
