// RK DXB — PO Live Feed: Service Worker
let tickCount = 0;
let lastPairs = [];

chrome.runtime.onMessage.addListener(function (msg) {
  if (msg.type === 'TICK_UPDATE') {
    tickCount += msg.count || 0;
    lastPairs = msg.pairs || lastPairs;
  }
});
