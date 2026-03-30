// ============================================================
// RK DXB Trader — Pocket Option WebSocket Interceptor v1.1
// Runs as content script in MAIN world at document_start
// Patches window.WebSocket BEFORE Pocket Option connects
// ============================================================

(function () {
  'use strict';

  if (window.__rkPOInjected) return;   // prevent double-injection
  window.__rkPOInjected = true;
  window.__rkPOTicks    = 0;

  // Batch buffer — collect ticks and flush every 900ms
  var pending   = {};
  var flushTimer = null;

  function scheduleSend() {
    if (flushTimer) return;
    flushTimer = setTimeout(function () {
      flushTimer = null;
      var batch = Object.values(pending);
      pending = {};
      if (!batch.length) return;
      window.__rkPOTicks += batch.length;
      window.dispatchEvent(new CustomEvent('__RK_PO_TICKS__', { detail: batch }));
      updateBadge();
    }, 900);
  }

  function recordTick(asset, price, ts) {
    if (!asset || price === undefined || price === null) return;
    var sym = String(asset).toLowerCase().trim();
    if (!sym.endsWith('_otc')) sym += '_otc';
    var p = parseFloat(price);
    if (isNaN(p) || p <= 0) return;
    pending[sym] = { sym: sym, price: p, ts: ts || Date.now() };
    scheduleSend();
  }

  // ── Parse one WebSocket message ───────────────────────────────
  function parseMsg(raw) {
    if (typeof raw !== 'string') return;
    var json = null;

    if      (raw.indexOf('42[') === 0)    json = raw.slice(2);
    else if (raw.indexOf('451-[') === 0)  json = raw.slice(4);
    else if (raw.indexOf('42{') === 0)    json = raw.slice(2);
    else if (raw[0] === '[' || raw[0] === '{') json = raw;
    else return;

    var d;
    try { d = JSON.parse(json); } catch (e) { return; }

    // ["event", payload]
    if (Array.isArray(d) && d.length >= 2) {
      var ev = d[0], pl = d[1];
      if (!pl) return;

      if (['tick','quote','price','stream','asset/tick','realtime'].indexOf(ev) >= 0) {
        if (pl.asset) recordTick(pl.asset, pl.price || pl.value || pl.close, pl.time);
        return;
      }
      if (['candles','history','asset/generate','chart','ohlc'].indexOf(ev) >= 0) {
        if (pl.asset && Array.isArray(pl.candles) && pl.candles.length) {
          var last = pl.candles[pl.candles.length - 1];
          if (last) recordTick(pl.asset, last.close || last.c || last[4], pl.time || last.time);
        }
        if (pl.asset && pl.price) recordTick(pl.asset, pl.price, pl.time);
        return;
      }
      // Any payload with asset field
      if (pl && typeof pl === 'object') {
        if (pl.asset) recordTick(pl.asset, pl.price || pl.close || pl.value, pl.time);
        if (Array.isArray(pl.data)) {
          pl.data.forEach(function (i) {
            if (i && i.asset) recordTick(i.asset, i.price || i.close, i.time);
          });
        }
      }
      return;
    }

    // plain { asset, price }
    if (!Array.isArray(d) && d && typeof d === 'object') {
      if (d.asset) recordTick(d.asset, d.price || d.close, d.time);
      if (Array.isArray(d.ticks)) {
        d.ticks.forEach(function (t) {
          if (t && t.asset) recordTick(t.asset, t.price || t.close, t.time);
        });
      }
    }
  }

  // ── Patch window.WebSocket ────────────────────────────────────
  var OrigWS = window.WebSocket;
  if (!OrigWS) return;   // shouldn't happen, safety check

  function RKWebSocket(url, protocols) {
    var ws = protocols ? new OrigWS(url, protocols) : new OrigWS(url);
    ws.addEventListener('message', function (e) {
      try { parseMsg(e.data); } catch (_) {}
    });
    return ws;
  }

  RKWebSocket.prototype = OrigWS.prototype;
  Object.setPrototypeOf(RKWebSocket, OrigWS);
  window.WebSocket   = RKWebSocket;
  window.__rkOrigWS  = OrigWS;

  // ── Status badge ─────────────────────────────────────────────
  var badge = null;

  function createBadge() {
    if (document.getElementById('__rk_badge__')) return;
    badge = document.createElement('div');
    badge.id = '__rk_badge__';
    badge.style.cssText = [
      'position:fixed', 'top:62px', 'right:10px', 'z-index:2147483647',
      'background:#0f172a', 'color:#00e676',
      'border:1px solid #00e676', 'border-radius:8px',
      'padding:4px 10px', 'font:bold 11px monospace',
      'pointer-events:none', 'letter-spacing:0.5px'
    ].join(';');
    badge.textContent = '🟢 RK FEED · waiting…';
    document.body.appendChild(badge);
  }

  function updateBadge() {
    var b = badge || document.getElementById('__rk_badge__');
    if (b) b.textContent = '🟢 RK FEED · ' + window.__rkPOTicks + ' ticks';
  }

  // Create badge as soon as body exists
  if (document.body) {
    createBadge();
  } else {
    document.addEventListener('DOMContentLoaded', createBadge);
  }

  // Keep badge text updated
  setInterval(updateBadge, 2000);

  console.log('[RK DXB v1.1] WebSocket patched at document_start');
})();
