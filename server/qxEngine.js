// ============================================================
// RK DXB Trader — QX Signal Engine
// Receives real ticks from QX Chrome extension
// Builds OHLC candles, runs full signal engine
// ============================================================

const { calculateOTCSignal } = require('./otcSignalEngine');

// State
const qxTicks    = {};  // sym -> last tick
const qxCandles  = {};  // sym -> last 100 closed candles
const qxCurrent  = {};  // sym -> current forming candle
const qxSignals  = {};  // sym -> last signal
const qxHistory  = {};  // sym -> signal history for confirmation

let lastPush  = null;   // timestamp of last extension push
let totalPairs = 0;

// QX OTC pairs we track — ALL LOWERCASE to match normalizeSymbol() output
const QX_PAIRS = [
  'eurusd_otc','gbpusd_otc','usdjpy_otc','audusd_otc','usdcad_otc',
  'eurgbp_otc','gbpjpy_otc','eurjpy_otc','usdchf_otc','nzdusd_otc',
  'audcad_otc','audnzd_otc','cadjpy_otc','audchf_otc','nzdchf_otc',
  'gbpcad_otc','eurcad_otc','eurchf_otc','gbpaud_otc','nzdjpy_otc',
  'btcusd_otc','ethusd_otc','ltcusd_otc','xrpusd_otc'
];

const DISPLAY = {
  'eurusd_otc':'EUR/USD','gbpusd_otc':'GBP/USD','usdjpy_otc':'USD/JPY',
  'audusd_otc':'AUD/USD','usdcad_otc':'USD/CAD','eurgbp_otc':'EUR/GBP',
  'gbpjpy_otc':'GBP/JPY','eurjpy_otc':'EUR/JPY','usdchf_otc':'USD/CHF',
  'nzdusd_otc':'NZD/USD','audcad_otc':'AUD/CAD','audnzd_otc':'AUD/NZD',
  'cadjpy_otc':'CAD/JPY','audchf_otc':'AUD/CHF','nzdchf_otc':'NZD/CHF',
  'gbpcad_otc':'GBP/CAD','eurcad_otc':'EUR/CAD','eurchf_otc':'EUR/CHF',
  'gbpaud_otc':'GBP/AUD','nzdjpy_otc':'NZD/JPY',
  'btcusd_otc':'BTC/USD','ethusd_otc':'ETH/USD',
  'ltcusd_otc':'LTC/USD','xrpusd_otc':'XRP/USD'
};

// Process incoming ticks from extension
function processTicks(ticks) {
  if (!ticks || !Array.isArray(ticks)) return;
  lastPush = Date.now();

  ticks.forEach(tick => {
    const raw = tick.sym || tick.asset || tick.symbol;
    if (!raw || tick.price === undefined) return;

    // Normalize symbol to lowercase _otc format
    const sym = normalizeSymbol(raw);
    const price = parseFloat(tick.price);
    const ts = tick.ts || Date.now();

    if (isNaN(price) || price <= 0) return;

    // Store latest tick
    qxTicks[sym] = { sym, price, ts };

    // Build candle
    buildCandle(sym, price, ts);
  });

  // Update total pairs count
  totalPairs = Object.keys(qxTicks).length;

  // Recalculate signals for all pairs that got ticks
  ticks.forEach(tick => {
    const sym = normalizeSymbol(tick.sym || tick.asset || '');
    if (sym && qxCandles[sym]) calcSignal(sym);
  });
}

function normalizeSymbol(raw) {
  if (!raw) return null;
  let sym = raw.toLowerCase().trim();
  // Ensure _otc suffix
  if (!sym.endsWith('_otc')) sym += '_otc';
  return sym;
}

function buildCandle(sym, price, ts) {
  const minute = Math.floor(ts / 60000) * 60000;

  if (!qxCurrent[sym] || qxCurrent[sym].minute !== minute) {
    // Close current candle
    if (qxCurrent[sym] && qxCurrent[sym].ticks > 0) {
      const c = qxCurrent[sym];
      if (!qxCandles[sym]) qxCandles[sym] = [];
      qxCandles[sym].push({
        time: new Date(c.minute).toISOString(),
        open: c.open, high: c.high, low: c.low, close: c.close,
        volume: c.ticks, minute: c.minute
      });
      if (qxCandles[sym].length > 100) qxCandles[sym].shift();
    }
    // New candle
    qxCurrent[sym] = { minute, open: price, high: price, low: price, close: price, ticks: 1 };
  } else {
    const c = qxCurrent[sym];
    if (price > c.high) c.high = price;
    if (price < c.low)  c.low  = price;
    c.close = price;
    c.ticks++;
  }
}

function calcSignal(sym) {
  const closed = qxCandles[sym] || [];
  const candles = [...closed];
  if (qxCurrent[sym] && qxCurrent[sym].ticks > 0) {
    const c = qxCurrent[sym];
    candles.push({ open:c.open, high:c.high, low:c.low, close:c.close, volume:c.ticks });
  }
  if (candles.length < 5) return;

  const result = calculateOTCSignal(sym, candles);
  qxSignals[sym] = { ...result, updatedAt: new Date().toISOString() };
}

// Get full state for broadcast
function getQXState() {
  const extensionOnline = lastPush && (Date.now() - lastPush) < 10000; // online if push <10s ago

  const pairs = QX_PAIRS
    .filter(sym => qxTicks[sym]) // only pairs with data
    .map(sym => {
      const tick  = qxTicks[sym]  || {};
      const sig   = qxSignals[sym] || { signal:'WAIT', confidence:0 };
      const candles = qxCandles[sym] || [];

      return {
        symbol:      sym,
        displayName: DISPLAY[sym] || sym.replace('_otc','').toUpperCase(),
        signal:      sig.signal      || 'WAIT',
        confidence:  sig.confidence  || 0,
        isConfirmed: sig.isConfirmed || false,
        rawSignal:   sig.rawSignal   || 'WAIT',
        rsi:         sig.rsi,
        stoch:       sig.stoch,
        macd:        sig.macd,
        emaTrend:    sig.emaTrend,
        wr:          sig.wr,
        pattern:     sig.pattern,
        behavior:    sig.behavior,
        bbPos:       sig.bbPos,
        signalHistory: sig.signalHistory || [],
        reasons:     sig.reasons || [],
        currentPrice: tick.price || null,
        candleCount: candles.length,
        isCrypto:    sym.includes('btc') || sym.includes('eth') || sym.includes('ltc') || sym.includes('xrp'),
        updatedAt:   sig.updatedAt || null
      };
    });

  // Also include pairs we know about but haven't received data for yet
  const activePairs = new Set(pairs.map(p => p.symbol));
  const waitingPairs = QX_PAIRS
    .filter(sym => !activePairs.has(sym))
    .map(sym => ({
      symbol: sym,
      displayName: DISPLAY[sym] || sym.replace('_otc','').toUpperCase(),
      signal: 'WAIT', confidence: 0, isConfirmed: false,
      candleCount: 0, currentPrice: null,
      isCrypto: sym.includes('btc') || sym.includes('eth') || sym.includes('ltc') || sym.includes('xrp')
    }));

  return {
    type:            'qx',
    pairs:           [...pairs, ...waitingPairs],
    activePairs:     pairs.length,
    totalPairs:      QX_PAIRS.length,
    extensionOnline,
    lastPush,
    serverTime:      new Date().toISOString()
  };
}

module.exports = { processTicks, getQXState, QX_PAIRS };
