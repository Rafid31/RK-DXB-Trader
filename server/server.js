// ================================================================
// RK DXB Trader — Main Server
// Render deployment — 24/7 signal engine
// ================================================================
const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');
const fetch = require('node-fetch');
const cron = require('node-cron');

const { getKey } = require('./apiKeys');
const { calculateSignal } = require('./signalEngine');
const { getCurrentSessions, isMarketOpen, getNextSessionEvent, getSessionAlerts } = require('./sessions');
const { sendTelegram, formatSignalAlert, formatSessionAlert } = require('./telegram');

// ── Config ──────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;

const PAIRS = [
  { symbol: 'EUR/USD', td: 'EUR/USD' },
  { symbol: 'GBP/USD', td: 'GBP/USD' },
  { symbol: 'USD/JPY', td: 'USD/JPY' },
  { symbol: 'AUD/USD', td: 'AUD/USD' },
  { symbol: 'USD/CAD', td: 'USD/CAD' },
  { symbol: 'EUR/GBP', td: 'EUR/GBP' },
  { symbol: 'GBP/JPY', td: 'GBP/JPY' },
  { symbol: 'EUR/JPY', td: 'EUR/JPY' }
];

// ── State ────────────────────────────────────────────────────
const candleStore = {}; // symbol -> candle[]
const lastSignals = {}; // symbol -> { signal, confidence, time }
const signalHistory = {}; // symbol -> [{ signal, time, result }]
const sentSignals = new Set(); // prevent duplicate Telegram msgs

PAIRS.forEach(p => {
  candleStore[p.symbol] = [];
  lastSignals[p.symbol] = { signal: 'WAIT', confidence: 0 };
  signalHistory[p.symbol] = [];
});

// ── Twelve Data Fetcher ──────────────────────────────────────
async function fetchCandles(symbol, outputsize = 90) {
  const key = getKey();
  const tdSymbol = symbol.replace('/', '');
  const url = `https://api.twelvedata.com/time_series?symbol=${tdSymbol}&interval=1min&outputsize=${outputsize}&apikey=${key}`;

  try {
    const res = await fetch(url, { timeout: 10000 });
    const data = await res.json();

    if (data.status === 'error' || !data.values) {
      console.warn(`[${symbol}] API error: ${data.message || 'unknown'}`);
      return null;
    }

    // Twelve Data returns newest first — reverse to oldest first
    const candles = data.values.reverse().map(v => ({
      time: v.datetime,
      open: parseFloat(v.open),
      high: parseFloat(v.high),
      low: parseFloat(v.low),
      close: parseFloat(v.close),
      volume: parseFloat(v.volume) || 0
    }));

    return candles;
  } catch (err) {
    console.error(`[${symbol}] Fetch failed: ${err.message}`);
    return null;
  }
}

// ── Update All Pairs ─────────────────────────────────────────
async function updatePair(pair) {
  const candles = await fetchCandles(pair.symbol);
  if (!candles || candles.length < 30) return;

  candleStore[pair.symbol] = candles;

  // Calculate signal
  const result = calculateSignal(candles);
  const prev = lastSignals[pair.symbol];
  lastSignals[pair.symbol] = { ...result, updatedAt: new Date().toISOString() };

  // Send Telegram only for new strong signals (not repeat)
  const signalKey = `${pair.symbol}-${result.signal}-${Math.floor(Date.now() / 60000)}`;
  if (
    result.signal !== 'WAIT' &&
    result.confidence >= 70 &&
    !sentSignals.has(signalKey)
  ) {
    sentSignals.add(signalKey);
    // Cleanup old keys (keep last 100)
    if (sentSignals.size > 100) {
      const first = sentSignals.values().next().value;
      sentSignals.delete(first);
    }
    const msg = formatSignalAlert(pair.symbol, result.signal, result.confidence, result.reasons || []);
    await sendTelegram(msg);
  }
}

// Stagger updates to avoid hitting rate limits
async function updateAllPairs() {
  for (let i = 0; i < PAIRS.length; i++) {
    await updatePair(PAIRS[i]);
    if (i < PAIRS.length - 1) {
      await new Promise(r => setTimeout(r, 1500)); // 1.5s between pairs
    }
  }
  console.log(`[${new Date().toISOString()}] All pairs updated`);
}

// ── Build State to Send to Clients ───────────────────────────
function buildState() {
  const sessions = getCurrentSessions();
  const nextEvent = getNextSessionEvent();
  const marketOpen = isMarketOpen();

  const pairs = PAIRS.map(p => {
    const candles = candleStore[p.symbol];
    const signal = lastSignals[p.symbol];
    const price = candles.length > 0 ? candles[candles.length - 1].close : null;
    const prev = candles.length > 1 ? candles[candles.length - 2].close : null;
    const change = price && prev ? ((price - prev) / prev) * 100 : 0;

    return {
      symbol: p.symbol,
      price: price ? price.toFixed(price > 10 ? 3 : 5) : '—',
      change: +change.toFixed(3),
      signal: signal.signal || 'WAIT',
      confidence: signal.confidence || 0,
      rsi: signal.rsi,
      stoch: signal.stoch,
      macd: signal.macd,
      wr: signal.wr,
      cci: signal.cci,
      emaTrend: signal.emaTrend,
      pattern: signal.pattern,
      streak: signal.streak,
      bbPos: signal.bbPos,
      reasons: signal.reasons || [],
      updatedAt: signal.updatedAt || null
    };
  });

  // Server time
  const now = new Date();
  const candleMin = now.getUTCMinutes();
  const candleSec = now.getUTCSeconds();
  const secsIntoCandle = candleMin * 60 + candleSec;
  const secsRemainingInCandle = 60 - now.getUTCSeconds();

  return {
    type: 'state',
    pairs,
    sessions: sessions.map(s => s.name),
    marketOpen,
    nextEvent,
    serverTime: now.toISOString(),
    secsRemainingInCandle,
    candleNumber: candleMin
  };
}

// ── Express + WebSocket Server ───────────────────────────────
const app = express();
app.use(express.json());

// CORS for Cloudflare Pages
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  next();
});

// Health check (UptimeRobot pings this)
app.get('/', (req, res) => {
  res.json({
    status: 'running',
    pairs: PAIRS.length,
    market: isMarketOpen() ? 'OPEN' : 'CLOSED',
    sessions: getCurrentSessions().map(s => s.name),
    uptime: Math.floor(process.uptime()) + 's'
  });
});

// REST fallback (if WebSocket not available)
app.get('/api/signals', (req, res) => {
  res.json(buildState());
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const clients = new Set();

wss.on('connection', (ws) => {
  clients.add(ws);
  console.log(`[WS] Client connected. Total: ${clients.size}`);

  // Send current state immediately
  ws.send(JSON.stringify(buildState()));

  ws.on('close', () => {
    clients.delete(ws);
    console.log(`[WS] Client disconnected. Total: ${clients.size}`);
  });

  ws.on('error', () => clients.delete(ws));
});

function broadcast() {
  const state = JSON.stringify(buildState());
  for (const client of clients) {
    if (client.readyState === 1) { // OPEN
      client.send(state);
    }
  }
}

// ── Cron Jobs ────────────────────────────────────────────────

// Update all pairs every 1 minute
cron.schedule('* * * * *', async () => {
  await updateAllPairs();
  broadcast();
});

// Broadcast countdown every second (lightweight — no API calls)
cron.schedule('* * * * * *', () => {
  broadcast();
});

// Check session alerts every minute
cron.schedule('* * * * *', async () => {
  const alerts = getSessionAlerts();
  for (const alert of alerts) {
    await sendTelegram(formatSessionAlert(alert.msg));
  }
});

// ── Startup ──────────────────────────────────────────────────
server.listen(PORT, async () => {
  console.log(`\n🚀 RK DXB Trader Server — Port ${PORT}`);
  console.log(`📊 Pairs: ${PAIRS.map(p => p.symbol).join(', ')}`);
  console.log(`⏰ ${new Date().toISOString()}\n`);

  // Initial data load
  console.log('Loading initial candle data...');
  await updateAllPairs();
  console.log('✅ Initial load complete\n');

  await sendTelegram('🟢 <b>RK DXB Trader Server STARTED</b>\n\nSignal engine running 24/7 ✅\nReal market pairs loaded ✅');
});
