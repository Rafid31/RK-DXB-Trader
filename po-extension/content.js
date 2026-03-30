// RK DXB — PO Live Feed: Content Script (isolated world)
// injected.js now runs in MAIN world directly via manifest "world":"MAIN"
// This script handles the bridge: CustomEvent → server fetch + popup update

window.addEventListener('__RK_PO_TICKS__', function (event) {
  const ticks = event.detail;
  if (!ticks || !ticks.length) return;

  // Send tick batch to RK DXB server
  fetch('https://rk-dxb-trader.onrender.com/api/po-tick', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ ticks: ticks, source: 'po_ext_v1.1' })
  }).catch(function () {});

  // Update popup stats
  chrome.runtime.sendMessage({
    type:  'TICK_UPDATE',
    count: ticks.length,
    pairs: ticks.map(function (t) { return t.sym; })
  }).catch(function () {});
});
