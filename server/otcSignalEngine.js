// ================================================================
// RK DXB Trader — OTC Signal Engine v3.0  (SVG-NATIVE ANALYSIS)
//
// Root-cause fix: po-static.com SVG normalises its Y-axis to the
// LOCAL price range on EVERY fetch (using minY/maxY of that fetch).
// This means candle OHLC values from different fetches live in
// completely different normalisation frames — making cross-candle
// RSI / EMA / MACD / BB all meaningless noise.
//
// Solution: compute ALL indicators directly on the ~62 price points
// that come from a SINGLE SVG fetch (same normalisation frame →
// 100 % reliable). Store a rolling history of these analyses (~30
// entries = ~60 seconds) and confirm signals when 5 consecutive
// ticks agree (~10 seconds).  No more 3-minute wait.
//
// Architecture:
//   SVG fetch (62 pts, same frame) → analyzeCurrentFetch()
//     → RSI, slope, BB, Stoch, WR, liquidity-sweep
//   Rolling svgHistory (last 30 entries ≈ 60 s)
//     → trend persistence score → fast confirmation
//   Closed 1-min candles (store SVG slope per candle)
//     → calc5MinTrend() → HTF filter (reliable slope-based)
//
// Signal fires when:
//   a) margin >= 5 AND total >= 8   (strong multi-indicator agree)
//   b) margin >= 4 AND total >= 7   AND SVG slope is directional
//   c) liquidity sweep detected      AND margin >= 3
//   d) 5M HTF must agree or be FLAT (blocks counter-trend, allows sweep)
//
// Confirmation:
//   Immediate : liquidity sweep detected
//   Fast      : 3 consecutive same raw signal + confidence >= 72
//   Standard  : 5 consecutive same raw signal (~10 seconds)
//   Clear     : 5 consecutive WAITs
// ================================================================

'use strict';

// ── Maths helpers ────────────────────────────────────────────────
function avg(arr) { return arr.reduce((s, v) => s + v, 0) / arr.length; }
function stdDev(arr) {
  const m = avg(arr);
  return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / arr.length);
}
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function linSlope(vals) {
  const n = vals.length;
  if (n < 3) return 0;
  const xs = vals.map((_, i) => i);
  const mx = avg(xs), my = avg(vals);
  const num = xs.reduce((s, x, i) => s + (x - mx) * (vals[i] - my), 0);
  const den = xs.reduce((s, x) => s + (x - mx) ** 2, 0);
  return den === 0 ? 0 : num / den;
}

// RSI — works on any price array, reliable when all prices share
// the same normalisation frame (i.e. within a single SVG fetch).
function calcRSI(prices, period) {
  period = period || 14;
  if (prices.length < period + 1) return null;
  const changes = prices.slice(1).map((p, i) => p - prices[i]).slice(-period);
  const gains  = changes.filter(c => c > 0).reduce((s, c) => s + c, 0) / period;
  const losses = changes.filter(c => c < 0).reduce((s, c) => s + Math.abs(c), 0) / period;
  if (losses === 0) return 100;
  if (gains  === 0) return 0;
  return parseFloat((100 - 100 / (1 + gains / losses)).toFixed(1));
}

// Bollinger Bands — reliable on same-frame price array.
function calcBB(prices, period) {
  period = period || 20;
  if (prices.length < period) {
    period = prices.length;
    if (period < 3) return { pos: 'MID', pct: 50, squeeze: false };
  }
  const sl = prices.slice(-period);
  const ma = avg(sl), sd = stdDev(sl);
  const upper = ma + 2 * sd, lower = ma - 2 * sd;
  const last  = prices[prices.length - 1];
  const range = upper - lower || 0.001;
  // squeeze: std-dev < 2 % of mid on a 0-100 scale → expect breakout
  return {
    pos: last > upper ? 'ABOVE' : last < lower ? 'BELOW' : 'MID',
    pct: parseFloat(((last - lower) / range * 100).toFixed(1)),
    upper, lower, ma,
    squeeze: sd > 0 && sd < 2.0
  };
}

// ── Analyse a single SVG fetch ───────────────────────────────────
// pts = [{x, price}] — ALL from the SAME normalisation frame.
// price = (maxY - y) / (maxY - minY) * 100  →  0 = low, 100 = high.
// Because all 62 points share the frame, every indicator here is
// comparing apples to apples and is completely reliable.
function analyzeCurrentFetch(pts) {
  if (!pts || pts.length < 8) return null;

  const prices = pts.map(p => p.price);
  const n      = prices.length;
  const half   = Math.floor(n / 2);
  const third  = Math.floor(n / 3);

  // ── Slopes (reliable — same frame) ──────────────────────────
  const slopeFull   = linSlope(prices);                            // full-minute trend
  const slopeRecent = linSlope(prices.slice(-Math.max(third, 5))); // last ~20 s
  const slopeEarly  = linSlope(prices.slice(0, half));             // first ~30 s
  const momentum    = slopeRecent - slopeEarly;                    // accel / decel

  // ── RSI (14 periods on up to 62 points) ─────────────────────
  const rsi = calcRSI(prices, Math.min(14, n - 1));

  // ── Bollinger Bands (20-period) ──────────────────────────────
  const bb = calcBB(prices, Math.min(20, n));

  // ── Stochastic & Williams %R ─────────────────────────────────
  // Use the price itself as H/L/C — valid because all values are
  // in the same normalisation frame within this fetch.
  const period     = Math.min(14, n);
  const recentPrices = prices.slice(-period);
  const stochH     = Math.max(...recentPrices);
  const stochL     = Math.min(...recentPrices);
  const stoch      = stochH === stochL ? 50 :
    parseFloat(((prices[n - 1] - stochL) / (stochH - stochL) * 100).toFixed(1));
  const wr         = stochH === stochL ? -50 :
    parseFloat(((stochH - prices[n - 1]) / (stochH - stochL) * -100).toFixed(1));

  // ── Price position in this fetch ────────────────────────────
  const fetchH   = Math.max(...prices);
  const fetchL   = Math.min(...prices);
  const pricePos = fetchH === fetchL ? 50 :
    parseFloat(((prices[n - 1] - fetchL) / (fetchH - fetchL) * 100).toFixed(1));

  // ── Micro liquidity sweep (within single fetch → reliable) ──
  // Sweep: price wicks past the first-half range, then closes back.
  const earlyH = Math.max(...prices.slice(0, half));
  const earlyL = Math.min(...prices.slice(0, half));
  const lateH  = Math.max(...prices.slice(half));
  const lateL  = Math.min(...prices.slice(half));
  const last   = prices[n - 1];
  let sweep = null;
  if (lateH > earlyH + 4 && last < earlyH && slopeRecent < -0.2) {
    sweep = { type: 'BEAR_SWEEP', bias: -4, reason: 'Bearish liq sweep' };
  } else if (lateL < earlyL - 4 && last > earlyL && slopeRecent > 0.2) {
    sweep = { type: 'BULL_SWEEP', bias: 4, reason: 'Bullish liq sweep' };
  }

  return {
    slopeFull, slopeRecent, slopeEarly, momentum,
    rsi, bb, stoch, wr, pricePos, sweep,
    firstPrice: prices[0],
    lastPrice:  prices[n - 1],
    n
  };
}

// ── 5-Min HTF using stored 1-min candle slopes ───────────────────
// Each closed 1-min candle stores the SVG slope from its final tick
// (computed within one SVG fetch → reliable).  Using those slopes
// instead of the unreliable cross-fetch close prices gives a
// trustworthy longer-timeframe bias.
function calc5MinTrend(candles1m) {
  if (!candles1m || candles1m.length < 3) return { trend: 'FLAT', strength: 0 };

  // Last 10 closed candles (≈ 10 min window)
  const recent  = candles1m.slice(-Math.min(10, candles1m.length));
  const slopes  = recent.map(c => c.slope || 0);
  const avgAll  = avg(slopes);
  const avgLast = avg(slopes.slice(-5));

  let up = 0, dn = 0;
  if (avgAll  >  0.2) up += 2; else if (avgAll  < -0.2) dn += 2;
  if (avgLast >  0.3) up += 2; else if (avgLast < -0.3) dn += 2;

  // Count candles that have a clear direction
  const upCnt = slopes.filter(s => s >  0.1).length;
  const dnCnt = slopes.filter(s => s < -0.1).length;
  if (upCnt > dnCnt + 2) up += 2;
  if (dnCnt > upCnt + 2) dn += 2;

  const strength = Math.abs(up - dn);
  if (up > dn && strength >= 2) return { trend: 'UP',   strength, avgSlope: avgAll };
  if (dn > up && strength >= 2) return { trend: 'DOWN', strength, avgSlope: avgAll };
  return { trend: 'FLAT', strength: 0, avgSlope: avgAll };
}

// ── Core signal from current SVG analysis ───────────────────────
function calcRawSignal(analysis, svgHistory, candles1m) {
  if (!analysis) {
    return { signal: 'WAIT', confidence: 0, reason: 'Collecting SVG data...',
             votes: { up: 0, dn: 0, total: 0, margin: 0 }, reasons: [] };
  }

  let up = 0, dn = 0;
  const reasons = [];

  // ── 1. FULL-MINUTE SLOPE — primary (62 same-frame points) ───
  const sf = analysis.slopeFull;
  if      (sf >  0.8) { up += 5; reasons.push('Strong slope UP ' + sf.toFixed(2)); }
  else if (sf >  0.4) { up += 3; reasons.push('Slope UP ' + sf.toFixed(2)); }
  else if (sf >  0.15) up += 1;
  if      (sf < -0.8) { dn += 5; reasons.push('Strong slope DN ' + sf.toFixed(2)); }
  else if (sf < -0.4) { dn += 3; reasons.push('Slope DN ' + sf.toFixed(2)); }
  else if (sf < -0.15) dn += 1;

  // ── 2. RECENT SLOPE (last ~20 s) — momentum ─────────────────
  const sr = analysis.slopeRecent;
  if      (sr >  0.5) { up += 2; reasons.push('Recent accel UP'); }
  else if (sr >  0.2)   up += 1;
  if      (sr < -0.5) { dn += 2; reasons.push('Recent accel DN'); }
  else if (sr < -0.2)   dn += 1;

  // ── 3. RSI — reliable (same frame) ──────────────────────────
  const rsi = analysis.rsi;
  if (rsi !== null) {
    if      (rsi < 20) { up += 4; reasons.push('RSI extreme OS ' + rsi); }
    else if (rsi < 30) { up += 3; reasons.push('RSI oversold '   + rsi); }
    else if (rsi < 40)   up += 1;
    else if (rsi > 80) { dn += 4; reasons.push('RSI extreme OB ' + rsi); }
    else if (rsi > 70) { dn += 3; reasons.push('RSI overbought ' + rsi); }
    else if (rsi > 60)   dn += 1;
  }

  // ── 4. BOLLINGER BANDS — reliable ───────────────────────────
  if (analysis.bb.pos === 'BELOW') { up += 2; reasons.push('Below BB lower'); }
  if (analysis.bb.pos === 'ABOVE') { dn += 2; reasons.push('Above BB upper'); }
  if (analysis.bb.squeeze)           reasons.push('BB squeeze — breakout due');

  // ── 5. STOCHASTIC — reliable ─────────────────────────────────
  const st = analysis.stoch;
  if      (st < 20) { up += 2; reasons.push('Stoch OS ' + st); }
  else if (st < 35)   up += 1;
  else if (st > 80) { dn += 2; reasons.push('Stoch OB ' + st); }
  else if (st > 65)   dn += 1;

  // ── 6. WILLIAMS %R — reliable ───────────────────────────────
  if (analysis.wr <= -80) up += 1;
  if (analysis.wr >= -20) dn += 1;

  // ── 7. LIQUIDITY SWEEP — strong reversal ────────────────────
  if (analysis.sweep) {
    if (analysis.sweep.bias > 0) { up += 4; reasons.push(analysis.sweep.reason); }
    else                          { dn += 4; reasons.push(analysis.sweep.reason); }
  }

  // ── 8. SVG HISTORY TREND — slope persistence over ~30–60 s ──
  const hist = svgHistory || [];
  if (hist.length >= 8) {
    const h15      = hist.slice(-15);
    const h8       = hist.slice(-8);
    const up15     = h15.filter(h => h.slopeFull >  0.15).length;
    const dn15     = h15.filter(h => h.slopeFull < -0.15).length;
    const up8      = h8.filter(h  => h.slopeFull >  0.10).length;
    const dn8      = h8.filter(h  => h.slopeFull < -0.10).length;

    if      (up15 >= 11) { up += 3; reasons.push(up15 + '/15 fetches UP trend'); }
    else if (up8  >= 6)  { up += 2; reasons.push(up8  + '/8 fetches UP'); }
    if      (dn15 >= 11) { dn += 3; reasons.push(dn15 + '/15 fetches DN trend'); }
    else if (dn8  >= 6)  { dn += 2; reasons.push(dn8  + '/8 fetches DN'); }
  }

  // ── 9. 5-MIN HTF — slope-based (reliable) ───────────────────
  const htf = calc5MinTrend(candles1m);
  let htfBoost = 0, htfBlock = false;
  const goingUp   = up > dn;
  const goingDown = dn > up;
  if (htf.trend !== 'FLAT') {
    if (htf.trend === 'UP'   && goingUp)    { htfBoost = 3; reasons.push('5M UP aligns'); }
    if (htf.trend === 'DOWN' && goingDown)  { htfBoost = 3; reasons.push('5M DN aligns'); }
    // Block counter-trend signals (allow sweep reversals through)
    if (htf.trend === 'UP'   && goingDown  && !analysis.sweep) htfBlock = true;
    if (htf.trend === 'DOWN' && goingUp    && !analysis.sweep) htfBlock = true;
  }

  // ── Decision ─────────────────────────────────────────────────
  const total  = up + dn;
  const margin = Math.abs(up - dn);
  const hasDir = Math.abs(sf) > 0.3;

  const strongEnough =
    (margin >= 5 && total >= 8)                     ||  // very strong agree
    (margin >= 4 && total >= 7 && hasDir)            ||  // strong + slope
    (analysis.sweep !== null && margin >= 3);            // sweep reversal

  let rawSignal = 'WAIT', rawConf = 0;
  if (!htfBlock && strongEnough && up > dn) {
    rawSignal = 'BUY';
    rawConf   = clamp(52 + margin * 4 + htfBoost, 0, 93);
  }
  if (!htfBlock && strongEnough && dn > up) {
    rawSignal = 'SELL';
    rawConf   = clamp(52 + margin * 4 + htfBoost, 0, 93);
  }

  return {
    signal:      rawSignal,
    confidence:  rawConf,
    rsi,
    stoch:       analysis.stoch,
    wr:          analysis.wr,
    bbPos:       analysis.bb.pos,
    bbSqueeze:   analysis.bb.squeeze,
    emaTrend:    sf >  0.2 ? 'bullish' : sf < -0.2 ? 'bearish' : 'neutral',
    sweep:       analysis.sweep ? analysis.sweep.type : null,
    htfTrend:    htf.trend,
    htfStrength: htf.strength,
    htfBlocked:  htfBlock,
    votes:       { up, dn, total, margin },
    reasons:     reasons.slice(0, 7)
  };
}

// ── Confirmation ─────────────────────────────────────────────────
// With reliable SVG-native data, history is pushed every tick (~2 s).
// Confirmation requires 5 consecutive same raw signals (~10 seconds).
// This replaces the old 3-minute per-minute gate.
const signalHistory = {};
const confirmedSig  = {};

function calculateOTCSignal(symbol, svgHistory, candles1m) {
  if (!signalHistory[symbol]) signalHistory[symbol] = [];
  if (!confirmedSig[symbol])
    confirmedSig[symbol] = { signal: 'WAIT', confidence: 0, isConfirmed: false };

  // Current analysis = last entry of svgHistory (most recent SVG fetch)
  const currentAnalysis = svgHistory && svgHistory.length > 0
    ? svgHistory[svgHistory.length - 1]
    : null;

  const raw  = calcRawSignal(currentAnalysis, svgHistory, candles1m);
  const hist = signalHistory[symbol];

  // Push every tick — reliable because indicators use same-frame SVG data
  hist.push(raw.signal);
  if (hist.length > 20) hist.shift();

  const prev = confirmedSig[symbol];

  if (hist.length >= 3) {
    const last5 = hist.slice(-5);
    const last3 = hist.slice(-3);
    const same5 = hist.length >= 5 && last5.every(s => s === last5[0]) && last5[0] !== 'WAIT';
    const same3 = last3.every(s => s === last3[0]) && last3[0] !== 'WAIT';
    const allW5 = hist.length >= 5 && last5.every(s => s === 'WAIT');

    if (raw.sweep && raw.signal !== 'WAIT') {
      // Immediate confirm on liquidity sweep — very strong signal
      confirmedSig[symbol] = {
        signal:      raw.signal,
        confidence:  Math.min(95, raw.confidence + 5),
        isConfirmed: true
      };
    } else if (same5) {
      // 5 in a row ≈ 10 seconds of consistent direction
      confirmedSig[symbol] = {
        signal:      last5[0],
        confidence:  Math.min(93, raw.confidence + 8),
        isConfirmed: true
      };
    } else if (same3 && raw.confidence >= 72) {
      // 3 in a row + high confidence (strong indicators agree)
      confirmedSig[symbol] = {
        signal:      last3[0],
        confidence:  raw.confidence,
        isConfirmed: true
      };
    } else if (allW5) {
      // 5 consecutive WAITs — clear the confirmed signal
      confirmedSig[symbol] = { signal: 'WAIT', confidence: 0, isConfirmed: false };
    } else if (prev.isConfirmed && same3 && last3[0] !== 'WAIT' && last3[0] !== prev.signal) {
      // Confirmed signal flipped direction — reset to WAIT first
      confirmedSig[symbol] = { signal: 'WAIT', confidence: 0, isConfirmed: false };
    }
  }

  return {
    ...raw,
    signal:        confirmedSig[symbol].signal,
    confidence:    confirmedSig[symbol].confidence,
    isConfirmed:   confirmedSig[symbol].isConfirmed,
    rawSignal:     raw.signal,
    rawConf:       raw.confidence,
    signalHistory: [...hist]
  };
}

module.exports = { calculateOTCSignal, analyzeCurrentFetch, calc5MinTrend };
