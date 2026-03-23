// ================================================================
// RK DXB Trader — OTC Signal Engine
// Purpose-built for PO SVG normalized price data (0.0 - 1.0 range)
// Uses percentage-change based indicators instead of absolute price
// ================================================================

// ── Math helpers ────────────────────────────────────────────
function avg(arr) { return arr.reduce((s, v) => s + v, 0) / arr.length; }

function stdDev(arr) {
  const m = avg(arr);
  return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / arr.length);
}

// ── RSI on normalized prices ─────────────────────────────────
// Standard RSI but works on pct changes between candles
function calcRSI(closes, period = 10) {
  if (closes.length < period + 1) return null;
  
  const changes = closes.slice(1).map((c, i) => c - closes[i]);
  const recent = changes.slice(-period);
  
  const gains = recent.filter(c => c > 0).reduce((s, c) => s + c, 0) / period;
  const losses = recent.filter(c => c < 0).reduce((s, c) => s + Math.abs(c), 0) / period;
  
  if (losses === 0) return 100;
  if (gains === 0) return 0;
  
  const rs = gains / losses;
  return parseFloat((100 - 100 / (1 + rs)).toFixed(1));
}

// ── EMA on normalized prices ─────────────────────────────────
function calcEMA(closes, period) {
  if (closes.length < period) return null;
  const k = 2 / (period + 1);
  let ema = avg(closes.slice(0, period));
  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * k + ema * (1 - k);
  }
  return ema;
}

// ── Stochastic ────────────────────────────────────────────────
function calcStoch(highs, lows, closes, period = 10) {
  if (closes.length < period) return null;
  const sliceH = highs.slice(-period);
  const sliceL = lows.slice(-period);
  const highH = Math.max(...sliceH);
  const lowL = Math.min(...sliceL);
  if (highH === lowL) return 50;
  const k = ((closes[closes.length - 1] - lowL) / (highH - lowL)) * 100;
  return parseFloat(k.toFixed(1));
}

// ── MACD ──────────────────────────────────────────────────────
function calcMACD(closes) {
  if (closes.length < 12) return null;
  const ema8 = calcEMA(closes, 8);
  const ema13 = calcEMA(closes, 13);
  if (!ema8 || !ema13) return null;
  return ema8 > ema13 ? 'UP' : 'DN';
}

// ── Williams %R ───────────────────────────────────────────────
function calcWR(highs, lows, closes, period = 10) {
  if (closes.length < period) return null;
  const sliceH = highs.slice(-period);
  const sliceL = lows.slice(-period);
  const highH = Math.max(...sliceH);
  const lowL = Math.min(...sliceL);
  if (highH === lowL) return -50;
  return parseFloat((((highH - closes[closes.length - 1]) / (highH - lowL)) * -100).toFixed(1));
}

// ── CCI ───────────────────────────────────────────────────────
function calcCCI(highs, lows, closes, period = 10) {
  if (closes.length < period) return null;
  const typicalPrices = closes.slice(-period).map((c, i) => {
    return (highs[highs.length - period + i] + lows[lows.length - period + i] + c) / 3;
  });
  const tp = typicalPrices[typicalPrices.length - 1];
  const ma = avg(typicalPrices);
  const md = avg(typicalPrices.map(p => Math.abs(p - ma)));
  if (md === 0) return 0;
  return parseFloat(((tp - ma) / (0.015 * md)).toFixed(1));
}

// ── Bollinger Bands ───────────────────────────────────────────
function calcBB(closes, period = 10, mult = 2) {
  if (closes.length < period) return { pos: 'MID', pct: 50 };
  const slice = closes.slice(-period);
  const ma = avg(slice);
  const sd = stdDev(slice);
  const upper = ma + mult * sd;
  const lower = ma - mult * sd;
  const last = closes[closes.length - 1];
  const range = upper - lower;
  const pct = range === 0 ? 50 : ((last - lower) / range) * 100;
  const pos = last > upper ? 'ABOVE' : last < lower ? 'BELOW' : 'MID';
  return { pos, pct: parseFloat(pct.toFixed(1)), upper, lower, ma, sd };
}

// ── Trend strength from consecutive closes ────────────────────
function calcStreak(closes) {
  if (closes.length < 2) return { streak: 0, dir: 'FLAT' };
  let streak = 1;
  const last = closes[closes.length - 1];
  const prev = closes[closes.length - 2];
  const dir = last > prev ? 'UP' : last < prev ? 'DOWN' : 'FLAT';
  
  for (let i = closes.length - 2; i > 0; i--) {
    if (dir === 'UP' && closes[i] > closes[i - 1]) streak++;
    else if (dir === 'DOWN' && closes[i] < closes[i - 1]) streak++;
    else break;
  }
  return { streak, dir };
}

// ── Candle pattern detection ─────────────────────────────────
function detectPattern(candles) {
  if (candles.length < 2) return 'none';
  const c = candles[candles.length - 1];
  const p = candles[candles.length - 2];
  
  const body = Math.abs(c.close - c.open);
  const range = c.high - c.low;
  const prevBody = Math.abs(p.close - p.open);
  
  if (range === 0) return 'none';
  const bodyRatio = body / range;
  
  // Doji (very small body)
  if (bodyRatio < 0.1) return 'doji';
  
  // Engulfing
  if (body > prevBody * 1.5) {
    if (c.close > c.open && p.close < p.open) return 'bullish_engulfing';
    if (c.close < c.open && p.close > p.open) return 'bearish_engulfing';
  }
  
  // Hammer / shooting star
  const lowerWick = Math.min(c.open, c.close) - c.low;
  const upperWick = c.high - Math.max(c.open, c.close);
  if (lowerWick > body * 2 && upperWick < body * 0.5) return 'hammer';
  if (upperWick > body * 2 && lowerWick < body * 0.5) return 'shooting_star';
  
  return 'none';
}

// ── MAIN: Calculate OTC signal ────────────────────────────────
function calculateOTCSignal(candles) {
  if (!candles || candles.length < 8) {
    return { signal: 'WAIT', confidence: 0, reason: 'Need more candles' };
  }

  const closes = candles.map(c => c.close);
  const highs  = candles.map(c => c.high);
  const lows   = candles.map(c => c.low);
  const opens  = candles.map(c => c.open);

  // ── Calculate all indicators ────────────────────────────────
  const rsi    = calcRSI(closes, Math.min(10, closes.length - 1));
  const stoch  = calcStoch(highs, lows, closes, Math.min(10, closes.length));
  const macd   = calcMACD(closes);
  const wr     = calcWR(highs, lows, closes, Math.min(10, closes.length));
  const cci    = calcCCI(highs, lows, closes, Math.min(10, closes.length));
  const bb     = calcBB(closes, Math.min(10, closes.length));
  const { streak, dir: streakDir } = calcStreak(closes);
  const pattern = detectPattern(candles);

  // EMA trend — use short/long EMAs
  const emaFast = calcEMA(closes, Math.min(5, closes.length));
  const emaSlow = calcEMA(closes, Math.min(10, closes.length));
  const emaTrend = (emaFast && emaSlow) ? (emaFast > emaSlow ? 'bullish' : emaFast < emaSlow ? 'bearish' : 'neutral') : 'neutral';

  // ── Momentum from recent price action ──────────────────────
  const recentChange = closes.length >= 4
    ? closes[closes.length - 1] - closes[closes.length - 4]
    : 0;
  const momentumBull = recentChange > 0.005;  // 0.5% move up in 4 candles
  const momentumBear = recentChange < -0.005; // 0.5% move down

  // ── Vote system ─────────────────────────────────────────────
  let upVotes = 0, downVotes = 0;
  const reasons = [];

  // RSI (oversold = buy, overbought = sell)
  if (rsi !== null) {
    if (rsi < 35) { upVotes += 2; reasons.push(`RSI oversold ${rsi}`); }
    else if (rsi > 65) { downVotes += 2; reasons.push(`RSI overbought ${rsi}`); }
    else if (rsi < 45) { upVotes++; reasons.push(`RSI leaning low ${rsi}`); }
    else if (rsi > 55) { downVotes++; reasons.push(`RSI leaning high ${rsi}`); }
  }

  // Stochastic
  if (stoch !== null) {
    if (stoch < 20) { upVotes += 2; reasons.push(`Stoch oversold ${stoch}`); }
    else if (stoch > 80) { downVotes += 2; reasons.push(`Stoch overbought ${stoch}`); }
    else if (stoch < 35) { upVotes++; }
    else if (stoch > 65) { downVotes++; }
  }

  // MACD
  if (macd === 'UP') { upVotes++; reasons.push('MACD bullish'); }
  else if (macd === 'DN') { downVotes++; reasons.push('MACD bearish'); }

  // Williams %R
  if (wr !== null) {
    if (wr <= -80) { upVotes += 2; reasons.push(`W%R oversold ${wr}`); }
    else if (wr >= -20) { downVotes += 2; reasons.push(`W%R overbought ${wr}`); }
    else if (wr < -60) { upVotes++; }
    else if (wr > -40) { downVotes++; }
  }

  // CCI
  if (cci !== null) {
    if (cci < -80) { upVotes += 2; reasons.push(`CCI oversold ${cci}`); }
    else if (cci > 80) { downVotes += 2; reasons.push(`CCI overbought ${cci}`); }
    else if (cci < -40) { upVotes++; }
    else if (cci > 40) { downVotes++; }
  }

  // EMA trend
  if (emaTrend === 'bullish') { upVotes++; reasons.push('EMA bullish'); }
  else if (emaTrend === 'bearish') { downVotes++; reasons.push('EMA bearish'); }

  // Bollinger Bands
  if (bb.pos === 'BELOW') { upVotes += 2; reasons.push('Below BB lower'); }
  else if (bb.pos === 'ABOVE') { downVotes += 2; reasons.push('Above BB upper'); }
  else if (bb.pct < 25) { upVotes++; }
  else if (bb.pct > 75) { downVotes++; }

  // Momentum
  if (momentumBull) { upVotes += 2; reasons.push('Strong momentum UP'); }
  if (momentumBear) { downVotes += 2; reasons.push('Strong momentum DOWN'); }

  // Streak (3+ consecutive = signal)
  if (streak >= 3) {
    if (streakDir === 'UP') { downVotes++; reasons.push(`${streak} candle bull streak`); } // reversal likely
    if (streakDir === 'DOWN') { upVotes++; reasons.push(`${streak} candle bear streak`); } // reversal likely
  }

  // Candle pattern
  if (pattern === 'bullish_engulfing' || pattern === 'hammer') { upVotes += 2; reasons.push(`Pattern: ${pattern}`); }
  if (pattern === 'bearish_engulfing' || pattern === 'shooting_star') { downVotes += 2; reasons.push(`Pattern: ${pattern}`); }
  if (pattern === 'doji') { /* neutral - skip */ }

  // ── Decision ─────────────────────────────────────────────────
  const totalVotes = upVotes + downVotes;
  const upPct = totalVotes > 0 ? (upVotes / totalVotes) * 100 : 50;

  let signal = 'WAIT';
  let confidence = 0;

  // Lower threshold for OTC (needs fewer candles than real market)
  if (totalVotes >= 3 && upPct >= 60) {
    signal = 'BUY';
    confidence = Math.min(95, Math.round(50 + (upPct - 50) * 1.5));
  } else if (totalVotes >= 3 && upPct <= 40) {
    signal = 'SELL';
    confidence = Math.min(95, Math.round(50 + (50 - upPct) * 1.5));
  }

  return {
    signal, confidence,
    rsi: rsi ? parseFloat(rsi.toFixed(1)) : null,
    stoch: stoch ? parseFloat(stoch.toFixed(1)) : null,
    macd, wr: wr ? parseFloat(wr.toFixed(1)) : null,
    cci: cci ? parseFloat(cci.toFixed(1)) : null,
    emaTrend, pattern,
    bbPos: bb.pos,
    streak,
    reasons: reasons.slice(0, 5),
    votes: { up: upVotes, down: downVotes, total: totalVotes, upPct: parseFloat(upPct.toFixed(1)) }
  };
}

module.exports = { calculateOTCSignal };
