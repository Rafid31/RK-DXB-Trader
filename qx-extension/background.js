// RK DXB QX Signal Pro - Background Service Worker

var stats = { totalSent: 0, activePairs: [], lastUpdate: null };

chrome.runtime.onMessage.addListener(function(msg, sender, sendResponse) {
  if (msg.type === 'TICK_UPDATE') {
    stats.totalSent += msg.count || 0;
    stats.activePairs = msg.pairs || [];
    stats.lastUpdate = Date.now();
    // Show pair count on badge
    chrome.action.setBadgeText({ text: String(stats.activePairs.length) });
    chrome.action.setBadgeBackgroundColor({ color: '#00e676' });
  }
  if (msg.type === 'GET_STATS') {
    sendResponse(stats);
  }
  return true;
});
