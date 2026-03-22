// ============================================================
// RK DXB Trader — Signal Engine
// Real market logic: 10 indicators + candle patterns
// ============================================================

// ── Helpers ─────────────────────────────────────────────────

function avg(arr) {
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

function stddev(arr) {
  const m = avg(arr);
  return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / arr.length);
}

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
  return 100 - (100 / (1 + rs));
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
  const ema12 = calcEMA(closes, 12);
  const ema26 = calcEMA(closes, 26);
  if (!ema12 || !ema26) return null;
  const macdLine = ema12 - ema26;
  // Signal line = EMA9 of MACD values — approximate with last values
  const macdValues = [];
  for (let i = 26; i <= closes.length; i++) {
    const e12 = calcEMA(closes.slice(0, i), 12);
    const e26 = calcEMA(closes.slice(0, i), 26);
    if (e12 && e26) macdValues.push(e12 - e26);
  }
  if (macdValues.length < 9) return { macd: macdLine, signal: null, hist: null };
  const signal = calcEMA(macdValues, 9);
  return { macd: macdLine, signal, hist: macdLine - signal };
}

// ── Stochastic(14,3) ────────────────────────────────────────
function calcStoch(highs, lows, closes, kPeriod = 14, dPeriod = 3) {
  if (closes.length < kPeriod + dPeriod) return null;
  const kValues = [];
  for (let i = kPeriod - 1; i < closes.length; i++) {
    const slice_h = highs.slice(i - kPeriod + 1, i + 1);
    const slice_l = lows.slice(i - kPeriod + 1, i + 1);
    const highest = Math.max(...slice_h);
    const lowest = Math.min(...slice_l);
    if (highest === lowest) { kValues.push(50); continue; }
    kValues.push(((closes[i] - lowest) / (highest - lowest)) * 100);
  }
  const k = avg(kValues.slice(-dPeriod));
  const d = kValues.length >= dPeriod * 2
    ? avg(kValues.slice(-dPeriod * 2, -dPeriod))
    : k;
  return { k, d };
}

// ── Williams %R(14) ─────────────────────────────────────────
function calcWR(highs, lows, closes, period = 14) {
  if (closes.length < period) return null;
  const h = Math.max(...highs.slice(-period));
  const l = Math.min(...lows.slice(-period));
  if (h === l) return -50;
  return ((h - closes[closes.length - 1]) / (h - l)) * -100;
}

// ── CCI(20) ─────────────────────────────────────────────────
function calcCCI(highs, lows, closes, period = 20) {
  if (closes.length < period) return null;
  const typical = closes.map((c, i) => (highs[i] + lows[i] + c) / 3);
  const slice = typical.slice(-period);
  const m = avg(slice);
  const meanDev = avg(slice.map(v => Math.abs(v - m)));
  if (meanDev === 0) return 0;
  return (slice[slice.length - 1] - m) / (0.015 * meanDev);
}

// ── Candle Pattern Detection ─────────────────────────────────
function detectPattern(candles) {
  if (candles.length < 3) return { name: 'none', bias: 0 };
  const c = candles[candles.length - 1]; // current
  const p = candles[candles.length - 2]; // previous
  const p2 = candles[candles.length - 3]; // 2 bars ago

  const body = Math.abs(c.close - c.open);
  const range = c.high - c.low;
  const bodyRatio = range > 0 ? body / range : 0;
  const upperWick = c.high - Math.max(c.open, c.close);
  const lowerWick = Math.min(c.open, c.close) - c.low;
  const isBullish = c.close > c.open;
  const isBearish = c.close < c.open;
  const pBullish = p.close > p.open;
  const pBearish = p.close < p.open;
  const pBody = Math.abs(p.close - p.open);

  // Doji
  if (bodyRatio < 0.1) return { name: 'doji', bias: 0 };

  // Hammer (bullish reversal) — small body top, long lower wick
  if (lowerWick > body * 2 && upperWick < body * 0.5 && isBullish)
    return { name: 'hammer', bias: 1 };

  // Shooting Star (bearish reversal) — small body bottom, long upper wick
  if (upperWick > body * 2 && lowerWick < body * 0.5 && isBearish)
    return { name: 'shooting_star', bias: -1 };

  // Bullish Engulfing
  if (pBearish && isBullish && c.open < p.close && c.close > p.open && body > pBody)
    return { name: 'bullish_engulfing', bias: 2 };

  // Bearish Engulfing
  if (pBullish && isBearish && c.open > p.close && c.close < p.open && body > pBody)
    return { name: 'bearish_engulfing', bias: -2 };

  // Bullish Pin Bar
  if (lowerWick > range * 0.6 && body < range * 0.3)
    return { name: 'pin_bar_bull', bias: 1 };

  // Bearish Pin Bar
  if (upperWick > range * 0.6 && body < range * 0.3)
    return { name: 'pin_bar_bear', bias: -1 };

  // Morning Star (3-candle bullish reversal)
  const p2Bearish = p2.close < p2.open;
  if (p2Bearish && bodyRatio < 0.3 && isBullish && c.close > (p2.open + p2.close) / 2)
    return { name: 'morning_star', bias: 2 };

  // Evening Star (3-candle bearish reversal)
  const p2Bullish = p2.close > p2.open;
  if (p2Bullish && bodyRatio < 0.3 && isBearish && c.close < (p2.open + p2.close) / 2)
    return { name: 'evening_star', bias: -2 };

  return { name: 'none', bias: 0 };
}

// ── Multi-Candle Logic ───────────────────────────────────────
function multiCandleAnalysis(candles) {
  if (candles.length < 6) return { streak: 0, reversal: false, bias: 0 };

  const last6 = candles.slice(-6);
  let bullStreak = 0, bearStreak = 0;

  for (let i = last6.length - 1; i >= 0; i--) {
    const c = last6[i];
    if (c.close > c.open) {
      if (bearStreak > 0) break;
      bullStreak++;
    } else {
      if (bullStreak > 0) break;
      bearStreak++;
    }
  }

  const streak = bullStreak || bearStreak;
  const isBull = bullStreak > 0;

  // 3+ same candles = trend continuation
  // 5+ same candles = REVERSAL warning
  let bias = 0;
  let reversal = false;

  if (streak >= 5) {
    reversal = true;
    bias = isBull ? -1 : 1; // extreme = reverse
  } else if (streak >= 3) {
    bias = isBull ? 1 : -1; // trend continuing
  }

  return { streak: isBull ? streak : -streak, reversal, bias };
}

// ── Volume Analysis ──────────────────────────────────────────
function volumeAnalysis(volumes) {
  if (volumes.length < 10) return { bias: 0, aboveAvg: false };
  const recent = volumes[volumes.length - 1];
  const avgVol = avg(volumes.slice(-20));
  const aboveAvg = recent > avgVol * 1.2;
  return { bias: aboveAvg ? 1 : 0, aboveAvg };
}

// ── EMA Trend System ─────────────────────────────────────────
function emaTrend(closes) {
  const ema8 = calcEMA(closes, 8);
  const ema21 = calcEMA(closes, 21);
  const ema55 = calcEMA(closes, 55);
  const ema200 = calcEMA(closes, 200);
  const price = closes[closes.length - 1];

  if (!ema8 || !ema21) return { bias: 0, trend: 'neutral', emas: {} };

  let score = 0;
  if (price > ema8) score++;
  if (price > ema21) score++;
  if (ema55 && price > ema55) score++;
  if (ema200 && price > ema200) score++;
  if (ema8 > ema21) score++;

  const bias = score >= 4 ? 1 : score <= 1 ? -1 : 0;
  const trend = bias === 1 ? 'bullish' : bias === -1 ? 'bearish' : 'neutral';

  return { bias, trend, score, emas: { ema8, ema21, ema55, ema200 } };
}

// ── MAIN SIGNAL CALCULATOR ──────────────────────────────────
function calculateSignal(candles) {
  if (!candles || candles.length < 30) {
    return { signal: 'WAIT', confidence: 0, reason: 'Not enough data' };
  }

  const closes = candles.map(c => c.close);
  const highs = candles.map(c => c.high);
  const lows = candles.map(c => c.low);
  const volumes = candles.map(c => c.volume || 0);

  // Calculate all indicators
  const rsi = calcRSI(closes);
  const bb = calcBB(closes);
  const macd = calcMACD(closes);
  const stoch = calcStoch(highs, lows, closes);
  const wr = calcWR(highs, lows, closes);
  const cci = calcCCI(highs, lows, closes);
  const pattern = detectPattern(candles);
  const multiCandle = multiCandleAnalysis(candles);
  const volume = volumeAnalysis(volumes);
  const ema = emaTrend(closes);

  let upVotes = 0, downVotes = 0;
  const reasons = [];

  // ── RSI vote ────────────────────────────────────────────────
  if (rsi !== null) {
    if (rsi < 30) { upVotes += 2; reasons.push(`RSI oversold ${rsi.toFixed(1)}`); }
    else if (rsi < 40) { upVotes += 1; reasons.push(`RSI low ${rsi.toFixed(1)}`); }
    else if (rsi > 70) { downVotes += 2; reasons.push(`RSI overbought ${rsi.toFixed(1)}`); }
    else if (rsi > 60) { downVotes += 1; reasons.push(`RSI high ${rsi.toFixed(1)}`); }
  }

  // ── EMA vote ────────────────────────────────────────────────
  if (ema.bias === 1) { upVotes += 2; reasons.push('EMA bullish stack'); }
  else if (ema.bias === -1) { downVotes += 2; reasons.push('EMA bearish stack'); }

  // ── BB vote ─────────────────────────────────────────────────
  if (bb) {
    const price = closes[closes.length - 1];
    if (price < bb.lower) { upVotes += 1; reasons.push('Below BB lower'); }
    else if (price > bb.upper) { downVotes += 1; reasons.push('Above BB upper'); }
    // BB squeeze = low volatility, breakout coming
    if (bb.width < 0.005) { reasons.push('BB squeeze'); }
  }

  // ── MACD vote ────────────────────────────────────────────────
  if (macd && macd.hist !== null) {
    if (macd.hist > 0 && macd.macd > 0) { upVotes += 1; reasons.push('MACD bullish'); }
    else if (macd.hist < 0 && macd.macd < 0) { downVotes += 1; reasons.push('MACD bearish'); }
    // Crossover (stronger signal)
    if (macd.hist > 0 && macd.signal < 0) { upVotes += 1; reasons.push('MACD crossover up'); }
    if (macd.hist < 0 && macd.signal > 0) { downVotes += 1; reasons.push('MACD crossover dn'); }
  }

  // ── Stochastic vote ──────────────────────────────────────────
  if (stoch) {
    if (stoch.k < 20 && stoch.k > stoch.d) { upVotes += 1; reasons.push('Stoch oversold+cross'); }
    else if (stoch.k < 20) { upVotes += 1; reasons.push('Stoch oversold'); }
    else if (stoch.k > 80 && stoch.k < stoch.d) { downVotes += 1; reasons.push('Stoch overbought+cross'); }
    else if (stoch.k > 80) { downVotes += 1; reasons.push('Stoch overbought'); }
  }

  // ── Williams %R vote ─────────────────────────────────────────
  if (wr !== null) {
    if (wr < -80) { upVotes += 1; reasons.push('W%R oversold'); }
    else if (wr > -20) { downVotes += 1; reasons.push('W%R overbought'); }
  }

  // ── CCI vote ─────────────────────────────────────────────────
  if (cci !== null) {
    if (cci < -100) { upVotes += 1; reasons.push(`CCI oversold ${cci.toFixed(0)}`); }
    else if (cci > 100) { downVotes += 1; reasons.push(`CCI overbought ${cci.toFixed(0)}`); }
  }

  // ── Candle Pattern vote ──────────────────────────────────────
  if (pattern.bias !== 0) {
    if (pattern.bias > 0) { upVotes += pattern.bias; reasons.push(`Pattern: ${pattern.name}`); }
    else { downVotes += Math.abs(pattern.bias); reasons.push(`Pattern: ${pattern.name}`); }
  }

  // ── Multi-candle vote ────────────────────────────────────────
  if (multiCandle.reversal) {
    if (multiCandle.bias === 1) { upVotes += 2; reasons.push(`Reversal after ${Math.abs(multiCandle.streak)} reds`); }
    else if (multiCandle.bias === -1) { downVotes += 2; reasons.push(`Reversal after ${multiCandle.streak} greens`); }
  } else if (multiCandle.bias !== 0) {
    if (multiCandle.bias === 1) { upVotes += 1; reasons.push(`${multiCandle.streak} candle bull streak`); }
    else { downVotes += 1; reasons.push(`${Math.abs(multiCandle.streak)} candle bear streak`); }
  }

  // ── Volume vote ──────────────────────────────────────────────
  if (volume.aboveAvg) {
    // Volume confirms the direction
    if (upVotes > downVotes) { upVotes += 1; reasons.push('High volume confirms UP'); }
    else if (downVotes > upVotes) { downVotes += 1; reasons.push('High volume confirms DN'); }
  }

  // ── Decision ─────────────────────────────────────────────────
  const totalVotes = upVotes + downVotes;
  const maxVotes = 20; // max possible
  const upPct = totalVotes > 0 ? (upVotes / (upVotes + downVotes)) * 100 : 50;

  // Need at least 6 total votes and clear majority (60%+)
  let signal = 'WAIT';
  let confidence = 0;

  if (totalVotes >= 5 && upPct >= 62) {
    signal = 'BUY';
    confidence = Math.min(95, Math.round(50 + (upPct - 50) * 1.5));
  } else if (totalVotes >= 5 && upPct <= 38) {
    signal = 'SELL';
    confidence = Math.min(95, Math.round(50 + (50 - upPct) * 1.5));
  }

  return {
    signal,
    confidence,
    upVotes,
    downVotes,
    rsi: rsi ? +rsi.toFixed(1) : null,
    stoch: stoch ? +stoch.k.toFixed(1) : null,
    macd: macd ? (macd.hist !== null ? (macd.hist > 0 ? 'UP' : 'DN') : null) : null,
    wr: wr !== null ? +wr.toFixed(1) : null,
    cci: cci !== null ? +cci.toFixed(1) : null,
    bbPos: bb ? (closes[closes.length - 1] < bb.lower ? 'BELOW' : closes[closes.length - 1] > bb.upper ? 'ABOVE' : 'MID') : null,
    emaTrend: ema.trend,
    pattern: pattern.name,
    streak: multiCandle.streak,
    reasons: reasons.slice(0, 5)
  };
}

module.exports = { calculateSignal };
