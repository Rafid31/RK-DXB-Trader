// ================================================================
// RK DXB Trader — OTC Signal Engine v4.0  (OTC-NATIVE PREDICTION)
//
// CORE INSIGHT (v4.0 rewrite):
// The old engine voted "slope UP → BUY" — meaning "current candle
// going up → next candle also goes up."  That is WRONG for OTC 1M
// markets which are strongly MEAN-REVERTING at short timeframes.
//
// Correct approach: predict the NEXT candle by reading the CURRENT
// candle's STRUCTURE (wick, exhaustion, momentum shift) rather than
// blindly following its direction.
//
// PREDICTION HIERARCHY for OTC next-candle:
//   TIER 1 — Candle structure (most reliable, 4-5 pts)
//     • Upper/lower wick → reversal signal
//     • Price exhaustion: pricePos at extreme + overbought/oversold
//     • Q4 reversal: candle was UP but Q4 slope turned DN (or vice-versa)
//     • Consecutive same-direction 1M candles → reversal due
//
//   TIER 2 — Oscillator confirmation (2-3 pts)
//     • RSI extreme (<25 bullish, >75 bearish)
//     • Stochastic extreme (<20 / >80)
//     • BB band touch (above upper → sell, below lower → buy)
//     • SVG history trend persistence
//
//   TIER 3 — Timeframe alignment (boost/filter)
//     • 5M HTF bias (+3 when aligned, blocks counter-trend)
//     • 15s micro-trend (+2 aligned, triple bonus +3)
//     • Liquidity sweep (strong reversal override)
//
// Three-timeframe TRIPLE alignment:
//   5M HTF + 1M candle structure + 15s micro ALL agree → +3 bonus
//   → "✅ 5M+1M+15s ALL UP/DN" — highest confidence signals
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
  return {
    pos: last > upper ? 'ABOVE' : last < lower ? 'BELOW' : 'MID',
    pct: parseFloat(((last - lower) / range * 100).toFixed(1)),
    upper, lower, ma,
    squeeze: sd > 0 && sd < 2.0
  };
}

// ── Analyse a single SVG fetch ───────────────────────────────────
// pts = [{x, price}] — ALL from the SAME normalisation frame.
// Now includes candle STRUCTURE analysis: wick, body, exhaustion.
function analyzeCurrentFetch(pts) {
  if (!pts || pts.length < 8) return null;

  const prices = pts.map(p => p.price);
  const n      = prices.length;
  const half   = Math.floor(n / 2);
  const third  = Math.floor(n / 3);

  // ── Slopes ───────────────────────────────────────────────────
  const slopeFull   = linSlope(prices);
  const slopeRecent = linSlope(prices.slice(-Math.max(third, 5)));
  const slopeEarly  = linSlope(prices.slice(0, half));
  const momentum    = slopeRecent - slopeEarly;

  // ── RSI ──────────────────────────────────────────────────────
  const rsi = calcRSI(prices, Math.min(14, n - 1));

  // ── Bollinger Bands ──────────────────────────────────────────
  const bb = calcBB(prices, Math.min(20, n));

  // ── Stochastic & Williams %R ─────────────────────────────────
  const period       = Math.min(14, n);
  const recentPrices = prices.slice(-period);
  const stochH       = Math.max(...recentPrices);
  const stochL       = Math.min(...recentPrices);
  const stoch = stochH === stochL ? 50 :
    parseFloat(((prices[n-1] - stochL) / (stochH - stochL) * 100).toFixed(1));
  const wr = stochH === stochL ? -50 :
    parseFloat(((stochH - prices[n-1]) / (stochH - stochL) * -100).toFixed(1));

  // ── Price position in fetch ──────────────────────────────────
  const fetchH   = Math.max(...prices);
  const fetchL   = Math.min(...prices);
  const pricePos = fetchH === fetchL ? 50 :
    parseFloat(((prices[n-1] - fetchL) / (fetchH - fetchL) * 100).toFixed(1));

  // ── CANDLE STRUCTURE (wick / body analysis) ──────────────────
  // This is the #1 predictor of next-candle direction in OTC markets.
  const openP  = prices[0];          // candle open
  const closeP = prices[n - 1];      // candle close
  const highP  = fetchH;
  const lowP   = fetchL;
  const range  = highP - lowP || 0.01;
  const bodyTop    = Math.max(openP, closeP);
  const bodyBot    = Math.min(openP, closeP);
  const upperWick  = (highP - bodyTop)  / range;   // wick above body (0-1)
  const lowerWick  = (bodyBot - lowP)   / range;   // wick below body (0-1)
  const bodySize   = (bodyTop - bodyBot) / range;  // body size (0-1)
  const bodyDir    = closeP > openP ? 'UP' : closeP < openP ? 'DOWN' : 'FLAT';

  // ── 15-second quadrant analysis ──────────────────────────────
  const qSz = Math.max(Math.floor(n / 4), 3);
  const quads = {
    q1:    linSlope(prices.slice(0, qSz)),
    q2:    linSlope(prices.slice(qSz, qSz * 2)),
    q3:    linSlope(prices.slice(qSz * 2, qSz * 3)),
    q4:    linSlope(prices.slice(qSz * 3))
  };
  quads.accel = quads.q4 - quads.q1;

  // ── Micro liquidity sweep ────────────────────────────────────
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
    rsi, bb, stoch, wr, pricePos, sweep, quads,
    // candle structure
    wick: { upperWick, lowerWick, bodySize, bodyDir, openP, closeP, highP, lowP },
    firstPrice: prices[0],
    lastPrice:  prices[n - 1],
    n
  };
}

// ── 15-Second candle trend ───────────────────────────────────────
function calc15sTrend(candles15s) {
  if (!candles15s || candles15s.length < 4)
    return { trend: 'FLAT', strength: 0, avgSlope: 0 };

  const recent  = candles15s.slice(-Math.min(16, candles15s.length));
  const slopes  = recent.map(c => c.slope || 0);
  const avgAll  = avg(slopes);
  const avgLast = avg(slopes.slice(-4));

  let up = 0, dn = 0;
  if (avgAll  >  0.2) up += 2; else if (avgAll  < -0.2) dn += 2;
  if      (avgLast >  0.35) up += 3;
  else if (avgLast >  0.15) up += 1;
  if      (avgLast < -0.35) dn += 3;
  else if (avgLast < -0.15) dn += 1;

  const upCnt = slopes.filter(s => s >  0.1).length;
  const dnCnt = slopes.filter(s => s < -0.1).length;
  if (upCnt > dnCnt + 4) up += 2;
  if (dnCnt > upCnt + 4) dn += 2;

  const lastC = recent[recent.length - 1];
  if (lastC && lastC.rsi != null) {
    if      (lastC.rsi < 30) up += 1;
    else if (lastC.rsi > 70) dn += 1;
  }

  const strength = Math.abs(up - dn);
  if (up > dn && strength >= 2) return { trend: 'UP',   strength, avgSlope: avgAll };
  if (dn > up && strength >= 2) return { trend: 'DOWN', strength, avgSlope: avgAll };
  return { trend: 'FLAT', strength: 0, avgSlope: avgAll };
}

// ── 5-Min HTF using stored 1-min candle slopes ───────────────────
function calc5MinTrend(candles1m) {
  if (!candles1m || candles1m.length < 3) return { trend: 'FLAT', strength: 0 };

  const recent  = candles1m.slice(-Math.min(10, candles1m.length));
  const slopes  = recent.map(c => c.slope || 0);
  const avgAll  = avg(slopes);
  const avgLast = avg(slopes.slice(-5));

  let up = 0, dn = 0;
  if (avgAll  >  0.2) up += 2; else if (avgAll  < -0.2) dn += 2;
  if (avgLast >  0.3) up += 2; else if (avgLast < -0.3) dn += 2;

  const upCnt = slopes.filter(s => s >  0.1).length;
  const dnCnt = slopes.filter(s => s < -0.1).length;
  if (upCnt > dnCnt + 2) up += 2;
  if (dnCnt > upCnt + 2) dn += 2;

  const strength = Math.abs(up - dn);
  if (up > dn && strength >= 2) return { trend: 'UP',   strength, avgSlope: avgAll };
  if (dn > up && strength >= 2) return { trend: 'DOWN', strength, avgSlope: avgAll };
  return { trend: 'FLAT', strength: 0, avgSlope: avgAll };
}

// ── Count consecutive same-direction 1M candles ──────────────────
function countConsecutive(candles1m) {
  if (!candles1m || candles1m.length < 2) return { up: 0, dn: 0 };
  const slopes = candles1m.slice(-6).map(c => c.slope || 0);
  let up = 0, dn = 0;
  for (let i = slopes.length - 1; i >= 0; i--) {
    if (slopes[i] >  0.12) up++; else break;
  }
  for (let i = slopes.length - 1; i >= 0; i--) {
    if (slopes[i] < -0.12) dn++; else break;
  }
  return { up, dn };
}

// ── Core signal: OTC NEXT-CANDLE PREDICTION ──────────────────────
// v4.0 — predicts the NEXT candle direction by reading the CURRENT
// candle's exhaustion and structure, not just its slope direction.
function calcRawSignal(analysis, svgHistory, candles1m, candles15s) {
  if (!analysis) {
    return { signal: 'WAIT', confidence: 0, reason: 'Collecting data...',
             votes: { up: 0, dn: 0, total: 0, margin: 0 }, reasons: [] };
  }

  let up = 0, dn = 0;
  const reasons = [];

  const sf  = analysis.slopeFull;
  const q4  = analysis.quads ? analysis.quads.q4 : 0;
  const rsi = analysis.rsi;
  const st  = analysis.stoch;
  const pp  = analysis.pricePos;   // 0=bottom, 100=top of candle range

  // ══════════════════════════════════════════════════════════════
  // TIER 1 — CANDLE STRUCTURE (OTC's primary reversal signals)
  // ══════════════════════════════════════════════════════════════

  // ── 1. WICK ANALYSIS ─────────────────────────────────────────
  // Long upper wick = price rejected at high → SELL next candle
  // Long lower wick = price rejected at low  → BUY next candle
  const { upperWick, lowerWick, bodySize, bodyDir } = analysis.wick || {};
  if (upperWick != null) {
    if (upperWick > 0.40) {
      dn += 5; reasons.push(`Long upper wick ${(upperWick*100).toFixed(0)}% → reversal`);
    } else if (upperWick > 0.25) {
      dn += 3; reasons.push('Upper wick → bearish');
    } else if (upperWick > 0.15) {
      dn += 1;
    }
    if (lowerWick > 0.40) {
      up += 5; reasons.push(`Long lower wick ${(lowerWick*100).toFixed(0)}% → reversal`);
    } else if (lowerWick > 0.25) {
      up += 3; reasons.push('Lower wick → bullish');
    } else if (lowerWick > 0.15) {
      up += 1;
    }
  }

  // ── 2. PRICE EXHAUSTION ──────────────────────────────────────
  // Price near the TOP with overbought oscillators = reversal imminent.
  // Price near the BOTTOM with oversold oscillators = bounce imminent.
  if (pp >= 85) {
    if      ((rsi != null && rsi > 72) || st > 80) { dn += 5; reasons.push(`Exhaustion TOP ${pp.toFixed(0)}%`); }
    else if (pp >= 90)                               { dn += 3; reasons.push(`Near TOP ${pp.toFixed(0)}%`); }
    else                                             { dn += 2; }
  } else if (pp >= 75 && (rsi != null && rsi > 68)) {
    dn += 2;
  }

  if (pp <= 15) {
    if      ((rsi != null && rsi < 28) || st < 20) { up += 5; reasons.push(`Exhaustion BOT ${pp.toFixed(0)}%`); }
    else if (pp <= 10)                               { up += 3; reasons.push(`Near BOT ${pp.toFixed(0)}%`); }
    else                                             { up += 2; }
  } else if (pp <= 25 && (rsi != null && rsi < 32)) {
    up += 2;
  }

  // ── 3. Q4 REVERSAL DETECTION ─────────────────────────────────
  // If the current candle was going UP but Q4 slope turned DOWN →
  // the candle is ALREADY reversing → strong SELL for next candle.
  // If the candle was going DOWN but Q4 turned UP → strong BUY.
  if (sf > 0.4 && q4 < -0.3) {
    dn += 5; reasons.push('Candle turning DN in close (Q4 reversal)');
  } else if (sf > 0.2 && q4 < -0.2) {
    dn += 3; reasons.push('Q4 momentum shift DN');
  }
  if (sf < -0.4 && q4 > 0.3) {
    up += 5; reasons.push('Candle turning UP in close (Q4 reversal)');
  } else if (sf < -0.2 && q4 > 0.2) {
    up += 3; reasons.push('Q4 momentum shift UP');
  }

  // Q4 continuation: candle still going same direction at close
  // → weaker signal but valid for strong trends
  if (q4 > 0.7 && sf > 0.3) { up += 2; reasons.push('Strong Q4 close UP'); }
  else if (q4 > 0.4 && sf > 0.2) up += 1;
  if (q4 < -0.7 && sf < -0.3) { dn += 2; reasons.push('Strong Q4 close DN'); }
  else if (q4 < -0.4 && sf < -0.2) dn += 1;

  // ── 4. CONSECUTIVE CANDLE EXHAUSTION ─────────────────────────
  // In OTC markets: 3+ consecutive same-direction candles → high
  // probability of reversal on the next candle.
  const { up: consecUp, dn: consecDn } = countConsecutive(candles1m);
  if (consecUp >= 4) {
    dn += 5; reasons.push(`${consecUp} consec UP → reversal due`);
  } else if (consecUp >= 3) {
    dn += 3; reasons.push(`${consecUp} consec UP → watch reversal`);
  } else if (consecUp === 2) {
    dn += 1;
  }
  if (consecDn >= 4) {
    up += 5; reasons.push(`${consecDn} consec DN → reversal due`);
  } else if (consecDn >= 3) {
    up += 3; reasons.push(`${consecDn} consec DN → watch reversal`);
  } else if (consecDn === 2) {
    up += 1;
  }

  // ══════════════════════════════════════════════════════════════
  // TIER 2 — OSCILLATOR CONFIRMATION
  // ══════════════════════════════════════════════════════════════

  // ── 5. RSI EXTREMES ──────────────────────────────────────────
  if (rsi !== null) {
    if      (rsi < 20) { up += 3; reasons.push('RSI extreme OS ' + rsi); }
    else if (rsi < 30) { up += 2; reasons.push('RSI oversold '   + rsi); }
    else if (rsi < 40)   up += 1;
    if      (rsi > 80) { dn += 3; reasons.push('RSI extreme OB ' + rsi); }
    else if (rsi > 70) { dn += 2; reasons.push('RSI overbought ' + rsi); }
    else if (rsi > 60)   dn += 1;
  }

  // ── 6. STOCHASTIC EXTREMES ───────────────────────────────────
  if      (st < 20) { up += 2; reasons.push('Stoch OS ' + st); }
  else if (st < 30)   up += 1;
  if      (st > 80) { dn += 2; reasons.push('Stoch OB ' + st); }
  else if (st > 70)   dn += 1;

  // ── 7. BOLLINGER BANDS ───────────────────────────────────────
  if (analysis.bb.pos === 'BELOW') { up += 2; reasons.push('Below BB lower'); }
  if (analysis.bb.pos === 'ABOVE') { dn += 2; reasons.push('Above BB upper'); }

  // ── 8. SVG HISTORY TREND PERSISTENCE ────────────────────────
  // Consistent multi-fetch trend over ~60 s (reliable same-frame data)
  const hist = svgHistory || [];
  if (hist.length >= 8) {
    const h15  = hist.slice(-15);
    const h8   = hist.slice(-8);
    const up15 = h15.filter(h => h.slopeFull >  0.15).length;
    const dn15 = h15.filter(h => h.slopeFull < -0.15).length;
    const up8  = h8.filter(h  => h.slopeFull >  0.10).length;
    const dn8  = h8.filter(h  => h.slopeFull < -0.10).length;
    if      (up15 >= 11) { up += 2; reasons.push(up15 + '/15 fetches UP'); }
    else if (up8  >=  6) { up += 1; }
    if      (dn15 >= 11) { dn += 2; reasons.push(dn15 + '/15 fetches DN'); }
    else if (dn8  >=  6) { dn += 1; }
  }

  // ══════════════════════════════════════════════════════════════
  // TIER 3 — TIMEFRAME ALIGNMENT (boost / filter)
  // ══════════════════════════════════════════════════════════════

  // ── 9. 5M HTF ────────────────────────────────────────────────
  const htf = calc5MinTrend(candles1m);
  let htfBoost = 0, htfBlock = false;
  if (htf.trend !== 'FLAT') {
    const goUp = up > dn, goDn = dn > up;
    if (htf.trend === 'UP'   && goUp) { up += 3; htfBoost = 3; reasons.push('5M UP aligns'); }
    if (htf.trend === 'DOWN' && goDn) { dn += 3; htfBoost = 3; reasons.push('5M DN aligns'); }
    // Block strong counter-trend unless a sweep is present
    if (htf.trend === 'UP'   && goDn && !analysis.sweep) htfBlock = true;
    if (htf.trend === 'DOWN' && goUp && !analysis.sweep) htfBlock = true;
  }

  // ── 10. 15s MICRO TREND ──────────────────────────────────────
  const trend15s = calc15sTrend(candles15s);
  if (trend15s.trend !== 'FLAT') {
    if (trend15s.trend === 'UP'   && up  > dn) { up += 2; reasons.push('15s micro UP'); }
    if (trend15s.trend === 'DOWN' && dn  > up) { dn += 2; reasons.push('15s micro DN'); }
    // Triple alignment: 5M + 1M structure + 15s micro all agree
    if (htf.trend === 'UP'   && trend15s.trend === 'UP'   && up > dn) {
      up += 3; reasons.push('✅ 5M+1M+15s ALL UP');
    }
    if (htf.trend === 'DOWN' && trend15s.trend === 'DOWN' && dn > up) {
      dn += 3; reasons.push('✅ 5M+1M+15s ALL DN');
    }
  }

  // ── 11. LIQUIDITY SWEEP ──────────────────────────────────────
  // Strong reversal override — highly reliable within-fetch signal
  if (analysis.sweep) {
    if (analysis.sweep.bias > 0) { up += 4; reasons.push(analysis.sweep.reason); }
    else                          { dn += 4; reasons.push(analysis.sweep.reason); }
  }

  // ══════════════════════════════════════════════════════════════
  // DECISION
  // ══════════════════════════════════════════════════════════════
  const total  = up + dn;
  const margin = Math.abs(up - dn);
  // hasDir: we have a clear structural signal (not just noise)
  const hasDir = upperWick > 0.15 || lowerWick > 0.15 ||
                 pp > 75 || pp < 25 || Math.abs(q4) > 0.3 ||
                 consecUp >= 2 || consecDn >= 2;

  const strongEnough =
    (margin >= 5 && total >= 8)                      ||
    (margin >= 4 && total >= 7 && hasDir)             ||
    (analysis.sweep !== null && margin >= 3);

  let rawSignal = 'WAIT', rawConf = 0;
  if (!htfBlock && strongEnough && up > dn) {
    rawSignal = 'BUY';
    rawConf   = clamp(52 + margin * 3.5 + htfBoost, 0, 93);
  }
  if (!htfBlock && strongEnough && dn > up) {
    rawSignal = 'SELL';
    rawConf   = clamp(52 + margin * 3.5 + htfBoost, 0, 93);
  }

  return {
    signal:           rawSignal,
    confidence:       rawConf,
    rsi,
    stoch:            analysis.stoch,
    wr:               analysis.wr,
    bbPos:            analysis.bb.pos,
    bbSqueeze:        analysis.bb.squeeze,
    emaTrend:         sf >  0.2 ? 'bullish' : sf < -0.2 ? 'bearish' : 'neutral',
    sweep:            analysis.sweep ? analysis.sweep.type : null,
    htfTrend:         htf.trend,
    htfStrength:      htf.strength,
    htfBlocked:       htfBlock,
    trend15s:         trend15s.trend,
    trend15sStrength: trend15s.strength,
    votes:            { up, dn, total, margin },
    reasons:          reasons.slice(0, 9),
    quads:            analysis.quads || null
  };
}

// ── Confirmation ─────────────────────────────────────────────────
const signalHistory = {};
const confirmedSig  = {};

function calculateOTCSignal(symbol, svgHistory, candles1m, candles15s) {
  if (!signalHistory[symbol]) signalHistory[symbol] = [];
  if (!confirmedSig[symbol])
    confirmedSig[symbol] = { signal: 'WAIT', confidence: 0, isConfirmed: false };

  const currentAnalysis = svgHistory && svgHistory.length > 0
    ? svgHistory[svgHistory.length - 1] : null;

  const raw  = calcRawSignal(currentAnalysis, svgHistory, candles1m, candles15s || []);
  const hist = signalHistory[symbol];

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
      confirmedSig[symbol] = {
        signal:      raw.signal,
        confidence:  Math.min(95, raw.confidence + 5),
        isConfirmed: true
      };
    } else if (same5) {
      confirmedSig[symbol] = {
        signal:      last5[0],
        confidence:  Math.min(93, raw.confidence + 8),
        isConfirmed: true
      };
    } else if (same3 && raw.confidence >= 70) {
      confirmedSig[symbol] = {
        signal:      last3[0],
        confidence:  raw.confidence,
        isConfirmed: true
      };
    } else if (allW5) {
      confirmedSig[symbol] = { signal: 'WAIT', confidence: 0, isConfirmed: false };
    } else if (prev.isConfirmed && same3 && last3[0] !== 'WAIT' && last3[0] !== prev.signal) {
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

module.exports = { calculateOTCSignal, analyzeCurrentFetch, calc5MinTrend, calc15sTrend };
