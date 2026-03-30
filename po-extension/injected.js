// ============================================================
// RK DXB Trader — Pocket Option WebSocket Interceptor
// Injected at document_start into page's MAIN world
// Captures ALL live tick/candle data from PO WebSocket
// ============================================================
(function () {
  'use strict';

  var SERVER = 'https://rk-dxb-trader.onrender.com';

  // Rolling buffer: collects ticks and flushes every 1 second
  var pendingTicks = {};   // sym -> latest tick (deduped)
  var flushTimer   = null;
  var tickCount    = 0;

  function scheduleSend() {
    if (flushTimer) return;
    flushTimer = setTimeout(function () {
      flushTimer = null;
      var batch = Object.values(pendingTicks);
      pendingTicks = {};
      if (!batch.length) return;
      window.dispatchEvent(new CustomEvent('__RK_PO_TICKS__', { detail: batch }));
    }, 900);
  }

  function processTick(asset, price, ts) {
    if (!asset || price === undefined || price === null) return;
    var sym = String(asset).toLowerCase().trim();
    if (!sym.endsWith('_otc')) sym = sym + '_otc';
    var p = parseFloat(price);
    if (isNaN(p) || p <= 0) return;
    pendingTicks[sym] = { sym: sym, price: p, ts: ts || Date.now() };
    tickCount++;
    scheduleSend();
  }

  // ── Parse one WebSocket message frame ─────────────────────────
  function parseMessage(raw) {
    if (typeof raw !== 'string') return;
    var json = null;

    // Socket.IO: "42[...]" or "451-[...]"
    if (raw.indexOf('42[') === 0)    json = raw.slice(2);
    else if (raw.indexOf('451-[') === 0) json = raw.slice(4);
    else if (raw.indexOf('42{') === 0) json = raw.slice(2);
    else if (raw[0] === '[' || raw[0] === '{') json = raw;
    else return;

    var parsed;
    try { parsed = JSON.parse(json); } catch (e) { return; }

    // ── Format 1: ["event", payload] ──────────────────────────
    if (Array.isArray(parsed) && parsed.length >= 2) {
      var ev = parsed[0];
      var pl = parsed[1];

      // Tick / quote / price event
      if (['tick', 'quote', 'price', 'stream', 'asset/tick'].indexOf(ev) >= 0) {
        if (pl && pl.asset) processTick(pl.asset, pl.price || pl.value || pl.close, pl.time);
        return;
      }

      // Candle / history event — use last closed candle close price
      if (['candles', 'history', 'asset/generate', 'chart'].indexOf(ev) >= 0) {
        if (pl && pl.asset && Array.isArray(pl.candles) && pl.candles.length) {
          var last = pl.candles[pl.candles.length - 1];
          if (last) processTick(pl.asset, last.close || last.c || last[4], pl.time || last.time);
        }
        if (pl && pl.asset && pl.price) processTick(pl.asset, pl.price, pl.time);
        return;
      }

      // Any event with asset field in payload
      if (pl && typeof pl === 'object') {
        if (pl.asset) processTick(pl.asset, pl.price || pl.close || pl.value, pl.time);
        if (Array.isArray(pl.data)) {
          pl.data.forEach(function (item) {
            if (item && item.asset) processTick(item.asset, item.price || item.close, item.time);
          });
        }
      }
      return;
    }

    // ── Format 2: plain object { asset, price } ───────────────
    if (!Array.isArray(parsed) && typeof parsed === 'object') {
      if (parsed.asset && (parsed.price || parsed.close)) {
        processTick(parsed.asset, parsed.price || parsed.close, parsed.time);
      }
      // Array of ticks at root level
      if (Array.isArray(parsed.ticks)) {
        parsed.ticks.forEach(function (t) {
          if (t && t.asset) processTick(t.asset, t.price || t.close, t.time);
        });
      }
    }
  }

  // ── Patch window.WebSocket ────────────────────────────────────
  var OrigWS = window.WebSocket;

  function RKWebSocket(url, protocols) {
    var ws = protocols ? new OrigWS(url, protocols) : new OrigWS(url);
    ws.addEventListener('message', function (e) {
      try { parseMessage(e.data); } catch (_) {}
    });
    return ws;
  }

  RKWebSocket.prototype = OrigWS.prototype;
  Object.setPrototypeOf(RKWebSocket, OrigWS);
  window.WebSocket = RKWebSocket;

  // Status badge (top-right of page)
  var badge = document.createElement('div');
  badge.id  = '__rk_badge__';
  badge.style.cssText = [
    'position:fixed', 'top:60px', 'right:10px', 'z-index:2147483647',
    'background:#0f172a', 'color:#00e676', 'border:1px solid #00e676',
    'border-radius:8px', 'padding:5px 10px', 'font:bold 11px monospace',
    'pointer-events:none', 'opacity:0.9'
  ].join(';');
  badge.textContent = '🟢 RK LIVE FEED';

  document.addEventListener('DOMContentLoaded', function () {
    if (!document.getElementById('__rk_badge__')) document.body.appendChild(badge);
  });
  if (document.body) document.body.appendChild(badge);

  // Update badge with tick count every second
  setInterval(function () {
    badge.textContent = '🟢 RK FEED · ' + tickCount + ' ticks';
  }, 2000);

  console.log('[RK DXB] PO tick interceptor active');
})();
