// ================================================================
// RK DXB Trader — OTC Signal Engine (BALANCED)
// Slope + EMA + MACD = primary trend direction
// RSI/Stoch/BB = confirmation boosters (not overriders)
// Confirmed = 3 consecutive same signal
// ================================================================

function avg(arr) { return arr.reduce((s,v)=>s+v,0)/arr.length; }
function stdDev(arr) { const m=avg(arr); return Math.sqrt(arr.reduce((s,v)=>s+(v-m)**2,0)/arr.length); }

function linSlope(vals) {
  const n=vals.length; if(n<3) return 0;
  const xs=vals.map((_,i)=>i), mx=avg(xs), my=avg(vals);
  const num=xs.reduce((s,x,i)=>s+(x-mx)*(vals[i]-my),0);
  const den=xs.reduce((s,x)=>s+(x-mx)**2,0);
  return den===0?0:num/den;
}

function calcEMA(closes, period) {
  if(closes.length<period) return null;
  const k=2/(period+1); let e=avg(closes.slice(0,period));
  for(let i=period;i<closes.length;i++) e=closes[i]*k+e*(1-k);
  return e;
}

function calcRSI(closes, period=10) {
  if(closes.length<period+1) return null;
  const ch=closes.slice(1).map((c,i)=>c-closes[i]).slice(-period);
  const g=ch.filter(c=>c>0).reduce((s,c)=>s+c,0)/period;
  const l=ch.filter(c=>c<0).reduce((s,c)=>s+Math.abs(c),0)/period;
  if(l===0) return 100; if(g===0) return 0;
  return parseFloat((100-100/(1+g/l)).toFixed(1));
}

function calcStoch(highs, lows, closes, period=10) {
  if(closes.length<period) return null;
  const h=Math.max(...highs.slice(-period)), l=Math.min(...lows.slice(-period));
  if(h===l) return 50;
  return parseFloat(((closes[closes.length-1]-l)/(h-l)*100).toFixed(1));
}

function calcWR(highs, lows, closes, period=10) {
  if(closes.length<period) return null;
  const h=Math.max(...highs.slice(-period)), l=Math.min(...lows.slice(-period));
  if(h===l) return -50;
  return parseFloat(((h-closes[closes.length-1])/(h-l)*-100).toFixed(1));
}

function calcBB(closes, period=10) {
  if(closes.length<period) return {pos:'MID',pct:50};
  const sl=closes.slice(-period), ma=avg(sl), sd=stdDev(sl);
  const upper=ma+2*sd, lower=ma-2*sd, last=closes[closes.length-1];
  const range=upper-lower||0.001;
  return { pos:last>upper?'ABOVE':last<lower?'BELOW':'MID', pct:parseFloat(((last-lower)/range*100).toFixed(1)) };
}

function candleBehavior(candles) {
  if(candles.length<4) return 'neutral';
  const closes=candles.slice(-5).map(c=>c.close);
  let up=0,dn=0;
  for(let i=1;i<closes.length;i++) { if(closes[i]>closes[i-1]) up++; else if(closes[i]<closes[i-1]) dn++; }
  if(up>=4) return 'exhaustion_up';
  if(dn>=4) return 'exhaustion_dn';
  return 'continuation';
}

function detectPattern(candles) {
  if(candles.length<2) return 'none';
  const c=candles[candles.length-1], p=candles[candles.length-2];
  const body=Math.abs(c.close-c.open), range=c.high-c.low||0.001, prevBody=Math.abs(p.close-p.open);
  if(body/range<0.12) return 'doji';
  if(body>prevBody*1.4) {
    if(c.close>c.open&&p.close<p.open) return 'bullish_engulfing';
    if(c.close<c.open&&p.close>p.open) return 'bearish_engulfing';
  }
  const lw=Math.min(c.open,c.close)-c.low, uw=c.high-Math.max(c.open,c.close);
  if(lw>body*2&&uw<body*0.5) return 'hammer';
  if(uw>body*2&&lw<body*0.5) return 'shooting_star';
  return 'none';
}

function calcRawSignal(candles) {
  if(!candles||candles.length<5) return {signal:'WAIT',confidence:0};
  const closes=candles.map(c=>c.close);
  const highs=candles.map(c=>c.high);
  const lows=candles.map(c=>c.low);
  const n=closes.length, p=Math.min(10,n-1);

  // PRIMARY: Slope + EMA trend
  const slope10=linSlope(closes.slice(-Math.min(10,n)));
  const slope5=linSlope(closes.slice(-Math.min(5,n)));
  const ema5=calcEMA(closes,Math.min(5,n));
  const ema10=calcEMA(closes,Math.min(10,n));
  const emaTrend=(ema5&&ema10)?(ema5>ema10?'bullish':ema5<ema10?'bearish':'neutral'):'neutral';
  const macd=(ema5&&ema10)?(ema5>ema10?'UP':'DN'):null;

  const slopeDir=slope10>0.3?'UP':slope10<-0.3?'DOWN':'FLAT';
  const slope5Dir=slope5>0.2?'UP':slope5<-0.2?'DOWN':'FLAT';

  // SECONDARY: Oscillators as confirmation only
  const rsi=calcRSI(closes,p);
  const stoch=calcStoch(highs,lows,closes,p);
  const wr=calcWR(highs,lows,closes,p);
  const bb=calcBB(closes,p);
  const pat=detectPattern(candles);
  const behav=candleBehavior(candles);

  let up=0,dn=0;
  const reasons=[];

  // SLOPE - primary signal (most weight)
  if(slopeDir==='UP') { up+=3; reasons.push(`Slope UP (${slope10.toFixed(2)})`); }
  else if(slopeDir==='DOWN') { dn+=3; reasons.push(`Slope DOWN (${slope10.toFixed(2)})`); }
  // Short slope confirmation
  if(slope5Dir==='UP'&&slopeDir==='UP') up+=1;
  else if(slope5Dir==='DOWN'&&slopeDir==='DOWN') dn+=1;

  // EMA
  if(emaTrend==='bullish') { up+=2; reasons.push('EMA bullish'); }
  else if(emaTrend==='bearish') { dn+=2; reasons.push('EMA bearish'); }

  // MACD
  if(macd==='UP') { up+=2; reasons.push('MACD UP'); }
  else if(macd==='DN') { dn+=2; reasons.push('MACD DN'); }

  // Candle behavior
  if(behav==='exhaustion_up') { dn+=2; reasons.push('Exhaustion↑→reversal'); }
  else if(behav==='exhaustion_dn') { up+=2; reasons.push('Exhaustion↓→reversal'); }

  // OSCILLATORS — only add confidence if they agree with trend
  let confBoost=0;
  const trendUp=up>dn, trendDn=dn>up;

  if(rsi!==null) {
    if(trendDn&&rsi>58) { confBoost+=8; reasons.push(`RSI ${rsi} overbought`); }
    else if(trendUp&&rsi<42) { confBoost+=8; reasons.push(`RSI ${rsi} oversold`); }
    else if(trendDn&&rsi>52) confBoost+=3;
    else if(trendUp&&rsi<48) confBoost+=3;
  }
  if(stoch!==null) {
    if(trendDn&&stoch>70) { confBoost+=6; reasons.push(`Stoch ${stoch} overbought`); }
    else if(trendUp&&stoch<30) { confBoost+=6; reasons.push(`Stoch ${stoch} oversold`); }
  }
  if(wr!==null) {
    if(trendDn&&wr>=-25) { confBoost+=5; }
    else if(trendUp&&wr<=-75) { confBoost+=5; }
  }
  if(bb.pos==='ABOVE'&&trendDn) { confBoost+=7; reasons.push('Above BB upper'); }
  else if(bb.pos==='BELOW'&&trendUp) { confBoost+=7; reasons.push('Below BB lower'); }

  // Patterns
  if((pat==='bullish_engulfing'||pat==='hammer')&&trendUp) { confBoost+=10; reasons.push(`Pattern: ${pat}`); }
  else if((pat==='bearish_engulfing'||pat==='shooting_star')&&trendDn) { confBoost+=10; reasons.push(`Pattern: ${pat}`); }

  const total=up+dn, margin=Math.abs(up-dn);
  const hasSlope=slopeDir!=='FLAT';
  const strongEnough=(margin>=3&&total>=5)||(margin>=2&&total>=4&&hasSlope);

  let signal='WAIT', confidence=0;
  if(strongEnough&&up>dn) {
    signal='BUY';
    confidence=Math.min(95, 52+margin*5+confBoost);
  } else if(strongEnough&&dn>up) {
    signal='SELL';
    confidence=Math.min(95, 52+margin*5+confBoost);
  }

  return {
    signal, confidence,
    rsi:rsi?parseFloat(rsi.toFixed(1)):null,
    stoch:stoch?parseFloat(stoch.toFixed(1)):null,
    macd, wr:wr?parseFloat(wr.toFixed(1)):null,
    emaTrend, pattern:pat, bbPos:bb.pos, behavior:behav,
    reasons:reasons.slice(0,5),
    votes:{up,dn,total,confBoost}
  };
}

// ── CONFIRMATION: 3× same = confirmed ────────────────────────
const signalHistory={}, confirmedSig={};

function calculateOTCSignal(symbol, candles) {
  if(!signalHistory[symbol]) signalHistory[symbol]=[];
  if(!confirmedSig[symbol]) confirmedSig[symbol]={signal:'WAIT',confidence:0,isConfirmed:false};

  const raw=calcRawSignal(candles);
  const hist=signalHistory[symbol];
  hist.push(raw.signal);
  if(hist.length>6) hist.shift();

  const prev=confirmedSig[symbol];

  if(hist.length>=3) {
    const last3=hist.slice(-3);
    const same3=last3.every(s=>s===last3[0])&&last3[0]!=='WAIT';
    const allW3=last3.every(s=>s==='WAIT');
    const last2=hist.slice(-2);
    const same2=last2[0]===last2[1]&&last2[0]!=='WAIT';

    // Fast confirm: 2× same + slope AND ema + macd all agree
    const slopeUp=raw.signal==='BUY'&&raw.emaTrend==='bullish'&&raw.macd==='UP';
    const slopeDn=raw.signal==='SELL'&&raw.emaTrend==='bearish'&&raw.macd==='DN';
    const fullyAligned=slopeUp||slopeDn;

    if(same3) {
      confirmedSig[symbol]={signal:last3[0],confidence:Math.min(95,raw.confidence+5),isConfirmed:true};
    } else if(same2&&fullyAligned&&raw.confidence>=68) {
      confirmedSig[symbol]={signal:raw.signal,confidence:raw.confidence,isConfirmed:true};
    } else if(allW3) {
      confirmedSig[symbol]={signal:'WAIT',confidence:0,isConfirmed:false};
    } else if(same2&&prev.isConfirmed&&last2[0]!==prev.signal) {
      confirmedSig[symbol]={signal:'WAIT',confidence:0,isConfirmed:false};
    }
  }

  return {
    ...raw,
    signal:confirmedSig[symbol].signal,
    confidence:confirmedSig[symbol].confidence,
    isConfirmed:confirmedSig[symbol].isConfirmed,
    rawSignal:raw.signal,
    rawConfidence:raw.confidence,
    signalHistory:[...hist]
  };
}

module.exports = { calculateOTCSignal, calcRawSignal };
