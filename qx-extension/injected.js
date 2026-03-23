// RK DXB QX Signal Pro - WebSocket Interceptor
(function() {
  'use strict';
  var allTicks = {};
  var sendTimer = null;

  function scheduleSend() {
    if (sendTimer) return;
    sendTimer = setTimeout(function() {
      sendTimer = null;
      var ticks = Object.values(allTicks);
      if (ticks.length > 0) {
        window.dispatchEvent(new CustomEvent('__RK_TICK_DATA__', { detail: ticks }));
      }
    }, 1000);
  }

  function processTick(asset, price) {
    if (!asset || price === undefined || price === null) return;
    var sym = String(asset).toLowerCase();
    if (!sym.endsWith('_otc')) sym = sym + '_otc';
    var p = parseFloat(price);
    if (isNaN(p) || p <= 0) return;
    allTicks[sym] = { sym: sym, price: p, ts: Date.now() };
    scheduleSend();
  }

  var OrigWS = window.WebSocket;

  function RKWebSocket(url, protocols) {
    var ws = protocols ? new OrigWS(url, protocols) : new OrigWS(url);
    ws.addEventListener('message', function(event) {
      try {
        var data = event.data;
        if (typeof data !== 'string') return;
        var json = null;
        if (data.indexOf('42[') === 0) json = data.slice(2);
        else if (data.indexOf('451-[') === 0) json = data.slice(4);
        else if (data[0] === '[' || data[0] === '{') json = data;
        if (!json) return;
        var parsed = JSON.parse(json);
        if (Array.isArray(parsed) && parsed.length >= 2) {
          var ev = parsed[0], pl = parsed[1];
          if (!pl) return;
          if (ev === 'tick' || ev === 'quote' || ev === 'price') {
            if (pl.asset) processTick(pl.asset, pl.price || pl.close);
          } else if (ev === 'candles' || ev === 'history') {
            if (pl.asset && Array.isArray(pl.candles) && pl.candles.length) {
              var last = pl.candles[pl.candles.length - 1];
              if (last) processTick(pl.asset, last.close || last.c);
            }
          } else if (pl && typeof pl === 'object') {
            if (pl.asset) processTick(pl.asset, pl.price || pl.close);
            if (Array.isArray(pl.data)) pl.data.forEach(function(i) { if (i && i.asset) processTick(i.asset, i.price || i.close); });
          }
        } else if (!Array.isArray(parsed) && parsed && parsed.asset) {
          processTick(parsed.asset, parsed.price || parsed.close);
        }
      } catch(e) {}
    });
    return ws;
  }

  // IMPORTANT: Only set prototype, never assign read-only CONNECTING/OPEN/CLOSING/CLOSED
  RKWebSocket.prototype = OrigWS.prototype;
  Object.setPrototypeOf(RKWebSocket, OrigWS);
  window.WebSocket = RKWebSocket;
  console.log('[RK DXB] interceptor active');
})();
