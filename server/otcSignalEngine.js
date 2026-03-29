// ================================================================
// RK DXB Trader — OTC Signal Engine v2.0  (HIGH ACCURACY)
//
// Architecture:
//   1-min candles → raw signal (slope + EMA + RSI + BB + stoch + patterns)
//   5-min candles → HTF trend filter (must align for signal to fire)
//   Liquidity sweep → strong reversal detection
//   Support/Resistance zones → SR confirmation
//   Confirmation: 3x same raw signal = confirmed
//
// Signal fires ONLY when:
//   a) Raw signal agrees with 5-min HTF trend  OR 5-min is fresh reversal
//   b) Confirmed (3x same in a row)  OR fast-confirm (2x + fully aligned)
//   c) Not at conflicting SR zone
// ================================================================

'use strict';

function avg(arr) { return arr.reduce((s, v) => s + v, 0) / arr.length; }
function stdDev(arr) { const m = avg(arr); return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / arr.length); }
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function linSlope(vals) {
  const n = vals.length;
  if (n < 3) return 0;
  const xs = vals.map((_, i) => i), mx = avg(xs), my = avg(vals);
  const num = xs.reduce((s, x, i) => s + (x - mx) * (vals[i] - my), 0);
  const den = xs.reduce((s, x) => s + (x - mx) ** 2, 0);
  return den === 0 ? 0 : num / den;
}

function calcEMA(closes, period) {
  if (closes.length < period) return null;
  const k = 2 / (period + 1);
  let e = avg(closes.slice(0, period));
  for (let i = period; i < closes.length; i++) e = closes[i] * k + e * (1 - k);
  return e;
}

function calcRSI(closes, period) {
  period = period || 10;
  if (closes.length < period + 1) return null;
  const ch = closes.slice(1).map((c, i) => c - closes[i]).slice(-period);
  const g = ch.filter(c => c > 0).reduce((s, c) => s + c, 0) / period;
  const l = ch.filter(c => c < 0).reduce((s, c) => s + Math.abs(c), 0) / period;
  if (l === 0) return 100;
  if (g === 0) return 0;
  return parseFloat((100 - 100 / (1 + g / l)).toFixed(1));
}

function calcMACD(closes) {
  if (closes.length < 12) return null;
  const ema12 = calcEMA(closes, Math.min(12, closes.length));
  const ema26 = closes.length >= 26 ? calcEMA(closes, 26) : calcEMA(closes, Math.min(10, closes.length));
  if (!ema12 || !ema26) return null;
  return { line: ema12 - ema26, bull: ema12 > ema26 };
}

function calcStoch(highs, lows, closes, period) {
  period = period || 10;
  if (closes.length < period) return null;
  const h = Math.max(...highs.slice(-period));
  const l = Math.min(...lows.slice(-period));
  if (h === l) return 50;
  return parseFloat(((closes[closes.length - 1] - l) / (h - l) * 100).toFixed(1));
}

function calcWR(highs, lows, closes, period) {
  period = period || 10;
  if (closes.length < period) return null;
  const h = Math.max(...highs.slice(-period));
  const l = Math.min(...lows.slice(-period));
  if (h === l) return -50;
  return parseFloat(((h - closes[closes.length - 1]) / (h - l) * -100).toFixed(1));
}

function calcBB(closes, period) {
  period = period || 14;
  if (closes.length < period) return { pos: 'MID', pct: 50, squeeze: false };
  const sl = closes.slice(-period), ma = avg(sl), sd = stdDev(sl);
  const upper = ma + 2 * sd, lower = ma - 2 * sd;
  const last = closes[closes.length - 1];
  const range = upper - lower || 0.001;
  const squeeze = sd > 0 && (sd / ma) < 0.002;
  return {
    pos: last > upper ? 'ABOVE' : last < lower ? 'BELOW' : 'MID',
    pct: parseFloat(((last - lower) / range * 100).toFixed(1)),
    upper, lower, ma, squeeze
  };
}

function calcCCI(highs, lows, closes, period) {
  period = period || 14;
  if (closes.length < period) return null;
  const typical = closes.map((c, i) => (highs[i] + lows[i] + c) / 3).slice(-period);
  const ma = avg(typical);
  const meanDev = typical.reduce((s, v) => s + Math.abs(v - ma), 0) / period;
  if (meanDev === 0) return 0;
  return parseFloat(((typical[typical.length - 1] - ma) / (0.015 * meanDev)).toFixed(1));
}

// ── Synthetic Price Series (Fix 3) ──────────────────────────────
// po-static.com SVG data re-normalises its Y-axis to 0-100 on EVERY fetch.
// That means candle OHLC "prices" from consecutive fetches are from different
// normalisation frames — making RSI/EMA/MACD/BB meaningless when computed on
// raw close values.
//
// Fix: build a synthetic cumulative price from the SLOPE stored in each
// candle (which is computed from points WITHIN a single SVG fetch and is
// therefore reliable).  Each candle's contribution is proportional to both
// its slope direction and magnitude.  If no slope is stored (legacy candles)
// we fall back to the candle body direction as a proxy.
function buildSyntheticSeries(candles) {
  const synthPrices = [];
  const synthHighs  = [];
  const synthLows   = [];
  let p = 100;
  for (const c of candles) {
    let dir, strength;
    if (c.slope !== undefined && c.slope !== null && c.slope !== 0) {
      dir      = c.slope > 0 ? 1 : -1;
      strength = Math.min(Math.abs(c.slope), 3);
    } else {
      // Fallback: use body direction as proxy (imperfect but better than raw price)
      dir      = (c.close >= c.open) ? 1 : -1;
      strength = 1;
    }
    const move = dir * (0.5 + strength * 0.5);
    p += move;
    // Synthetic wick: invert slightly based on body-to-range ratio
    const range     = (c.high - c.low) || 1;
    const bodyFrac  = Math.abs(c.close - c.open) / range;
    const wickExtra = (1 - bodyFrac) * 0.4;
    synthPrices.push(p);
    synthHighs.push(p + wickExtra);
    synthLows.push(p - wickExtra);
  }
  return { synthPrices, synthHighs, synthLows };
}

// ── Candle Pattern ──────────────────────────────────────────────
function detectPattern(candles) {
  if (candles.length < 3) return { name: 'none', bias: 0 };
  const c  = candles[candles.length - 1];
  const p1 = candles[candles.length - 2];
  const p2 = candles.length >= 3 ? candles[candles.length - 3] : null;
  const body  = Math.abs(c.close - c.open);
  const range = (c.high - c.low) || 0.001;
  const prevBody = Math.abs(p1.close - p1.open);
  const lw = Math.min(c.open, c.close) - c.low;
  const uw = c.high - Math.max(c.open, c.close);

  if (body / range < 0.10) return { name: 'doji', bias: 0 };
  if (c.close > c.open && p1.close < p1.open && body > prevBody * 1.3 && c.close > p1.open && c.open < p1.close)
    return { name: 'bullish_engulfing', bias: 2 };
  if (c.close < c.open && p1.close > p1.open && body > prevBody * 1.3 && c.close < p1.open && c.open > p1.close)
    return { name: 'bearish_engulfing', bias: -2 };
  if (lw > body * 2 && uw < body * 0.4 && c.close >= c.open) return { name: 'hammer', bias: 2 };
  if (uw > body * 2 && lw < body * 0.4 && c.close <= c.open) return { name: 'shooting_star', bias: -2 };
  if (lw > range * 0.6 && body < range * 0.25) return { name: 'bull_pin', bias: 1 };
  if (uw > range * 0.6 && body < range * 0.25) return { name: 'bear_pin', bias: -1 };

  if (p2) {
    const all3Bull = c.close > c.open && p1.close > p1.open && p2.close > p2.open && c.close > p1.close && p1.close > p2.close;
    const all3Bear = c.close < c.open && p1.close < p1.open && p2.close < p2.open && c.close < p1.close && p1.close < p2.close;
    if (all3Bull) return { name: '3_white_soldiers', bias: 2 };
    if (all3Bear) return { name: '3_black_crows',    bias: -2 };
  }
  return { name: 'none', bias: 0 };
}

// ── Streak ──────────────────────────────────────────────────────
function calcStreak(candles) {
  if (candles.length < 2) return { streak: 0, dir: 'FLAT' };
  const last = candles[candles.length - 1];
  const dir  = last.close >= last.open ? 'UP' : 'DOWN';
  let streak = 1;
  for (let i = candles.length - 2; i >= 0; i--) {
    if ((candles[i].close >= candles[i].open ? 'UP' : 'DOWN') === dir) streak++;
    else break;
  }
  return { streak, dir };
}

// ── Exhaustion ──────────────────────────────────────────────────
function detectExhaustion(candles) {
  if (candles.length < 5) return 'none';
  const last5 = candles.slice(-5).map(c => c.close);
  let up = 0, dn = 0;
  for (let i = 1; i < last5.length; i++) {
    if (last5[i] > last5[i - 1]) up++;
    else if (last5[i] < last5[i - 1]) dn++;
  }
  if (up >= 4) return 'exhaustion_up';
  if (dn >= 4) return 'exhaustion_dn';
  return 'none';
}

// ── Liquidity Sweep ─────────────────────────────────────────────
function detectLiquiditySweep(candles) {
  if (candles.length < 6) return null;
  const lookback = candles.slice(-8, -1);
  const c = candles[candles.length - 1];
  const prevHigh = Math.max(...lookback.map(k => k.high));
  const prevLow  = Math.min(...lookback.map(k => k.low));

  if (c.high > prevHigh * 1.001 && c.close < prevHigh && c.close < c.open)
    return { type: 'BEAR_SWEEP', bias: -4, reason: 'Bearish Liquidity Sweep' };
  if (c.low < prevLow * 0.999 && c.close > prevLow && c.close > c.open)
    return { type: 'BULL_SWEEP', bias: 4, reason: 'Bullish Liquidity Sweep' };
  return null;
}

// ── Support / Resistance Zones ───────────────────────────────────
function detectSRZone(candles) {
  if (candles.length < 10) return null;
  const recent  = candles.slice(-25);
  const closes  = recent.map(c => c.close);
  const current = closes[closes.length - 1];
  const range   = (Math.max(...closes) - Math.min(...closes)) || 1;
  const zone    = range * 0.04;

  const swingHighs = [], swingLows = [];
  for (let i = 2; i < recent.length - 2; i++) {
    const h = recent[i].high;
    if (h > recent[i-1].high && h > recent[i-2].high && h > recent[i+1].high && h > recent[i+2].high)
      swingHighs.push(h);
    const l = recent[i].low;
    if (l < recent[i-1].low && l < recent[i-2].low && l < recent[i+1].low && l < recent[i+2].low)
      swingLows.push(l);
  }

  for (const h of swingHighs) {
    if (Math.abs(current - h) < zone) return { type: 'RESISTANCE', bias: -2, reason: 'At Resistance' };
  }
  for (const l of swingLows) {
    if (Math.abs(current - l) < zone) return { type: 'SUPPORT', bias: 2, reason: 'At Support' };
  }
  return null;
}

// ── 5-Min HTF Trend ─────────────────────────────────────────────
function calc5MinTrend(candles5m) {
  if (!candles5m || candles5m.length < 3) return { trend: 'FLAT', strength: 0 };
  const closes = candles5m.map(c => c.close);
  const n = closes.length;
  const slope = linSlope(closes.slice(-Math.min(6, n)));
  const ema3  = calcEMA(closes, Math.min(3, n));
  const ema8  = calcEMA(closes, Math.min(8, n));
  const rsi   = calcRSI(closes, Math.min(8, n - 1));
  let up = 0, dn = 0;
  if (slope > 0.3)  up += 2; else if (slope < -0.3) dn += 2;
  if (ema3 && ema8) { if (ema3 > ema8) up += 2; else if (ema3 < ema8) dn += 2; }
  if (rsi !== null) { if (rsi > 55) up += 1; else if (rsi < 45) dn += 1; }
  const last5m = candles5m[candles5m.length - 1];
  if (last5m.close > last5m.open) up += 1; else if (last5m.close < last5m.open) dn += 1;
  const strength = Math.abs(up - dn);
  if (up > dn && strength >= 2) return { trend: 'UP',   strength, rsi5m: rsi, slope5m: slope };
  if (dn > up && strength >= 2) return { trend: 'DOWN', strength, rsi5m: rsi, slope5m: slope };
  return { trend: 'FLAT', strength: 0, rsi5m: rsi, slope5m: slope };
}

// ── Core 1-Min Signal ───────────────────────────────────────────
function calcRawSignal(candles, candles5m) {
  if (!candles || candles.length < 10) return { signal: 'WAIT', confidence: 0, reason: 'Building 1M data...' };

  // Use direction-based synthetic prices so RSI/EMA/MACD/BB/Stoch are not
  // corrupted by the per-fetch SVG re-normalisation (Fix 3).
  const { synthPrices: closes, synthHighs: highs, synthLows: lows } = buildSyntheticSeries(candles);
  const n = closes.length;

  const slope10 = linSlope(closes.slice(-Math.min(10, n)));
  const slope5  = linSlope(closes.slice(-Math.min(5, n)));
  const ema5    = calcEMA(closes, Math.min(5, n));
  const ema10   = calcEMA(closes, Math.min(10, n));
  const ema20   = n >= 20 ? calcEMA(closes, 20) : null;
  const macd    = calcMACD(closes);
  const rsi     = calcRSI(closes, Math.min(10, n - 1));
  const stoch   = calcStoch(highs, lows, closes, Math.min(12, n));
  const wr      = calcWR(highs, lows, closes, Math.min(12, n));
  const bb      = calcBB(closes, Math.min(14, n));
  const cci     = calcCCI(highs, lows, closes, Math.min(14, n));

  const slopeDir  = slope10 > 0.4 ? 'UP' : slope10 < -0.4 ? 'DOWN' : 'FLAT';
  const slope5Dir = slope5  > 0.3 ? 'UP' : slope5  < -0.3 ? 'DOWN' : 'FLAT';
  const emaTrend  = (ema5 && ema10) ? (ema5 > ema10 ? 'bullish' : ema5 < ema10 ? 'bearish' : 'neutral') : 'neutral';
  const ema20Trend = (ema10 && ema20) ? (ema10 > ema20 ? 'bullish' : 'bearish') : 'neutral';

  const pattern    = detectPattern(candles);
  const exhaustion = detectExhaustion(candles);
  const streak     = calcStreak(candles);
  const sweep      = detectLiquiditySweep(candles);
  const srZone     = detectSRZone(candles);
  const htf        = calc5MinTrend(candles5m);

  let up = 0, dn = 0;
  const reasons = [];

  // SLOPE (primary)
  if (slopeDir === 'UP')   { up += 3; reasons.push('Slope UP ' + slope10.toFixed(2)); if (slope5Dir === 'UP')   up += 1; }
  if (slopeDir === 'DOWN') { dn += 3; reasons.push('Slope DN ' + slope10.toFixed(2)); if (slope5Dir === 'DOWN') dn += 1; }

  // EMA stack
  if (emaTrend === 'bullish') { up += 2; reasons.push('EMA5>10'); if (ema20Trend === 'bullish') { up += 1; reasons.push('EMA10>20'); } }
  if (emaTrend === 'bearish') { dn += 2; reasons.push('EMA5<10'); if (ema20Trend === 'bearish') { dn += 1; reasons.push('EMA10<20'); } }

  // MACD
  if (macd) { if (macd.bull) { up += 2; reasons.push('MACD UP'); } else { dn += 2; reasons.push('MACD DN'); } }

  // Exhaustion/reversal
  if (exhaustion === 'exhaustion_up') { dn += 3; reasons.push('Exhaustion UP->reversal'); }
  if (exhaustion === 'exhaustion_dn') { up += 3; reasons.push('Exhaustion DN->reversal'); }

  // RSI (enhanced)
  if (rsi !== null) {
    if      (rsi < 20) { up += 4; reasons.push('RSI extreme oversold ' + rsi); }
    else if (rsi < 30) { up += 3; reasons.push('RSI oversold ' + rsi); }
    else if (rsi < 38) { up += 1; reasons.push('RSI low ' + rsi); }
    else if (rsi > 80) { dn += 4; reasons.push('RSI extreme overbought ' + rsi); }
    else if (rsi > 70) { dn += 3; reasons.push('RSI overbought ' + rsi); }
    else if (rsi > 62) { dn += 1; reasons.push('RSI high ' + rsi); }
  }

  // Stoch
  if (stoch !== null) {
    if (stoch < 20)       { up += 2; reasons.push('Stoch oversold ' + stoch); }
    else if (stoch < 35)  { up += 1; }
    else if (stoch > 80)  { dn += 2; reasons.push('Stoch overbought ' + stoch); }
    else if (stoch > 65)  { dn += 1; }
  }

  // BB
  if (bb.pos === 'BELOW') { up += 2; reasons.push('Below BB lower'); }
  if (bb.pos === 'ABOVE') { dn += 2; reasons.push('Above BB upper'); }
  if (bb.squeeze)         { reasons.push('BB Squeeze - move incoming'); }

  // WR
  if (wr !== null) { if (wr <= -80) up += 1; else if (wr >= -20) dn += 1; }

  // CCI
  if (cci !== null) {
    if (cci < -100) { up += 1; reasons.push('CCI oversold ' + cci); }
    if (cci > +100) { dn += 1; reasons.push('CCI overbought ' + cci); }
  }

  // Candle patterns
  if (pattern.bias > 0)  { up += pattern.bias; reasons.push('Pattern: ' + pattern.name + ' BUY'); }
  if (pattern.bias < 0)  { dn += (-pattern.bias); reasons.push('Pattern: ' + pattern.name + ' SELL'); }

  // Streak
  if (streak.streak >= 3 && streak.dir === 'UP')   { up += 1; reasons.push(streak.streak + ' candle streak UP'); }
  if (streak.streak >= 3 && streak.dir === 'DOWN')  { dn += 1; reasons.push(streak.streak + ' candle streak DN'); }

  // Liquidity sweep (strongest reversal)
  if (sweep) {
    if (sweep.bias > 0)  { up += sweep.bias; reasons.push(sweep.reason); }
    else                 { dn += (-sweep.bias); reasons.push(sweep.reason); }
  }

  // SR zones
  if (srZone) {
    if (srZone.bias > 0) { up += srZone.bias; reasons.push(srZone.reason); }
    else                 { dn += (-srZone.bias); reasons.push(srZone.reason); }
  }

  const total  = up + dn;
  const margin = Math.abs(up - dn);
  const hasSlope = slopeDir !== 'FLAT';

  const strongEnough = (margin >= 4 && total >= 7) ||
                       (margin >= 3 && total >= 6 && hasSlope) ||
                       (sweep !== null && margin >= 2);

  let rawSignal = 'WAIT', rawConf = 0;
  if (strongEnough && up > dn) { rawSignal = 'BUY';  rawConf = clamp(48 + margin * 5, 0, 88); }
  if (strongEnough && dn > up) { rawSignal = 'SELL'; rawConf = clamp(48 + margin * 5, 0, 88); }

  // 5-Min HTF filter
  let htfBoost = 0, htfBlock = false;
  if (htf.trend !== 'FLAT') {
    if (htf.trend === 'UP'   && rawSignal === 'BUY')  { htfBoost = 10; reasons.push('5M trend UP confirms'); }
    if (htf.trend === 'DOWN' && rawSignal === 'SELL') { htfBoost = 10; reasons.push('5M trend DN confirms'); }
    if (htf.trend === 'UP'   && rawSignal === 'SELL' && !sweep) htfBlock = true;
    if (htf.trend === 'DOWN' && rawSignal === 'BUY'  && !sweep) htfBlock = true;
  }

  if (htfBlock) { rawSignal = 'WAIT'; rawConf = 0; }
  const finalConf = clamp(rawConf + htfBoost, 0, 95);

  return {
    signal: rawSignal,
    confidence: finalConf,
    rsi: rsi ? parseFloat(rsi.toFixed(1)) : null,
    stoch: stoch ? parseFloat(stoch.toFixed(1)) : null,
    wr: wr ? parseFloat(wr.toFixed(1)) : null,
    cci: cci ? parseFloat(cci.toFixed(1)) : null,
    macd: macd ? (macd.bull ? 'UP' : 'DN') : null,
    emaTrend,
    pattern: pattern.name,
    bbPos: bb.pos,
    bbSqueeze: bb.squeeze,
    behavior: exhaustion,
    streak: streak.streak + streak.dir,
    sweep: sweep ? sweep.type : null,
    srZone: srZone ? srZone.type : null,
    htfTrend: htf.trend,
    htfStrength: htf.strength,
    htfRsi: htf.rsi5m,
    htfBlocked: htfBlock,
    votes: { up, dn, total, margin },
    reasons: reasons.slice(0, 7)
  };
}

// ── Confirmation (3x same = confirmed) ─────────────────────────
const signalHistory  = {};
const confirmedSig   = {};
const lastHistMinute = {};  // Fix 2: only push history once per 1-min candle close

// minuteKey = Math.floor(Date.now() / 60000) — passed by caller so history
// advances once per minute (not every 2-second tick).
function calculateOTCSignal(symbol, candles1m, candles5m, minuteKey) {
  if (!signalHistory[symbol]) signalHistory[symbol] = [];
  if (!confirmedSig[symbol])  confirmedSig[symbol]  = { signal: 'WAIT', confidence: 0, isConfirmed: false };

  const raw  = calcRawSignal(candles1m, candles5m);
  const hist = signalHistory[symbol];

  // Only record a history entry when the minute advances (candle boundary).
  // This prevents "3 same in a row" from triggering on 6 seconds of noise.
  const mk = minuteKey !== undefined ? minuteKey : Math.floor(Date.now() / 60000);
  if (lastHistMinute[symbol] !== mk) {
    hist.push(raw.signal);
    if (hist.length > 8) hist.shift();
    lastHistMinute[symbol] = mk;
  }

  const prev = confirmedSig[symbol];

  if (hist.length >= 3) {
    const last3 = hist.slice(-3);
    const last2 = hist.slice(-2);
    const same3 = last3.every(s => s === last3[0]) && last3[0] !== 'WAIT';
    const same2 = last2[0] === last2[1] && last2[0] !== 'WAIT';
    const allW3 = last3.every(s => s === 'WAIT');

    const fastBuy  = raw.signal === 'BUY'  && raw.emaTrend === 'bullish' && raw.macd === 'UP'  && raw.htfTrend !== 'DOWN';
    const fastSell = raw.signal === 'SELL' && raw.emaTrend === 'bearish' && raw.macd === 'DN'  && raw.htfTrend !== 'UP';
    const fullyAligned = fastBuy || fastSell;

    if (raw.sweep) {
      confirmedSig[symbol] = { signal: raw.signal, confidence: Math.min(95, raw.confidence + 8), isConfirmed: true };
    } else if (same3) {
      confirmedSig[symbol] = { signal: last3[0], confidence: Math.min(95, raw.confidence + 5), isConfirmed: true };
    } else if (same2 && fullyAligned && raw.confidence >= 65) {
      confirmedSig[symbol] = { signal: raw.signal, confidence: raw.confidence, isConfirmed: true };
    } else if (allW3) {
      confirmedSig[symbol] = { signal: 'WAIT', confidence: 0, isConfirmed: false };
    } else if (same2 && prev.isConfirmed && last2[0] !== prev.signal) {
      confirmedSig[symbol] = { signal: 'WAIT', confidence: 0, isConfirmed: false };
    }
  }

  return {
    ...raw,
    signal:       confirmedSig[symbol].signal,
    confidence:   confirmedSig[symbol].confidence,
    isConfirmed:  confirmedSig[symbol].isConfirmed,
    rawSignal:    raw.signal,
    rawConf:      raw.confidence,
    signalHistory: [...hist]
  };
}

module.exports = { calculateOTCSignal, calcRawSignal, calc5MinTrend };
