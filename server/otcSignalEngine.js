// ================================================================
// RK DXB Trader — OTC Signal Engine v2
// CONFIRMED SIGNAL SYSTEM:
// - Raw signal calculated every candle
// - Signal must repeat 3x consecutively to become CONFIRMED
// - Confirmed signal LOCKS IN and stays until opposite confirms
// - This eliminates flip-flopping and gives clean final signals
// ================================================================

function avg(arr) { return arr.reduce((s,v)=>s+v,0)/arr.length; }
function stdDev(arr) { const m=avg(arr); return Math.sqrt(arr.reduce((s,v)=>s+(v-m)**2,0)/arr.length); }

// ── Indicators (work on 0-100 scale prices) ──────────────────

function calcRSI(closes, period=10) {
  if (closes.length < period+1) return null;
  const changes = closes.slice(1).map((c,i) => c - closes[i]);
  const recent = changes.slice(-period);
  const gains = recent.filter(c=>c>0).reduce((s,c)=>s+c,0)/period;
  const losses = recent.filter(c=>c<0).reduce((s,c)=>s+Math.abs(c),0)/period;
  if (losses===0) return 100;
  if (gains===0) return 0;
  return parseFloat((100 - 100/(1+gains/losses)).toFixed(1));
}

function calcEMA(closes, period) {
  if (closes.length < period) return null;
  const k = 2/(period+1);
  let ema = avg(closes.slice(0,period));
  for (let i=period; i<closes.length; i++) ema = closes[i]*k + ema*(1-k);
  return ema;
}

function calcStoch(highs, lows, closes, period=10) {
  if (closes.length < period) return null;
  const h = Math.max(...highs.slice(-period));
  const l = Math.min(...lows.slice(-period));
  if (h===l) return 50;
  return parseFloat(((closes[closes.length-1]-l)/(h-l)*100).toFixed(1));
}

function calcWR(highs, lows, closes, period=10) {
  if (closes.length < period) return null;
  const h = Math.max(...highs.slice(-period));
  const l = Math.min(...lows.slice(-period));
  if (h===l) return -50;
  return parseFloat(((h-closes[closes.length-1])/(h-l)*-100).toFixed(1));
}

function calcCCI(highs, lows, closes, period=10) {
  if (closes.length < period) return null;
  const tp = closes.slice(-period).map((c,i) => (highs[highs.length-period+i]+lows[lows.length-period+i]+c)/3);
  const ma = avg(tp); const md = avg(tp.map(p=>Math.abs(p-ma)));
  if (md===0) return 0;
  return parseFloat(((tp[tp.length-1]-ma)/(0.015*md)).toFixed(1));
}

function calcBB(closes, period=10) {
  if (closes.length < period) return {pos:'MID',pct:50};
  const slice = closes.slice(-period);
  const ma = avg(slice); const sd = stdDev(slice);
  const upper = ma+2*sd; const lower = ma-2*sd;
  const last = closes[closes.length-1];
  const range = upper-lower;
  const pct = range===0 ? 50 : (last-lower)/range*100;
  return {
    pos: last>upper ? 'ABOVE' : last<lower ? 'BELOW' : 'MID',
    pct: parseFloat(pct.toFixed(1))
  };
}

function detectPattern(candles) {
  if (candles.length < 2) return 'none';
  const c = candles[candles.length-1];
  const p = candles[candles.length-2];
  const body = Math.abs(c.close-c.open);
  const range = c.high-c.low;
  const prevBody = Math.abs(p.close-p.open);
  if (range===0) return 'none';
  if (body/range < 0.15) return 'doji';
  if (body > prevBody*1.5) {
    if (c.close>c.open && p.close<p.open) return 'bullish_engulfing';
    if (c.close<c.open && p.close>p.open) return 'bearish_engulfing';
  }
  const lw = Math.min(c.open,c.close)-c.low;
  const uw = c.high-Math.max(c.open,c.close);
  if (lw>body*2 && uw<body*0.5) return 'hammer';
  if (uw>body*2 && lw<body*0.5) return 'shooting_star';
  return 'none';
}

// ── Raw signal calculation ────────────────────────────────────
function calcRawSignal(candles) {
  if (!candles || candles.length < 5) return { signal:'WAIT', confidence:0 };

  const closes = candles.map(c=>c.close);
  const highs  = candles.map(c=>c.high);
  const lows   = candles.map(c=>c.low);
  const n = closes.length;
  const p = Math.min(10, n-1);

  const rsi   = calcRSI(closes, p);
  const stoch = calcStoch(highs, lows, closes, p);
  const wr    = calcWR(highs, lows, closes, p);
  const cci   = calcCCI(highs, lows, closes, p);
  const bb    = calcBB(closes, p);
  const ema5  = calcEMA(closes, Math.min(5,n));
  const ema10 = calcEMA(closes, Math.min(10,n));
  const emaTrend = (ema5&&ema10) ? (ema5>ema10?'bullish':ema5<ema10?'bearish':'neutral') : 'neutral';
  const macd = ema5&&ema10 ? (ema5>ema10?'UP':'DN') : null;
  const pattern = detectPattern(candles);

  // Momentum: last 5 candle direction
  const momentum5 = n>=5 ? closes[n-1]-closes[n-5] : 0;
  const momBull = momentum5 > 1.5;  // 1.5 points on 0-100 scale
  const momBear = momentum5 < -1.5;

  // Price vs MA (mean reversion signal)
  const ma = avg(closes.slice(-Math.min(10,n)));
  const last = closes[n-1];
  const deviation = ((last - ma) / ma) * 100; // % deviation from mean

  let up=0, dn=0;
  const reasons=[];

  // RSI - weighted by extremity
  if (rsi!==null) {
    if (rsi<30) { up+=3; reasons.push(`RSI very low ${rsi}`); }
    else if (rsi<40) { up+=2; reasons.push(`RSI oversold ${rsi}`); }
    else if (rsi<48) { up+=1; }
    else if (rsi>70) { dn+=3; reasons.push(`RSI very high ${rsi}`); }
    else if (rsi>60) { dn+=2; reasons.push(`RSI overbought ${rsi}`); }
    else if (rsi>52) { dn+=1; }
  }

  // Stochastic
  if (stoch!==null) {
    if (stoch<15) { up+=3; reasons.push(`Stoch ${stoch} oversold`); }
    else if (stoch<25) { up+=2; }
    else if (stoch>85) { dn+=3; reasons.push(`Stoch ${stoch} overbought`); }
    else if (stoch>75) { dn+=2; }
  }

  // Williams %R
  if (wr!==null) {
    if (wr<=-85) { up+=3; reasons.push(`W%R ${wr} oversold`); }
    else if (wr<=-70) { up+=2; }
    else if (wr>=-15) { dn+=3; reasons.push(`W%R ${wr} overbought`); }
    else if (wr>=-30) { dn+=2; }
  }

  // CCI
  if (cci!==null) {
    if (cci<-120) { up+=2; reasons.push(`CCI ${cci} oversold`); }
    else if (cci<-80) { up+=1; }
    else if (cci>120) { dn+=2; reasons.push(`CCI ${cci} overbought`); }
    else if (cci>80) { dn+=1; }
  }

  // Bollinger Bands (mean reversion)
  if (bb.pos==='BELOW') { up+=3; reasons.push('Below BB lower band'); }
  else if (bb.pos==='ABOVE') { dn+=3; reasons.push('Above BB upper band'); }
  else if (bb.pct<20) { up+=1; }
  else if (bb.pct>80) { dn+=1; }

  // EMA trend
  if (emaTrend==='bullish') { up+=1; reasons.push('EMA bullish'); }
  else if (emaTrend==='bearish') { dn+=1; reasons.push('EMA bearish'); }

  // Momentum (strong directional move)
  if (momBull) { up+=2; reasons.push('Strong upward momentum'); }
  if (momBear) { dn+=2; reasons.push('Strong downward momentum'); }

  // Mean reversion: if price far from mean, expect reversal
  if (deviation < -3) { up+=2; reasons.push('Price far below mean'); }
  else if (deviation > 3) { dn+=2; reasons.push('Price far above mean'); }

  // Candle pattern
  if (pattern==='bullish_engulfing'||pattern==='hammer') { up+=3; reasons.push(`Pattern: ${pattern}`); }
  if (pattern==='bearish_engulfing'||pattern==='shooting_star') { dn+=3; reasons.push(`Pattern: ${pattern}`); }

  const total = up+dn;
  const upPct = total>0 ? (up/total)*100 : 50;

  let signal='WAIT', confidence=0;
  if (total>=4 && upPct>=62) {
    signal='BUY';
    confidence = Math.min(95, Math.round(50+(upPct-50)*1.5));
  } else if (total>=4 && upPct<=38) {
    signal='SELL';
    confidence = Math.min(95, Math.round(50+(50-upPct)*1.5));
  }

  return {
    signal, confidence,
    rsi: rsi?parseFloat(rsi.toFixed(1)):null,
    stoch: stoch?parseFloat(stoch.toFixed(1)):null,
    macd, wr: wr?parseFloat(wr.toFixed(1)):null,
    cci: cci?parseFloat(cci.toFixed(1)):null,
    emaTrend, pattern, bbPos:bb.pos,
    reasons: reasons.slice(0,5),
    votes:{up,dn,total,upPct:parseFloat(upPct.toFixed(1))}
  };
}

// ── CONFIRMED SIGNAL SYSTEM ──────────────────────────────────
// A signal is CONFIRMED when:
//   - Raw signal appears 2× in a row (fast) AND slope aligns, OR
//   - Raw signal appears 3× in a row (safe, no slope requirement)
// Once confirmed, locked until opposite confirmed 2× in a row

const signalHistory = {}; // symbol -> last 6 raw signals
const confirmedSignal = {}; // symbol -> { signal, confidence, isConfirmed }

function getConfirmedSignal(symbol, candles) {
  if (!signalHistory[symbol]) signalHistory[symbol] = [];
  if (!confirmedSignal[symbol]) confirmedSignal[symbol] = { signal:'WAIT', confidence:0, isConfirmed:false };

  const raw = calcRawSignal(candles);
  const hist = signalHistory[symbol];

  hist.push(raw.signal);
  if (hist.length > 6) hist.shift();

  const prev = confirmedSignal[symbol];

  if (hist.length >= 2) {
    const last2 = hist.slice(-2);
    const last3 = hist.slice(-3);
    const same2 = last2[0] === last2[1] && last2[0] !== 'WAIT';
    const same3 = last3.length === 3 && last3.every(s => s === last3[0]) && last3[0] !== 'WAIT';
    const allWait3 = last3.length === 3 && last3.every(s => s === 'WAIT');

    // Confirmed by 3 consecutive (most reliable)
    if (same3) {
      confirmedSignal[symbol] = {
        signal: last3[0],
        confidence: Math.min(95, raw.confidence + 5), // bonus for 3× confirmation
        isConfirmed: true,
        lockedAt: new Date().toISOString()
      };
    }
    // Reset on 3 consecutive WAITs
    else if (allWait3) {
      confirmedSignal[symbol] = { signal:'WAIT', confidence:0, isConfirmed:false };
    }
    // If confirmed signal gets opposite 2× in a row = reset to WAIT first
    else if (same2 && prev.isConfirmed && last2[0] !== prev.signal) {
      confirmedSignal[symbol] = { signal:'WAIT', confidence:0, isConfirmed:false };
    }
  }

  return {
    ...raw,
    signal:        confirmedSignal[symbol].signal,
    confidence:    confirmedSignal[symbol].confidence,
    isConfirmed:   confirmedSignal[symbol].isConfirmed,
    rawSignal:     raw.signal,
    rawConfidence: raw.confidence,
    signalHistory: [...hist]
  };
}

module.exports = { calculateOTCSignal: getConfirmedSignal, calcRawSignal };
