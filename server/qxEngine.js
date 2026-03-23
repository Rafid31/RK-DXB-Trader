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

// QX OTC pairs we track
const QX_PAIRS = [
  'EURUSD_otc','GBPUSD_otc','USDJPY_otc','AUDUSD_otc','USDCAD_otc',
  'EURGBP_otc','GBPJPY_otc','EURJPY_otc','USDCHF_otc','NZDUSD_otc',
  'AUDCAD_otc','AUDNZD_otc','CADJPY_otc','AUDCHF_otc','NZDCHF_otc',
  'GBPCAD_otc','EURCAD_otc','EURCHF_otc','GBPAUD_otc','NZDJPY_otc',
  'BTCUSD_otc','ETHUSD_otc','LTCUSD_otc','XRPUSD_otc'
];

const DISPLAY = {
  'EURUSD_otc':'EUR/USD','GBPUSD_otc':'GBP/USD','USDJPY_otc':'USD/JPY',
  'AUDUSD_otc':'AUD/USD','USDCAD_otc':'USD/CAD','EURGBP_otc':'EUR/GBP',
  'GBPJPY_otc':'GBP/JPY','EURJPY_otc':'EUR/JPY','USDCHF_otc':'USD/CHF',
  'NZDUSD_otc':'NZD/USD','AUDCAD_otc':'AUD/CAD','AUDNZD_otc':'AUD/NZD',
  'CADJPY_otc':'CAD/JPY','AUDCHF_otc':'AUD/CHF','NZDCHF_otc':'NZD/CHF',
  'GBPCAD_otc':'GBP/CAD','EURCAD_otc':'EUR/CAD','EURCHF_otc':'EUR/CHF',
  'GBPAUD_otc':'GBP/AUD','NZDJPY_otc':'NZD/JPY',
  'BTCUSD_otc':'BTC/USD','ETHUSD_otc':'ETH/USD',
  'LTCUSD_otc':'LTC/USD','XRPUSD_otc':'XRP/USD'
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
