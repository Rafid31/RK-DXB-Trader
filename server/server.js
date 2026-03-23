// ================================================================
// RK DXB Trader — Main Server v2
// Fixes: session gate on Telegram, smart API batching,
//        admin panel, single-device per email
// ================================================================
const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');
const fetch = require('node-fetch');
const cron = require('node-cron');

const { getKey } = require('./apiKeys');
const { fetchCryptoCandles } = require('./binance');
const { updateAllOTC, getOTCState } = require('./poOTC');
const { calculateSignal } = require('./signalEngine');
const { getCurrentSessions, isMarketOpen, isForexOpen, isHighVolatilitySession, getNextSessionEvent, getSessionAlerts } = require('./sessions');
const { sendTelegram, formatSignalAlert, formatSessionAlert } = require('./telegram');

const PORT = process.env.PORT || 3001;

// ── Authorized users ─────────────────────────────────────────
let authorizedEmails = new Set(['rafhidk.rk@gmail.com']);

// ── Active sessions: email -> { token, ip, connectedAt } ────
const activeSessions = new Map();
const wsClients = new Map(); // ws -> { email, token, ip }

// ── Pairs ────────────────────────────────────────────────────
const PAIRS = [
  { symbol: 'EUR/USD' }, { symbol: 'GBP/USD' }, { symbol: 'USD/JPY' },
  { symbol: 'AUD/USD' }, { symbol: 'USD/CAD' }, { symbol: 'EUR/GBP' },
  { symbol: 'GBP/JPY' }, { symbol: 'EUR/JPY' }
];

const CRYPTO_PAIRS = [
  { symbol: 'BTC/USD', type: 'crypto' },
  { symbol: 'ETH/USD', type: 'crypto' }
];

const ALL_PAIRS = [...PAIRS.map(p => ({...p, type:'forex'})), ...CRYPTO_PAIRS];

const candleStore = {};
const lastSignals = {};
const sentSignals = new Set();
ALL_PAIRS.forEach(p => {
  candleStore[p.symbol] = [];
  lastSignals[p.symbol] = { signal: 'WAIT', confidence: 0 };
});

// ── Fetcher ──────────────────────────────────────────────────
async function fetchCandles(symbol, outputsize = 90) {
  const key = getKey();
  const url = `https://api.twelvedata.com/time_series?symbol=${symbol}&interval=1min&outputsize=${outputsize}&apikey=${key}`;
  try {
    const res = await fetch(url, { timeout: 12000 });
    const data = await res.json();
    if (data.status === 'error' || !data.values) {
      console.warn(`[${symbol}] API warn: ${data.message || JSON.stringify(data).slice(0,80)}`);
      return null;
    }
    return data.values.reverse().map(v => ({
      time: v.datetime, open: parseFloat(v.open), high: parseFloat(v.high),
      low: parseFloat(v.low), close: parseFloat(v.close), volume: parseFloat(v.volume) || 0
    }));
  } catch (err) {
    console.error(`[${symbol}] Fetch failed: ${err.message}`);
    return null;
  }
}

// ── Update pair + Telegram gating ───────────────────────────
async function updatePair(pair) {
  // Fetch from correct data source
  const candles = pair.type === 'crypto'
    ? await fetchCryptoCandles(pair.symbol)
    : await fetchCandles(pair.symbol);
  if (!candles || candles.length < 30) return;

  candleStore[pair.symbol] = candles;
  const result = calculateSignal(candles);
  lastSignals[pair.symbol] = { ...result, updatedAt: new Date().toISOString() };

  // Telegram gating:
  // Crypto = 24/7 (Binance never closes)
  // Forex = only London + NY sessions (high volume, real trading)
  const canAlert = pair.type === 'crypto' ? true : isHighVolatilitySession();
  if (!canAlert) return;

  const signalKey = `${pair.symbol}-${result.signal}-${Math.floor(Date.now() / 60000)}`;
  if (result.signal !== 'WAIT' && result.confidence >= 70 && !sentSignals.has(signalKey)) {
    sentSignals.add(signalKey);
    if (sentSignals.size > 200) sentSignals.delete(sentSignals.values().next().value);
    await sendTelegram(formatSignalAlert(pair.symbol, result.signal, result.confidence, result.reasons || []));
  }
}

async function updateAllPairs() {
  // Forex pairs — stagger 1.5s each (Twelve Data rate limit)
  for (let i = 0; i < PAIRS.length; i++) {
    await updatePair({ ...PAIRS[i], type: 'forex' });
    if (i < PAIRS.length - 1) await new Promise(r => setTimeout(r, 1500));
  }
  // Crypto pairs — Binance, no rate limit
  for (const cp of CRYPTO_PAIRS) {
    await updatePair(cp);
  }
  console.log(`[${new Date().toISOString()}] ${ALL_PAIRS.length} pairs | Forex: ${isForexOpen() ? 'OPEN' : 'CLOSED'} | Crypto: 24/7`);
}

// ── Build state ──────────────────────────────────────────────
function buildState() {
  const sessions = getCurrentSessions();
  const nextEvent = getNextSessionEvent();
  const marketOpen = isForexOpen(); // forex session open
  const cryptoActive = true; // crypto always 24/7
  const now = new Date();
  const pairs = ALL_PAIRS.map(p => {
    const candles = candleStore[p.symbol];
    const signal = lastSignals[p.symbol];
    const price = candles.length > 0 ? candles[candles.length - 1].close : null;
    const prev = candles.length > 1 ? candles[candles.length - 2].close : null;
    const change = price && prev ? ((price - prev) / prev) * 100 : 0;
    return {
      symbol: p.symbol,
      type: p.type || 'forex',
      price: price ? (price >= 1000 ? price.toFixed(2) : price > 10 ? price.toFixed(3) : price.toFixed(5)) : '—',
      change: +change.toFixed(3),
      signal: signal.signal || 'WAIT', confidence: signal.confidence || 0,
      rsi: signal.rsi, stoch: signal.stoch, macd: signal.macd,
      wr: signal.wr, cci: signal.cci, emaTrend: signal.emaTrend,
      pattern: signal.pattern, streak: signal.streak, bbPos: signal.bbPos,
      reasons: signal.reasons || [], updatedAt: signal.updatedAt || null
    };
  });
  return {
    type: 'state', pairs, sessions: sessions.map(s => s.name),
    marketOpen, cryptoActive: true, nextEvent,
    serverTime: now.toISOString(),
    secsRemainingInCandle: 60 - now.getUTCSeconds()
  };
}

// ── Express ──────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Admin-Key');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.get('/', (req, res) => res.json({
  status: 'running', pairs: PAIRS.length,
  market: isMarketOpen() ? 'OPEN' : 'CLOSED',
  uptime: Math.floor(process.uptime()) + 's'
}));

app.get('/api/signals', (req, res) => res.json(buildState()));
app.get('/api/otc', (req, res) => res.json({ type: 'otc', pairs: getOTCState(), serverTime: new Date().toISOString() }));

// QX test endpoint - tests if Render can reach qxbroker.com
app.get('/api/qx-test', async (req, res) => {
  try {
    const { testQXWebSocket } = require('./qxTest');
    const result = await testQXWebSocket();
    res.json({ success: true, result });
  } catch(e) {
    res.json({ success: false, error: e.message });
  }
});

// ── Auth endpoints ───────────────────────────────────────────
app.post('/api/auth/login', (req, res) => {
  const { email } = req.body;
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress;
  if (!email || !authorizedEmails.has(email.toLowerCase())) {
    return res.status(403).json({ ok: false, error: 'Unauthorized email' });
  }
  const token = Math.random().toString(36).slice(2) + Date.now().toString(36);
  activeSessions.set(email.toLowerCase(), { token, ip, connectedAt: new Date().toISOString() });
  console.log(`[AUTH] Login: ${email} from ${ip}`);
  res.json({ ok: true, token, email: email.toLowerCase() });
});

app.post('/api/auth/verify', (req, res) => {
  const { email, token } = req.body;
  const session = activeSessions.get(email?.toLowerCase());
  if (!session || session.token !== token) return res.status(401).json({ ok: false });
  res.json({ ok: true });
});

app.post('/api/auth/logout', (req, res) => {
  const { email } = req.body;
  if (email) activeSessions.delete(email.toLowerCase());
  res.json({ ok: true });
});

// ── Admin endpoints ──────────────────────────────────────────
const ADMIN_KEY = process.env.ADMIN_KEY || 'rafixadmin2024';
function adminAuth(req, res, next) {
  const key = req.headers['x-admin-key'] || req.query.key;
  if (key !== ADMIN_KEY) return res.status(403).json({ error: 'Forbidden' });
  next();
}

app.get('/admin/users', adminAuth, (req, res) => {
  res.json({
    emails: [...authorizedEmails],
    sessions: Object.fromEntries([...activeSessions.entries()].map(([e, s]) => [e, { ip: s.ip, connectedAt: s.connectedAt }]))
  });
});

app.post('/admin/users', adminAuth, (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required' });
  authorizedEmails.add(email.toLowerCase());
  console.log(`[ADMIN] Added: ${email}`);
  res.json({ ok: true, total: authorizedEmails.size });
});

app.delete('/admin/users/:email', adminAuth, (req, res) => {
  const email = decodeURIComponent(req.params.email).toLowerCase();
  authorizedEmails.delete(email);
  activeSessions.delete(email);
  for (const [ws, meta] of wsClients.entries()) {
    if (meta.email === email) { ws.close(4003, 'Removed by admin'); wsClients.delete(ws); }
  }
  res.json({ ok: true, total: authorizedEmails.size });
});

app.delete('/admin/sessions/:email', adminAuth, (req, res) => {
  const email = decodeURIComponent(req.params.email).toLowerCase();
  activeSessions.delete(email);
  for (const [ws, meta] of wsClients.entries()) {
    if (meta.email === email) { ws.close(4003, 'Kicked by admin'); wsClients.delete(ws); }
  }
  res.json({ ok: true });
});

// ── WebSocket ────────────────────────────────────────────────
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

wss.on('connection', (ws, req) => {
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress;
  ws.send(JSON.stringify(buildState())); // immediate state, pre-auth

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'auth') {
        const { email, token } = msg;
        const session = activeSessions.get(email?.toLowerCase());
        if (!session || session.token !== token) {
          ws.send(JSON.stringify({ type: 'auth_failed', reason: 'Invalid session' }));
          return ws.close(4001, 'Unauthorized');
        }
        // Kick any existing WS for same email (single device)
        for (const [oldWs, meta] of wsClients.entries()) {
          if (meta.email === email.toLowerCase() && oldWs !== ws) {
            oldWs.send(JSON.stringify({ type: 'kicked', reason: 'Logged in from another device' }));
            oldWs.close(4002, 'Another device logged in');
            wsClients.delete(oldWs);
          }
        }
        wsClients.set(ws, { email: email.toLowerCase(), token, ip });
        ws.send(JSON.stringify({ type: 'auth_ok' }));
        console.log(`[WS] Auth: ${email} | Total: ${wsClients.size}`);
      }
    } catch(e) {}
  });

  ws.on('close', () => { wsClients.delete(ws); });
  ws.on('error', () => wsClients.delete(ws));
});

function broadcastOTC() {
  const state = JSON.stringify({ type: 'otc', pairs: getOTCState(), serverTime: new Date().toISOString() });
  for (const [ws] of wsClients) { if (ws.readyState === 1) ws.send(state); }
}

function broadcast() {
  const state = JSON.stringify(buildState());
  for (const [ws] of wsClients) { if (ws.readyState === 1) ws.send(state); }
}

// ── Cron ─────────────────────────────────────────────────────
cron.schedule('* * * * *', async () => { await updateAllPairs(); broadcast(); });
cron.schedule('* * * * * *', () => { broadcast(); });

// Update OTC every second - po-static.com is live per second
cron.schedule('* * * * * *', async () => {
  await updateAllOTC();
  broadcastOTC();
});
cron.schedule('* * * * *', async () => {
  const alerts = getSessionAlerts();
  for (const alert of alerts) await sendTelegram(formatSessionAlert(alert.msg));
});

// ── Start ─────────────────────────────────────────────────────
server.listen(PORT, async () => {
  console.log(`\n🚀 RK DXB Trader v2 — Port ${PORT}`);
  await updateAllPairs();
  console.log('✅ Ready\n');
  // Start OTC data collection
  console.log('Loading initial OTC data...');
  await updateAllOTC();
  console.log('✅ OTC ready\n');
    await sendTelegram('🟢 <b>RK DXB Trader v3.1</b>\n\n✅ 10 real market pairs\n✅ 12 PO OTC pairs (new!)\n✅ OTC data from po-static.com\n✅ 24/7 all markets');
});
