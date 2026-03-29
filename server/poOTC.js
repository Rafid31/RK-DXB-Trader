// ================================================================
// RK DXB Trader — Pocket Option OTC Engine v3.0
//
// Data source: po-static.com SVG API (165×55 px, ~62 pts / fetch)
//
// Key insight: every SVG fetch normalises its Y-axis to the LOCAL
// price range of that fetch (maxY-minY).  Cross-fetch price values
// are incomparable.  The ONLY reliable data within each fetch is:
//   • The 62 price points that share the same normalisation frame
//   • The SVG slope (linear-regression on those same 62 pts)
//
// Architecture v3.0
//   1. svgHistory  — rolling array of the last 30 SVG analyses
//      (one entry per tick, ~2 s apart = ~60 s of reliable data)
//      → feeds analyzeCurrentFetch() in the signal engine
//   2. candleStore — closed 1-min candles (stores SVG slope per
//      candle so calc5MinTrend() can use reliable slope-based HTF)
//   3. fiveMinStore — 5-min candles for display only
//
// Signals are confirmed after 5 consecutive same raw signals
// (~10 seconds) instead of the old 3-minute wait.
// ================================================================

const fetch = require('node-fetch');
const { calculateOTCSignal, analyzeCurrentFetch } = require('./otcSignalEngine');

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

// ── Per-pair state ─────────────────────────────────────────────
const svgHistoryStore = {};  // rolling SVG analyses  (last 30 = ~60 s)
const tickHistory     = {};  // last 60 raw price ticks (for trend display)
const candleStore     = {};  // closed 1-min candles with slope field
const fiveMinStore    = {};  // 5-min candles (display only)
const lastSignals     = {};
const currentCandle   = {};
const current5mCandle = {};
const lastSlopes      = {};

OTC_PAIRS.forEach(sym => {
  svgHistoryStore[sym]  = [];
  tickHistory[sym]      = [];
  candleStore[sym]      = [];
  fiveMinStore[sym]     = [];
  lastSignals[sym]      = { signal: 'WAIT', confidence: 0 };
  lastSlopes[sym]       = { slope: 0, slopeDir: 'FLAT', slopeStrong: false };
  currentCandle[sym]    = null;
  current5mCandle[sym]  = null;
});

// ── Parse SVG polyline ─────────────────────────────────────────
// Returns [{x, price}] where price = (maxY-y)/(maxY-minY)*100.
// All points within ONE fetch share the same normalisation.
function parseSVG(svgText) {
  const match = svgText.match(/points="([^"]+)"/);
  if (!match) return [];

  const rawPts = match[1].trim().split(/\s+/).map(p => {
    const parts = p.split(',');
    return { x: parseFloat(parts[0]), y: parseFloat(parts[1]) };
  }).filter(p => !isNaN(p.x) && !isNaN(p.y) && p.y !== 55);  // exclude baseline

  if (rawPts.length === 0) return [];

  const ys   = rawPts.map(p => p.y);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const range = maxY - minY || 1;

  // price: 0 = lowest point (maxY in SVG), 100 = highest point (minY in SVG)
  return rawPts.map(p => ({
    x:     p.x,
    price: parseFloat(((maxY - p.y) / range * 100).toFixed(4))
  }));
}

// ── SVG slope (linear regression on x vs price) ───────────────
// Uses actual x coordinates → scale-independent, reliable within fetch.
function calcSlope(pts, n) {
  n = n || pts.length;
  const last = pts.slice(-Math.min(n, pts.length));
  if (last.length < 3) return 0;
  const len   = last.length;
  const sumX  = last.reduce((s, p) => s + p.x, 0);
  const sumY  = last.reduce((s, p) => s + p.price, 0);
  const sumXY = last.reduce((s, p) => s + p.x * p.price, 0);
  const sumX2 = last.reduce((s, p) => s + p.x * p.x, 0);
  const denom = len * sumX2 - sumX * sumX;
  if (denom === 0) return 0;
  return (len * sumXY - sumX * sumY) / denom;
}

// ── 1-min candle store (keeps slope per candle for HTF) ───────
function update1mCandle(symbol, pts, timestamp, svgSlope) {
  const currentPrice  = pts[pts.length - 1].price;
  const candleMinute  = Math.floor(timestamp / 60000) * 60000;

  // Raw tick for display
  tickHistory[symbol].push({ price: currentPrice, ts: timestamp });
  if (tickHistory[symbol].length > 60) tickHistory[symbol].shift();

  if (!currentCandle[symbol] || currentCandle[symbol].minute !== candleMinute) {
    // ── Close previous candle ──
    if (currentCandle[symbol] && currentCandle[symbol].tickCount > 0) {
      const c = currentCandle[symbol];
      const closed1m = {
        time:   new Date(c.minute).toISOString(),
        open:   c.open,
        high:   c.high,
        low:    c.low,
        close:  c.close,
        volume: c.tickCount,
        minute: c.minute,
        slope:  parseFloat((c.slope || 0).toFixed(3))  // reliable SVG slope
      };
      candleStore[symbol].push(closed1m);
      if (candleStore[symbol].length > 120) candleStore[symbol].shift();
      update5mCandle(symbol, closed1m);
    }

    // ── Open new candle ──
    const first = pts[0];
    currentCandle[symbol] = {
      minute:    candleMinute,
      open:      first ? first.price : currentPrice,
      high:      Math.max(...pts.map(p => p.price)),
      low:       Math.min(...pts.map(p => p.price)),
      close:     currentPrice,
      tickCount: 1,
      slope:     svgSlope || 0
    };
  } else {
    const c = currentCandle[symbol];
    const pmax = Math.max(...pts.map(p => p.price));
    const pmin = Math.min(...pts.map(p => p.price));
    if (pmax > c.high) c.high = pmax;
    if (pmin < c.low)  c.low  = pmin;
    c.close     = currentPrice;
    c.tickCount++;
    c.slope     = svgSlope || 0;  // keep refreshed every tick
  }
}

// ── 5-min candle store (display only) ─────────────────────────
function update5mCandle(symbol, closedCandle1m) {
  const fiveMinMs  = 5 * 60000;
  const fiveMinute = Math.floor(closedCandle1m.minute / fiveMinMs) * fiveMinMs;

  if (!current5mCandle[symbol] || current5mCandle[symbol].minute !== fiveMinute) {
    if (current5mCandle[symbol] && current5mCandle[symbol].count > 0) {
      const c5 = current5mCandle[symbol];
      fiveMinStore[symbol].push({
        time: new Date(c5.minute).toISOString(),
        open: c5.open, high: c5.high, low: c5.low, close: c5.close,
        volume: c5.count, minute: c5.minute
      });
      if (fiveMinStore[symbol].length > 50) fiveMinStore[symbol].shift();
    }
    current5mCandle[symbol] = {
      minute: fiveMinute,
      open:   closedCandle1m.open,
      high:   closedCandle1m.high,
      low:    closedCandle1m.low,
      close:  closedCandle1m.close,
      count:  1
    };
  } else {
    const c5 = current5mCandle[symbol];
    if (closedCandle1m.high > c5.high) c5.high = closedCandle1m.high;
    if (closedCandle1m.low  < c5.low)  c5.low  = closedCandle1m.low;
    c5.close = closedCandle1m.close;
    c5.count++;
  }
}

function get5mCandles(symbol) {
  const store = [...fiveMinStore[symbol]];
  const c5 = current5mCandle[symbol];
  if (c5 && c5.count > 0) {
    store.push({ open: c5.open, high: c5.high, low: c5.low, close: c5.close, volume: c5.count });
  }
  return store;
}

// ── Fetch SVG for one pair ─────────────────────────────────────
async function fetchOTCTick(symbol) {
  const ts  = Date.now() / 1000;
  const url = `https://po-static.com/uploads/img_favourites_symbols/${symbol}.svg?v=${ts}`;
  try {
    const res  = await fetch(url, { timeout: 5000 });
    if (!res.ok) return null;
    const text = await res.text();
    const pts  = parseSVG(text);
    return pts.length >= 8 ? pts : null;
  } catch (e) {
    return null;
  }
}

// ── Main update loop ───────────────────────────────────────────
async function updateOTCPair(symbol) {
  const pts = await fetchOTCTick(symbol);
  if (!pts) return;

  // Slope for candle storage and display (reliable — within-fetch)
  const slope       = calcSlope(pts);
  const slopeDir    = slope >  0.5 ? 'UP' : slope < -0.5 ? 'DOWN' : 'FLAT';
  const slopeStrong = Math.abs(slope) > 0.5;
  lastSlopes[symbol] = { slope: parseFloat(slope.toFixed(3)), slopeDir, slopeStrong };

  // Keep 1-min candle store updated (for 5M HTF slope calculation)
  update1mCandle(symbol, pts, Date.now(), slope);

  // ── SVG-native analysis ──────────────────────────────────────
  // analyzeCurrentFetch() computes all indicators on the 62 pts
  // that share the same normalisation frame → 100 % reliable.
  const analysis = analyzeCurrentFetch(pts);
  if (!analysis) return;

  // Rolling SVG history (last 30 entries ≈ 60 seconds)
  svgHistoryStore[symbol].push(analysis);
  if (svgHistoryStore[symbol].length > 30) svgHistoryStore[symbol].shift();

  // ── Generate signal ──────────────────────────────────────────
  // Pass svgHistory (for trend persistence) + closed 1-min candles
  // (for reliable slope-based 5M HTF via calc5MinTrend).
  const candles1m = candleStore[symbol];  // closed candles with slope
  const result = calculateOTCSignal(symbol, svgHistoryStore[symbol], candles1m);

  lastSignals[symbol] = {
    ...result,
    slope:      parseFloat(slope.toFixed(3)),
    slopeDir,
    slopeStrong,
    updatedAt:  new Date().toISOString()
  };
}

async function updateAllOTC() {
  await Promise.all(OTC_PAIRS.map(sym => updateOTCPair(sym)));
}

// ── State for broadcast ────────────────────────────────────────
function getOTCState() {
  const now      = new Date();
  const secsLeft = 60 - now.getUTCSeconds();

  return OTC_PAIRS.map(symbol => {
    const sig      = lastSignals[symbol];
    const ticks    = tickHistory[symbol];
    const lastTick = ticks[ticks.length - 1];
    const svgHist  = svgHistoryStore[symbol];

    // Short-term trend from tick direction
    let trend = 'FLAT';
    if (ticks.length >= 6) {
      const recent = ticks.slice(-6).map(t => t.price);
      const avgP   = recent.reduce((s, p) => s + p, 0) / recent.length;
      trend = lastTick && lastTick.price > avgP ? 'UP'
            : lastTick && lastTick.price < avgP ? 'DOWN' : 'FLAT';
    }

    const candles5m = get5mCandles(symbol);

    return {
      symbol,
      displayName:   DISPLAY_NAMES[symbol],
      signal:        sig.signal      || 'WAIT',
      confidence:    sig.confidence  || 0,
      isConfirmed:   !!sig.isConfirmed,
      rawSignal:     sig.rawSignal   || 'WAIT',
      rawConf:       sig.rawConf     || 0,
      signalHistory: sig.signalHistory || [],
      trend,
      currentPrice:  lastTick ? lastTick.price : null,
      recentPrices:  ticks.slice(-10).map(t => t.price),
      // Candle counts
      candleCount:   candleStore[symbol].length,
      candle1mCount: candleStore[symbol].length,
      candle5mCount: candles5m.length,
      svgHistCount:  svgHist.length,
      // Indicators (from SVG-native analysis — reliable)
      rsi:           sig.rsi,
      stoch:         sig.stoch,
      wr:            sig.wr,
      bbPos:         sig.bbPos,
      bbSqueeze:     sig.bbSqueeze,
      emaTrend:      sig.emaTrend,
      sweep:         sig.sweep,
      votes:         sig.votes || null,
      htfTrend:      sig.htfTrend,
      htfStrength:   sig.htfStrength,
      htfBlocked:    sig.htfBlocked,
      reasons:       sig.reasons || [],
      // Slope (reliable — per-fetch)
      slope:         parseFloat((lastSlopes[symbol] ? lastSlopes[symbol].slope : 0).toFixed(3)),
      slopeDir:      lastSlopes[symbol] ? lastSlopes[symbol].slopeDir : 'FLAT',
      slopeStrong:   !!(lastSlopes[symbol] && lastSlopes[symbol].slopeStrong),
      // Latest SVG analysis snapshot for debugging
      svgAnalysis: svgHist.length > 0 ? {
        slopeFull:   parseFloat((svgHist[svgHist.length-1].slopeFull  || 0).toFixed(3)),
        slopeRecent: parseFloat((svgHist[svgHist.length-1].slopeRecent|| 0).toFixed(3)),
        pricePos:    svgHist[svgHist.length-1].pricePos,
        momentum:    parseFloat((svgHist[svgHist.length-1].momentum   || 0).toFixed(3))
      } : null,
      updatedAt:  sig.updatedAt || null,
      secsLeft,
      isOTC:      true,
      isCrypto:   symbol.toLowerCase().includes('btc') || symbol.toLowerCase().includes('eth')
    };
  });
}

module.exports = { updateAllOTC, getOTCState, OTC_PAIRS };
