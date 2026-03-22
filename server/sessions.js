// ================================================================
// RK DXB Trader — Session Manager
// Forex sessions: Sydney, Tokyo (Asian), London, New York
// Crypto: always open 24/7
// ================================================================

const SESSIONS = {
  sydney:  { start: 22, end: 7,  name: 'Sydney',   emoji: '🇦🇺', forBacktest: true },
  tokyo:   { start: 0,  end: 9,  name: 'Tokyo',    emoji: '🇯🇵', forBacktest: true },
  london:  { start: 7,  end: 16, name: 'London',   emoji: '🇬🇧', forBacktest: false },
  newYork: { start: 12, end: 21, name: 'New York', emoji: '🇺🇸', forBacktest: false }
};

function getUTCHour() {
  return new Date().getUTCHours() + new Date().getUTCMinutes() / 60;
}

function getCurrentSessions() {
  const h = getUTCHour();
  const active = [];

  for (const [key, s] of Object.entries(SESSIONS)) {
    let isActive = false;
    if (s.end < s.start) {
      // Wraps midnight (Sydney: 22-7, Tokyo: 0-9)
      isActive = h >= s.start || h < s.end;
    } else {
      isActive = h >= s.start && h < s.end;
    }
    if (isActive) active.push({ key, ...s });
  }

  return active;
}

// Forex market open = any major session active
// Sydney + Tokyo = Asian session (backtesting only, but still "open" for data)
function isMarketOpen() {
  return getCurrentSessions().length > 0;
}

// Only send Telegram signals during London + NY (high volume, real trading)
function isHighVolatilitySession() {
  const sessions = getCurrentSessions();
  return sessions.some(s => s.key === 'london' || s.key === 'newYork');
}

// Is any session currently active (for showing "market open" vs "market closed")
function isForexOpen() {
  return getCurrentSessions().length > 0;
}

// Minutes until next session event
function getNextSessionEvent() {
  const now = new Date();
  const totalMin = now.getUTCHours() * 60 + now.getUTCMinutes();

  const events = [
    { time: 0  * 60, name: 'Tokyo Open',    type: 'open',  emoji: '🇯🇵' },
    { time: 7  * 60, name: 'London Open',   type: 'open',  emoji: '🇬🇧' },
    { time: 9  * 60, name: 'Tokyo Close',   type: 'close', emoji: '🇯🇵' },
    { time: 12 * 60, name: 'New York Open', type: 'open',  emoji: '🇺🇸' },
    { time: 16 * 60, name: 'London Close',  type: 'close', emoji: '🇬🇧' },
    { time: 21 * 60, name: 'NY Close',      type: 'close', emoji: '🇺🇸' },
    { time: 22 * 60, name: 'Sydney Open',   type: 'open',  emoji: '🇦🇺' }
  ];

  let next = null;
  let minDiff = Infinity;

  for (const e of events) {
    let diff = e.time - totalMin;
    if (diff <= 0) diff += 24 * 60;
    if (diff < minDiff) { minDiff = diff; next = { ...e, minutesAway: diff }; }
  }

  return next;
}

// Session boundary alerts (±1 min) — only for London + NY (main sessions)
function getSessionAlerts() {
  const now = new Date();
  const h = now.getUTCHours();
  const m = now.getUTCMinutes();
  const alerts = [];

  const checks = [
    { h: 0,  m: 0,  msg: '🇯🇵 Tokyo / Asian Session OPEN',   type: 'open' },
    { h: 7,  m: 0,  msg: '🇬🇧 London Session OPEN',          type: 'open' },
    { h: 9,  m: 0,  msg: '🇯🇵 Tokyo / Asian Session CLOSED', type: 'close' },
    { h: 12, m: 0,  msg: '🇺🇸 New York Session OPEN',        type: 'open' },
    { h: 16, m: 0,  msg: '🇬🇧 London Session CLOSED',        type: 'close' },
    { h: 21, m: 0,  msg: '🇺🇸 New York Session CLOSED',      type: 'close' },
    { h: 22, m: 0,  msg: '🇦🇺 Sydney Session OPEN',          type: 'open' },
    // 15-min warnings for main sessions
    { h: 6,  m: 45, msg: '⏰ London opens in 15 minutes',     type: 'warning' },
    { h: 11, m: 45, msg: '⏰ New York opens in 15 minutes',   type: 'warning' }
  ];

  for (const c of checks) {
    if (h === c.h && m === c.m) alerts.push({ msg: c.msg, type: c.type });
  }

  return alerts;
}

module.exports = {
  getCurrentSessions, isMarketOpen, isForexOpen,
  isHighVolatilitySession, getNextSessionEvent, getSessionAlerts
};
