// RK DXB QX Signal Pro - Content Script
// Injects the WebSocket interceptor into the page's main world

(function() {
  // Inject the interceptor script into the page's main context
  const script = document.createElement('script');
  script.src = chrome.runtime.getURL('injected.js');
  script.onload = function() { this.remove(); };
  (document.head || document.documentElement).appendChild(script);
})();

// Listen for tick data from the injected script
window.addEventListener('__RK_TICK_DATA__', function(event) {
  const ticks = event.detail;
  if (!ticks || !ticks.length) return;

  // Send to our Render server
  fetch('https://rk-dxb-trader.onrender.com/api/qx-push', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ticks: ticks, source: 'qx_ext_v2' })
  }).catch(function() {});

  // Update stats for popup
  chrome.runtime.sendMessage({
    type: 'TICK_UPDATE',
    count: ticks.length,
    pairs: ticks.map(function(t) { return t.sym; })
  }).catch(function() {});
});
