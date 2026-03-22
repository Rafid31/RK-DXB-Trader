// Forex Trading Sessions (UTC)
// Sydney:  22:00 - 07:00
// Tokyo:   00:00 - 09:00
// London:  07:00 - 16:00  ← MAIN
// New York: 12:00 - 21:00 ← MAIN
// Best overlap: London+NY 12:00-16:00 UTC

const SESSIONS = {
  london: { start: 7, end: 16, name: 'London', emoji: '🇬🇧' },
  newYork: { start: 12, end: 21, name: 'New York', emoji: '🇺🇸' },
  tokyo: { start: 0, end: 9, name: 'Tokyo', emoji: '🇯🇵' },
  sydney: { start: 22, end: 31, name: 'Sydney', emoji: '🇦🇺' } // wraps midnight
};

function getCurrentSessions() {
  const now = new Date();
  const utcHour = now.getUTCHours() + now.getUTCMinutes() / 60;
  const active = [];

  for (const [key, s] of Object.entries(SESSIONS)) {
    let isActive = false;
    if (s.end > 24) {
      // wraps midnight (Sydney)
      isActive = utcHour >= s.start || utcHour < (s.end - 24);
    } else {
      isActive = utcHour >= s.start && utcHour < s.end;
    }
    if (isActive) active.push({ key, ...s });
  }

  return active;
}

function isMarketOpen() {
  const sessions = getCurrentSessions();
  return sessions.some(s => s.key === 'london' || s.key === 'newYork' || s.key === 'tokyo');
}

function isHighVolatilitySession() {
  const sessions = getCurrentSessions();
  const hasLondon = sessions.some(s => s.key === 'london');
  const hasNY = sessions.some(s => s.key === 'newYork');
  return hasLondon || hasNY;
}

// Returns minutes until next session event (open or close)
function getNextSessionEvent() {
  const now = new Date();
  const utcHour = now.getUTCHours();
  const utcMin = now.getUTCMinutes();
  const totalMin = utcHour * 60 + utcMin;

  const events = [
    { time: 7 * 60, name: 'London Open', type: 'open', emoji: '🇬🇧' },
    { time: 12 * 60, name: 'New York Open', type: 'open', emoji: '🇺🇸' },
    { time: 16 * 60, name: 'London Close', type: 'close', emoji: '🇬🇧' },
    { time: 21 * 60, name: 'New York Close', type: 'close', emoji: '🇺🇸' }
  ];

  let next = null;
  let minDiff = Infinity;

  for (const e of events) {
    let diff = e.time - totalMin;
    if (diff <= 0) diff += 24 * 60;
    if (diff < minDiff) {
      minDiff = diff;
      next = { ...e, minutesAway: diff };
    }
  }

  return next;
}

// Check if we're exactly at a session boundary (±1 min)
function getSessionAlerts() {
  const now = new Date();
  const utcHour = now.getUTCHours();
  const utcMin = now.getUTCMinutes();
  const alerts = [];

  const checks = [
    { h: 7, m: 0, msg: '🇬🇧 London Session OPEN', type: 'open' },
    { h: 12, m: 0, msg: '🇺🇸 New York Session OPEN', type: 'open' },
    { h: 16, m: 0, msg: '🇬🇧 London Session CLOSED', type: 'close' },
    { h: 21, m: 0, msg: '🇺🇸 New York Session CLOSED', type: 'close' },
    // 15 min warnings
    { h: 6, m: 45, msg: '⏰ London opens in 15 minutes', type: 'warning' },
    { h: 11, m: 45, msg: '⏰ New York opens in 15 minutes', type: 'warning' }
  ];

  for (const c of checks) {
    if (utcHour === c.h && utcMin === c.m) {
      alerts.push({ msg: c.msg, type: c.type });
    }
  }

  return alerts;
}

module.exports = { getCurrentSessions, isMarketOpen, isHighVolatilitySession, getNextSessionEvent, getSessionAlerts };
