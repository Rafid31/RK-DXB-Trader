// ================================================================
// RK DXB Trader — OTC Signal Engine v3 (TREND-FIRST)
// ================================================================
// ROOT FIX: Previous version was OSCILLATOR-DOMINATED
// RSI oversold was firing BUY even when slope/EMA/MACD = bearish
// 
// NEW LOGIC:
// 1. SLOPE (linear regression) = PRIMARY signal — most reliable for OTC
// 2. EMA + MACD = TREND CONFIRMATION — must agree with slope
// 3. RSI/Stoch/WR = FILTERS ONLY — used to boost confidence, not override trend
// 4. Signal only fires when slope + at least 1 trend indicator agree
// 5. Candle reversal detection — if last 3 candles show exhaustion, suppress signal
// ================================================================

function avg(arr) { return arr.reduce((s,v)=>s+v,0)/arr.length; }
function stdDev(arr) { const m=avg(arr); return Math.sqrt(arr.reduce((s,v)=>s+(v-m)**2,0)/arr.length); }

// ── Linear Regression Slope ───────────────────────────────────
function linRegSlope(vals) {
  const n = vals.length;
  if (n < 3) return 0;
  const xs = vals.map((_,i)=>i);
  const mx = avg(xs), my = avg(vals);
  const num = xs.reduce((s,x,i)=>s+(x-mx)*(vals[i]-my),0);
  const den = xs.reduce((s,x)=>s+(x-mx)**2,0);
  return den === 0 ? 0 : num/den;
}

// ── EMA ───────────────────────────────────────────────────────
function ema(vals, period) {
  if (vals.length < period) return null;
  const k = 2/(period+1);
  let e = avg(vals.slice(0, period));
  for (let i = period; i < vals.length; i++) e = vals[i]*k + e*(1-k);
  return e;
}

// ── RSI ───────────────────────────────────────────────────────
function rsi(closes, period=10) {
  if (closes.length < period+1) return null;
  const changes = closes.slice(1).map((c,i)=>c-closes[i]);
  const recent = changes.slice(-period);
  const gains = recent.filter(c=>c>0).reduce((s,c)=>s+c,0)/period;
  const losses = recent.filter(c=>c<0).reduce((s,c)=>s+Math.abs(c),0)/period;
  if (losses===0) return 100;
  if (gains===0) return 0;
  return parseFloat((100 - 100/(1+gains/losses)).toFixed(1));
}

// ── Stochastic ────────────────────────────────────────────────
function stoch(highs, lows, closes, period=10) {
  if (closes.length < period) return null;
  const h = Math.max(...highs.slice(-period));
  const l = Math.min(...lows.slice(-period));
  if (h===l) return 50;
  return parseFloat(((closes[closes.length-1]-l)/(h-l)*100).toFixed(1));
}

// ── Williams %R ───────────────────────────────────────────────
function willR(highs, lows, closes, period=10) {
  if (closes.length < period) return null;
  const h = Math.max(...highs.slice(-period));
  const l = Math.min(...lows.slice(-period));
  if (h===l) return -50;
  return parseFloat(((h-closes[closes.length-1])/(h-l)*-100).toFixed(1));
}

// ── Bollinger Bands ───────────────────────────────────────────
function bband(closes, period=10) {
  if (closes.length < period) return { pos:'MID', pct:50 };
  const sl = closes.slice(-period);
  const ma = avg(sl), sd = stdDev(sl);
  const upper = ma+2*sd, lower = ma-2*sd;
  const last = closes[closes.length-1];
  const range = upper-lower || 0.001;
  return {
    pos: last>upper?'ABOVE':last<lower?'BELOW':'MID',
    pct: parseFloat(((last-lower)/range*100).toFixed(1))
  };
}

// ── CCI ───────────────────────────────────────────────────────
function cci(highs, lows, closes, period=10) {
  if (closes.length < period) return null;
  const tp = closes.slice(-period).map((c,i)=>(highs[highs.length-period+i]+lows[lows.length-period+i]+c)/3);
  const ma = avg(tp);
  const md = avg(tp.map(p=>Math.abs(p-ma)));
  if (md===0) return 0;
  return parseFloat(((tp[tp.length-1]-ma)/(0.015*md)).toFixed(1));
}

// ── Candle pattern ────────────────────────────────────────────
function pattern(candles) {
  if (candles.length < 2) return 'none';
  const c = candles[candles.length-1];
  const p = candles[candles.length-2];
  const body = Math.abs(c.close-c.open);
  const range = c.high-c.low || 0.001;
  const prevBody = Math.abs(p.close-p.open);
  if (body/range < 0.12) return 'doji';
  if (body > prevBody*1.4) {
    if (c.close>c.open && p.close<p.open) return 'bullish_engulfing';
    if (c.close<c.open && p.close>p.open) return 'bearish_engulfing';
  }
  const lw = Math.min(c.open,c.close)-c.low;
  const uw = c.high-Math.max(c.open,c.close);
  if (lw>body*2 && uw<body*0.5) return 'hammer';
  if (uw>body*2 && lw<body*0.5) return 'shooting_star';
  return 'none';
}

// ── Candle behavior — detect exhaustion / reversal risk ───────
// Returns: 'continuation', 'exhaustion', 'reversal', 'neutral'
function candleBehavior(candles) {
  if (candles.length < 5) return 'neutral';
  const recent = candles.slice(-5);
  const closes = recent.map(c=>c.close);
  
  // Count consecutive direction
  let upCount = 0, dnCount = 0;
  for (let i = 1; i < closes.length; i++) {
    if (closes[i] > closes[i-1]) upCount++;
    else if (closes[i] < closes[i-1]) dnCount++;
  }
  
  // 4+ same direction = exhaustion (reversal likely)
  if (upCount >= 4) return 'exhaustion_up';
  if (dnCount >= 4) return 'exhaustion_dn';
  
  // Last 2 candles reverse after trend = potential reversal
  const last3 = closes.slice(-3);
  const trend = last3[1] - last3[0];
  const reversal = last3[2] - last3[1];
  if (trend > 0 && reversal < -trend*0.5) return 'reversal_dn';
  if (trend < 0 && reversal > -trend*0.5) return 'reversal_up';
  
  return 'continuation';
}

// ════════════════════════════════════════════════════════════════
// MAIN SIGNAL ENGINE — TREND-FIRST APPROACH
// ════════════════════════════════════════════════════════════════
function calcRawSignal(candles) {
  if (!candles || candles.length < 6) return { signal:'WAIT', confidence:0 };

  const closes = candles.map(c=>c.close);
  const highs  = candles.map(c=>c.high);
  const lows   = candles.map(c=>c.low);
  const n = closes.length;
  const p = Math.min(10, n-1);

  // ── TIER 1: TREND INDICATORS (primary) ───────────────────────
  const slope10 = linRegSlope(closes.slice(-10));
  const slope5  = linRegSlope(closes.slice(-5));
  const ema5    = ema(closes, Math.min(5, n));
  const ema10   = ema(closes, Math.min(10, n));
  const emaTrend = (ema5 && ema10) ? (ema5>ema10?'bullish':ema5<ema10?'bearish':'neutral') : 'neutral';
  const macd = (ema5 && ema10) ? (ema5>ema10?'UP':'DN') : null;
  
  // Slope direction + strength
  const slopeDir  = slope10 > 0.4 ? 'UP' : slope10 < -0.4 ? 'DOWN' : 'FLAT';
  const slope5Dir = slope5  > 0.3 ? 'UP' : slope5  < -0.3 ? 'DOWN' : 'FLAT';

  // ── TIER 2: OSCILLATORS (filters only) ───────────────────────
  const rsiVal  = rsi(closes, p);
  const stochVal = stoch(highs, lows, closes, p);
  const wrVal   = willR(highs, lows, closes, p);
  const cciVal  = cci(highs, lows, closes, p);
  const bb      = bband(closes, p);
  const pat     = pattern(candles);
  const behav   = candleBehavior(candles);

  // ── DECISION: SLOPE IS PRIMARY ───────────────────────────────
  // Signal only fires when slope agrees with at least EMA OR MACD
  // Oscillators boost confidence but CANNOT override trend

  let signal    = 'WAIT';
  let confidence = 0;
  const reasons = [];

  // Determine trend direction from primary indicators
  let trendUp   = 0; // votes for UP trend
  let trendDown = 0; // votes for DOWN trend

  // Slope (weighted heavily — most reliable for OTC)
  if (slopeDir === 'UP')   { trendUp   += 3; reasons.push(`Slope UP (${slope10.toFixed(2)})`); }
  if (slopeDir === 'DOWN') { trendDown += 3; reasons.push(`Slope DOWN (${slope10.toFixed(2)})`); }
  if (slope5Dir === 'UP' && slopeDir === 'UP')     { trendUp   += 2; } // short slope confirms
  if (slope5Dir === 'DOWN' && slopeDir === 'DOWN') { trendDown += 2; }

  // EMA trend
  if (emaTrend === 'bullish') { trendUp   += 2; reasons.push('EMA bullish'); }
  if (emaTrend === 'bearish') { trendDown += 2; reasons.push('EMA bearish'); }

  // MACD
  if (macd === 'UP') { trendUp   += 2; reasons.push('MACD UP'); }
  if (macd === 'DN') { trendDown += 2; reasons.push('MACD DN'); }

  // ── CANDLE BEHAVIOR check ─────────────────────────────────────
  // If exhaustion detected, flip the signal (reversal likely)
  let behaviorBoost = 0;
  if (behav === 'exhaustion_up')  { trendDown += 2; reasons.push('Exhaustion↑ → reversal risk'); }
  if (behav === 'exhaustion_dn')  { trendUp   += 2; reasons.push('Exhaustion↓ → reversal risk'); }
  if (behav === 'reversal_up')    { trendUp   += 1; reasons.push('Candle reversal UP'); }
  if (behav === 'reversal_dn')    { trendDown += 1; reasons.push('Candle reversal DN'); }

  // ── OSCILLATORS AS CONFIDENCE BOOSTERS ───────────────────────
  // They add to confidence only if they align with trend direction
  let confBoost = 0;

  if (rsiVal !== null) {
    if (trendDown > trendUp) {
      // Trend is DOWN — overbought RSI confirms
      if (rsiVal > 60)      { confBoost += 10; reasons.push(`RSI overbought ${rsiVal}`); }
      else if (rsiVal > 50) { confBoost += 5; }
    } else if (trendUp > trendDown) {
      // Trend is UP — oversold RSI confirms
      if (rsiVal < 40)      { confBoost += 10; reasons.push(`RSI oversold ${rsiVal}`); }
      else if (rsiVal < 50) { confBoost += 5; }
    }
  }

  if (stochVal !== null) {
    if (trendDown > trendUp && stochVal > 70)    { confBoost += 8; reasons.push(`Stoch overbought ${stochVal}`); }
    if (trendUp > trendDown && stochVal < 30)    { confBoost += 8; reasons.push(`Stoch oversold ${stochVal}`); }
  }

  if (wrVal !== null) {
    if (trendDown > trendUp && wrVal >= -30)     { confBoost += 6; reasons.push(`W%R overbought ${wrVal}`); }
    if (trendUp > trendDown && wrVal <= -70)     { confBoost += 6; reasons.push(`W%R oversold ${wrVal}`); }
  }

  if (cciVal !== null) {
    if (trendDown > trendUp && cciVal > 80)      { confBoost += 6; }
    if (trendUp > trendDown && cciVal < -80)     { confBoost += 6; }
  }

  // Bollinger Bands
  if (bb.pos === 'ABOVE' && trendDown > trendUp) { confBoost += 8; reasons.push('Above BB upper'); }
  if (bb.pos === 'BELOW' && trendUp > trendDown) { confBoost += 8; reasons.push('Below BB lower'); }

  // Candle patterns
  if (pat === 'bullish_engulfing' && trendUp > trendDown)   { confBoost += 12; reasons.push('Pattern: bullish engulf'); }
  if (pat === 'bearish_engulfing' && trendDown > trendUp)   { confBoost += 12; reasons.push('Pattern: bearish engulf'); }
  if (pat === 'hammer' && trendUp > trendDown)              { confBoost += 8;  reasons.push('Pattern: hammer'); }
  if (pat === 'shooting_star' && trendDown > trendUp)       { confBoost += 8;  reasons.push('Pattern: shooting star'); }

  // ── FINAL DECISION ────────────────────────────────────────────
  const total = trendUp + trendDown;
  const margin = Math.abs(trendUp - trendDown);
  
  // Need clear trend majority (at least 60% of trend votes)
  // AND slope must be part of the signal (not pure oscillator)
  const hasSlope = slopeDir !== 'FLAT';
  const strongTrend = margin >= 3 && total >= 5;
  const mediumTrend = margin >= 2 && total >= 4 && hasSlope;

  if (strongTrend || mediumTrend) {
    if (trendUp > trendDown) {
      signal = 'BUY';
      confidence = Math.min(95, 55 + margin * 5 + confBoost);
    } else {
      signal = 'SELL';
      confidence = Math.min(95, 55 + margin * 5 + confBoost);
    }
  }

  return {
    signal, confidence,
    rsi: rsiVal ? parseFloat(rsiVal.toFixed(1)) : null,
    stoch: stochVal ? parseFloat(stochVal.toFixed(1)) : null,
    macd, wr: wrVal ? parseFloat(wrVal.toFixed(1)) : null,
    cci: cciVal ? parseFloat(cciVal.toFixed(1)) : null,
    emaTrend, pattern: pat,
    bbPos: bb.pos,
    streak: 0,
    behavior: behav,
    reasons: reasons.slice(0, 5),
    votes: { trendUp, trendDown, total, confBoost }
  };
}

// ── CONFIRMED SIGNAL (3× same = lock) ────────────────────────
const signalHistory  = {};
const confirmedSig   = {};

function calculateOTCSignal(symbol, candles) {
  if (!signalHistory[symbol])  signalHistory[symbol]  = [];
  if (!confirmedSig[symbol])   confirmedSig[symbol]   = { signal:'WAIT', confidence:0, isConfirmed:false };

  const raw  = calcRawSignal(candles);
  const hist = signalHistory[symbol];

  hist.push(raw.signal);
  if (hist.length > 6) hist.shift();

  const prev = confirmedSig[symbol];

  if (hist.length >= 3) {
    const last3 = hist.slice(-3);
    const same3 = last3.every(s => s === last3[0]) && last3[0] !== 'WAIT';
    const allW3 = last3.every(s => s === 'WAIT');
    // 2× + slope same direction = early confirm
    const last2 = hist.slice(-2);
    const same2 = last2[0] === last2[1] && last2[0] !== 'WAIT';
    const slopeAgreesUp   = raw.signal === 'BUY'  && raw.emaTrend === 'bullish' && raw.macd === 'UP';
    const slopeAgreesDn   = raw.signal === 'SELL' && raw.emaTrend === 'bearish' && raw.macd === 'DN';
    const slopeAligned = slopeAgreesUp || slopeAgreesDn;

    if (same3) {
      confirmedSig[symbol] = {
        signal: last3[0], confidence: Math.min(95, raw.confidence),
        isConfirmed: true, lockedAt: new Date().toISOString()
      };
    } else if (same2 && slopeAligned && raw.confidence >= 70) {
      // Fast confirm: 2× same + slope + EMA + MACD all agree
      confirmedSig[symbol] = {
        signal: raw.signal, confidence: raw.confidence,
        isConfirmed: true, lockedAt: new Date().toISOString()
      };
    } else if (allW3) {
      confirmedSig[symbol] = { signal:'WAIT', confidence:0, isConfirmed:false };
    } else if (same2 && prev.isConfirmed && last2[0] !== prev.signal) {
      // Opposite confirmed 2× = reset
      confirmedSig[symbol] = { signal:'WAIT', confidence:0, isConfirmed:false };
    }
  }

  return {
    ...raw,
    signal:        confirmedSig[symbol].signal,
    confidence:    confirmedSig[symbol].confidence,
    isConfirmed:   confirmedSig[symbol].isConfirmed,
    rawSignal:     raw.signal,
    rawConfidence: raw.confidence,
    signalHistory: [...hist]
  };
}

module.exports = { calculateOTCSignal, calcRawSignal };
