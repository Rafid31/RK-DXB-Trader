function load() {
  chrome.runtime.sendMessage({ type: 'GET_STATS' }, function(stats) {
    if (chrome.runtime.lastError) return;
    if (!stats) return;
    document.getElementById('pairs').textContent = stats.activePairs ? stats.activePairs.length : 0;
    document.getElementById('sent').textContent = (stats.totalSent || 0).toLocaleString();
    if (stats.lastUpdate) {
      var ago = Math.round((Date.now() - stats.lastUpdate) / 1000);
      var el = document.getElementById('time');
      el.textContent = ago < 10 ? 'Just now' : ago + 's ago';
      el.style.color = ago < 10 ? '#00e676' : ago < 30 ? '#ffd060' : '#ff3f5a';
    }
    var grid = document.getElementById('grid');
    var status = document.getElementById('status');
    if (stats.activePairs && stats.activePairs.length > 0) {
      grid.innerHTML = stats.activePairs.slice(0, 20).map(function(p) {
        return '<span class="chip">' + p.replace('_otc', '') + '</span>';
      }).join('');
      var fresh = stats.lastUpdate && (Date.now() - stats.lastUpdate) < 5000;
      status.className = 'status ' + (fresh ? 'on' : 'off');
      status.textContent = fresh ? 'Live - sending to server' : 'Stale - reopen QX tab';
    } else {
      grid.innerHTML = '<span style="color:#4a5a80;font-size:10px">No data yet</span>';
      status.className = 'status off';
      status.textContent = 'Open qxbroker.com/en/trade';
    }
  });
}
document.addEventListener('DOMContentLoaded', function() {
  load();
  setInterval(load, 2000);
});
