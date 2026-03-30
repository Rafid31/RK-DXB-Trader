// RK DXB — PO Live Feed: Content Script
// Injects the WebSocket interceptor into the page's MAIN world context
// (required because extensions run in isolated world by default)

(function () {
  // Step 1: inject interceptor into main world
  const script = document.createElement('script');
  script.src = chrome.runtime.getURL('injected.js');
  script.onload = function () { this.remove(); };
  (document.head || document.documentElement).appendChild(script);

  // Step 2: relay captured ticks to the server
  window.addEventListener('__RK_PO_TICKS__', function (event) {
    const ticks = event.detail;
    if (!ticks || !ticks.length) return;

    // Send to RK DXB server
    fetch('https://rk-dxb-trader.onrender.com/api/po-tick', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ ticks: ticks, source: 'po_ext_v1' })
    }).catch(function () {});

    // Update popup stats
    chrome.runtime.sendMessage({
      type:  'TICK_UPDATE',
      count: ticks.length,
      pairs: ticks.map(t => t.sym)
    }).catch(function () {});
  });
})();
