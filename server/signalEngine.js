// ================================================================
// RK DXB Trader — Real Market Signal Engine v2.0
//
// CORE INSIGHT (v2.0 rewrite):
// v1.0 treated RSI < 30 as a strong BUY (+4 votes) regardless of
// trend — classic reversal thinking. On 1-minute real forex, this
// is WRONG most of the time: oversold can get more oversold in a
// trend. Meanwhile the EMA bias was only +2 votes — much too weak.
//
// v2.0 APPROACH — MOMENTUM + TREND ALIGNMENT:
//   For real forex 1-minute prediction the correct hierarchy is:
//
//   TIER 1 — EMA Trend (primary, 4-6 pts)
//     · Price vs EMA8/EMA21 → direction
//     · EMA8 slope (is momentum accelerating?)
//     · EMA8 > EMA21 cross state
//
//   TIER 2 — Momentum Confirmation (2-3 pts each)
//     · RSI DIRECTION (rising/falling), not just extremes
//     · MACD histogram sign + crossover
//     · Last 3-candle body direction majority
//
//   TIER 3 — Pattern / Candle Structure (1-2 pts)
//     · Engulfing, pin bar, morning/evening star, marubozu
//     · Consecutive streak continuation
//
//   TIER 4 — Mean Reversion Override
//     · BB below lower + RSI < 25 → extreme oversold bounce
//     · BB above upper + RSI > 75 → extreme overbought reversal
//     · Fires ONLY at true extremes (not at every RSI 30)
//
// KEY RULES:
//   · EMA trend is the primary filter — all other signals confirm it
//   · RSI direction (rising vs falling) matters, not just the level
//   · Mean reversion ONLY when BOTH BB extreme AND RSI extreme agree
// ================================================================

'use strict';

// ── Helpers ─────────────────────────────────────────────────
function avg(arr) { return arr.reduce((s, v) => s + v, 0) / arr.length; }
function stddev(arr) {
  const m = avg(arr);
  return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / arr.length);
}
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// ── RSI(14) ─────────────────────────────────────────────────
function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gains += d; else losses -= d;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + (d > 0 ? d : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (d < 0 ? -d : 0)) / period;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return parseFloat((100 - (100 / (1 + rs))).toFixed(1));
}

// RSI direction over last 3 bars (positive = rising)
function rsiSlope(closes, period = 14) {
  if (closes.length < period + 4) return 0;
  const rsiNow  = calcRSI(closes);
  const rsiPrev = calcRSI(closes.slice(0, -3));
  if (rsiNow === null || rsiPrev === null) return 0;
  return parseFloat((rsiNow - rsiPrev).toFixed(1));
}

// ── EMA ─────────────────────────────────────────────────────
function calcEMA(closes, period) {
  if (closes.length < period) return null;
  const k = 2 / (period + 1);
  let ema = avg(closes.slice(0, period));
  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * k + ema * (1 - k);
  }
  return ema;
}

// EMA slope over last N bars (% change, scale-independent)
function emaSlope(closes, period, bars = 5) {
  if (closes.length < period + bars) return 0;
  const now  = calcEMA(closes, period);
  const prev = calcEMA(closes.slice(0, -bars), period);
  if (!now || !prev || prev === 0) return 0;
  return parseFloat(((now - prev) / prev * 100).toFixed(4));
}

// ── Bollinger Bands(20,2) ───────────────────────────────────
function calcBB(closes, period = 20) {
  if (closes.length < period) return null;
  const slice = closes.slice(-period);
  const mid = avg(slice);
  const sd = stddev(slice);
  return { upper: mid + 2 * sd, mid, lower: mid - 2 * sd, width: (4 * sd) / mid };
}

// ── MACD(12,26,9) ───────────────────────────────────────────
function calcMACD(closes) {
  if (closes.length < 35) return null;
  const macdValues = [];
  for (let i = 26; i <= closes.length; i++) {
    const e12 = calcEMA(closes.slice(0, i), 12);
    const e26 = calcEMA(closes.slice(0, i), 26);
    if (e12 && e26) macdValues.push(e12 - e26);
  }
  if (macdValues.length < 9) return null;
  const macdLine = macdValues[macdValues.length - 1];
  const signal   = calcEMA(macdValues, 9);
  const hist     = signal ? macdLine - signal : null;
  // Histogram slope: is momentum strengthening or weakening?
  let histPrev = null;
  if (macdValues.length >= 12) {
    const mv2 = macdValues.slice(0, -3);
    const s2  = calcEMA(mv2, 9);
    if (s2) histPrev = mv2[mv2.length - 1] - s2;
  }
  return { macd: macdLine, signal, hist, histPrev };
}

// ── Stochastic(14,3) ────────────────────────────────────────
function calcStoch(highs, lows, closes, kPeriod = 14, dPeriod = 3) {
  if (closes.length < kPeriod + dPeriod) return null;
  const kValues = [];
  for (let i = kPeriod - 1; i < closes.length; i++) {
    const high  = Math.max(...highs.slice(i - kPeriod + 1, i + 1));
    const low   = Math.min(...lows.slice(i - kPeriod + 1, i + 1));
    const range = high - low;
    kValues.push(range === 0 ? 50 : ((closes[i] - low) / range) * 100);
  }
  const dValues = [];
  for (let i = dPeriod - 1; i < kValues.length; i++) {
    dValues.push(avg(kValues.slice(i - dPeriod + 1, i + 1)));
  }
  const k     = kValues[kValues.length - 1];
  const d     = dValues[dValues.length - 1];
  const kPrev = kValues.length > 3 ? kValues[kValues.length - 4] : k;
  return { k: parseFloat(k.toFixed(1)), d: parseFloat(d.toFixed(1)), kPrev };
}

// ── EMA Trend System ─────────────────────────────────────────
function emaTrend(closes) {
  const ema8   = calcEMA(closes, 8);
  const ema21  = calcEMA(closes, 21);
  const ema55  = calcEMA(closes, 55);
  const price  = closes[closes.length - 1];
  const slope8 = emaSlope(closes, 8,  4);
  const slope21= emaSlope(closes, 21, 6);

  if (!ema8 || !ema21) return { bias: 0, trend: 'neutral', score: 0, slope8: 0, slope21: 0 };

  let score = 0;
  if (price > ema8)   score += 2; else score -= 2;
  if (price > ema21)  score += 2; else score -= 2;
  if (ema55 && price > ema55) score += 1; else if (ema55) score -= 1;
  if (ema8  > ema21)  score += 3; else score -= 3;        // crossover = strongest
  if (slope8  >  0.002) score += 1; else if (slope8  < -0.002) score -= 1;
  if (slope21 >  0.001) score += 1; else if (slope21 < -0.001) score -= 1;

  const bias  = score >= 3 ? 1 : score <= -3 ? -1 : 0;
  const trend = bias === 1 ? 'bullish' : bias === -1 ? 'bearish' : 'neutral';
  return { bias, trend, score, slope8, slope21, ema8, ema21 };
}

// ── Recent 3 candle body bias ────────────────────────────────
function recentBodyBias(candles, n = 3) {
  const last = candles.slice(-n);
  let up = 0, dn = 0;
  for (const c of last) {
    if (c.close > c.open) up++;
    else if (c.close < c.open) dn++;
  }
  if (up === n) return { bias:  1, label: `${n}/${n} bullish candles` };
  if (dn === n) return { bias: -1, label: `${n}/${n} bearish candles` };
  if (up > dn)  return { bias:  0.5, label: `${up}/${n} bullish candles` };
  if (dn > up)  return { bias: -0.5, label: `${dn}/${n} bearish candles` };
  return { bias: 0, label: 'mixed candles' };
}

// ── Streak ──────────────────────────────────────────────────
function calcStreak(candles) {
  const last6 = candles.slice(-6);
  let bull = 0, bear = 0;
  for (let i = last6.length - 1; i >= 0; i--) {
    const c = last6[i];
    if (c.close > c.open) { if (bear > 0) break; bull++; }
    else { if (bull > 0) break; bear++; }
  }
  return bull > 0 ? bull : -bear;
}

// ── Candle pattern ──────────────────────────────────────────
function detectPattern(candles) {
  if (candles.length < 3) return { name: 'none', bias: 0 };
  const c  = candles[candles.length - 1];
  const p1 = candles[candles.length - 2];
  const p2 = candles[candles.length - 3];

  const range     = c.high - c.low || 0.0001;
  const body      = Math.abs(c.close - c.open);
  const bodyRatio = body / range;
  const upperWick = c.high  - Math.max(c.close, c.open);
  const lowerWick = Math.min(c.close, c.open) - c.low;
  const isBullish = c.close > c.open;
  const isBearish = c.close < c.open;
  const p1Body    = Math.abs(p1.close - p1.open);

  // Bullish Engulfing
  if (p1.close < p1.open && isBullish && c.open < p1.close && c.close > p1.open)
    return { name: 'bullish_engulfing', bias: 2 };

  // Bearish Engulfing
  if (p1.close > p1.open && isBearish && c.open > p1.close && c.close < p1.open)
    return { name: 'bearish_engulfing', bias: -2 };

  // Bullish Pin Bar / Hammer
  if (lowerWick > range * 0.55 && body < range * 0.35 && upperWick < range * 0.15)
    return { name: 'pin_bar_bull', bias: 2 };

  // Bearish Pin Bar / Shooting Star
  if (upperWick > range * 0.55 && body < range * 0.35 && lowerWick < range * 0.15)
    return { name: 'pin_bar_bear', bias: -2 };

  // Bullish Marubozu (strong momentum UP)
  if (isBullish && bodyRatio > 0.80 && body > p1Body * 1.2)
    return { name: 'bull_marubozu', bias: 1 };

  // Bearish Marubozu (strong momentum DN)
  if (isBearish && bodyRatio > 0.80 && body > p1Body * 1.2)
    return { name: 'bear_marubozu', bias: -1 };

  // Morning Star
  const p1Range = p1.high - p1.low || 0.0001;
  if (p2.close < p2.open && Math.abs(p1.close - p1.open) / p1Range < 0.3
      && isBullish && c.close > (p2.open + p2.close) / 2)
    return { name: 'morning_star', bias: 2 };

  // Evening Star
  if (p2.close > p2.open && Math.abs(p1.close - p1.open) / p1Range < 0.3
      && isBearish && c.close < (p2.open + p2.close) / 2)
    return { name: 'evening_star', bias: -2 };

  return { name: 'none', bias: 0 };
}

// ── MAIN SIGNAL CALCULATOR v2.0 ─────────────────────────────
function calculateSignal(candles) {
  if (!candles || candles.length < 30) {
    return { signal: 'WAIT', confidence: 0, reason: 'Not enough data' };
  }

  const closes = candles.map(c => c.close);
  const highs  = candles.map(c => c.high);
  const lows   = candles.map(c => c.low);
  const price  = closes[closes.length - 1];

  // Calculate all indicators
  const rsi     = calcRSI(closes);
  const rsiDir  = rsiSlope(closes);
  const bb      = calcBB(closes);
  const macd    = calcMACD(closes);
  const stoch   = calcStoch(highs, lows, closes);
  const ema     = emaTrend(closes);
  const pattern = detectPattern(candles);
  const body3   = recentBodyBias(candles, 3);
  const str     = calcStreak(candles);

  let up = 0, dn = 0;
  const reasons = [];

  // ════════════════════════════════════════════════════════
  // TIER 1 — EMA TREND (primary)
  // ════════════════════════════════════════════════════════
  if      (ema.score >= 6)  { up += 6; reasons.push('Strong EMA bullish stack'); }
  else if (ema.score >= 3)  { up += 4; reasons.push('EMA bullish'); }
  else if (ema.score >= 1)  { up += 2; }
  else if (ema.score <= -6) { dn += 6; reasons.push('Strong EMA bearish stack'); }
  else if (ema.score <= -3) { dn += 4; reasons.push('EMA bearish'); }
  else if (ema.score <= -1) { dn += 2; }

  // EMA8 slope acceleration
  if      (ema.slope8 >  0.008) { up += 2; reasons.push('EMA8 accelerating UP'); }
  else if (ema.slope8 >  0.003) { up += 1; }
  else if (ema.slope8 < -0.008) { dn += 2; reasons.push('EMA8 accelerating DN'); }
  else if (ema.slope8 < -0.003) { dn += 1; }

  // ════════════════════════════════════════════════════════
  // TIER 2 — MOMENTUM CONFIRMATION
  // ════════════════════════════════════════════════════════

  // RSI direction (v2.0 key change)
  if (rsi !== null) {
    if      (rsi > 55 && rsiDir >  3) { up += 3; reasons.push(`RSI ${rsi} rising`); }
    else if (rsi > 50 && rsiDir >  1) { up += 2; }
    else if (rsi > 50)                 { up += 1; }
    if      (rsi < 45 && rsiDir < -3) { dn += 3; reasons.push(`RSI ${rsi} falling`); }
    else if (rsi < 50 && rsiDir < -1) { dn += 2; }
    else if (rsi < 50)                 { dn += 1; }
  }

  // MACD histogram
  if (macd && macd.hist !== null) {
    if (macd.hist > 0 && macd.histPrev !== null && macd.hist > macd.histPrev) {
      up += 3; reasons.push('MACD momentum UP');
    } else if (macd.hist > 0) { up += 1; }
    if (macd.hist < 0 && macd.histPrev !== null && macd.hist < macd.histPrev) {
      dn += 3; reasons.push('MACD momentum DN');
    } else if (macd.hist < 0) { dn += 1; }
    if (macd.macd > 0) up += 1; else if (macd.macd < 0) dn += 1;
  }

  // Stochastic direction
  if (stoch) {
    const rising  = stoch.k > stoch.kPrev;
    const falling = stoch.k < stoch.kPrev;
    if      (stoch.k > 50 && rising  && stoch.k > stoch.d) { up += 2; reasons.push('Stoch bullish'); }
    else if (stoch.k > 50)                                   { up += 1; }
    if      (stoch.k < 50 && falling && stoch.k < stoch.d) { dn += 2; reasons.push('Stoch bearish'); }
    else if (stoch.k < 50)                                   { dn += 1; }
  }

  // Recent 3 candle bodies
  if      (body3.bias >=  1) { up += 3; reasons.push(body3.label); }
  else if (body3.bias >   0) { up += 1; }
  else if (body3.bias <= -1) { dn += 3; reasons.push(body3.label); }
  else if (body3.bias <   0) { dn += 1; }

  // ════════════════════════════════════════════════════════
  // TIER 3 — CANDLE PATTERN & STREAK
  // ════════════════════════════════════════════════════════
  if (pattern.bias > 0)  { up += pattern.bias; reasons.push(`Pattern: ${pattern.name}`); }
  if (pattern.bias < 0)  { dn += Math.abs(pattern.bias); reasons.push(`Pattern: ${pattern.name}`); }

  // Streak continuation (real markets trend)
  if      (str >= 4)  { up += 2; reasons.push(`${str} candle bull streak`); }
  else if (str >= 2)  { up += 1; }
  else if (str <= -4) { dn += 2; reasons.push(`${Math.abs(str)} candle bear streak`); }
  else if (str <= -2) { dn += 1; }

  // ════════════════════════════════════════════════════════
  // TIER 4 — EXTREME MEAN REVERSION OVERRIDE
  // ════════════════════════════════════════════════════════
  if (bb) {
    if (price < bb.lower && rsi !== null && rsi < 25) {
      up += 5; dn = Math.max(0, dn - 3);
      reasons.push(`Extreme oversold: BB+RSI ${rsi}`);
    }
    if (price > bb.upper && rsi !== null && rsi > 75) {
      dn += 5; up = Math.max(0, up - 3);
      reasons.push(`Extreme overbought: BB+RSI ${rsi}`);
    }
  }

  // ════════════════════════════════════════════════════════
  // DECISION
  // ════════════════════════════════════════════════════════
  const total  = up + dn;
  const margin = Math.abs(up - dn);
  const upPct  = total > 0 ? (up / total) * 100 : 50;
  const thresh = total >= 14 ? 55 : total >= 10 ? 58 : 62;

  let signal = 'WAIT', confidence = 0;
  if (total >= 6 && upPct >= thresh) {
    signal     = 'BUY';
    confidence = clamp(50 + margin * 2.5, 52, 92);
  } else if (total >= 6 && upPct <= (100 - thresh)) {
    signal     = 'SELL';
    confidence = clamp(50 + margin * 2.5, 52, 92);
  }

  return {
    signal,
    confidence,
    upVotes:   up,
    downVotes: dn,
    rsi,
    rsiDir:    rsiDir,
    stoch:     stoch ? stoch.k : null,
    macd:      macd  ? (macd.hist !== null ? (macd.hist > 0 ? 'UP' : 'DN') : null) : null,
    wr:        null,
    cci:       null,
    bbPos:     bb ? (price < bb.lower ? 'BELOW' : price > bb.upper ? 'ABOVE' : 'MID') : null,
    emaTrend:  ema.trend,
    pattern:   pattern.name,
    streak:    str,
    reasons:   reasons.slice(0, 5)
  };
}

module.exports = { calculateSignal };
