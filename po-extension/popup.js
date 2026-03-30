// Check server for live feed status
async function checkStatus() {
  try {
    const r = await fetch('https://rk-dxb-trader.onrender.com/api/po-status');
    const d = await r.json();
    document.getElementById('dot').className    = 'dot ' + (d.live ? 'on' : 'off');
    document.getElementById('status').textContent = d.live ? 'LIVE' : 'Waiting…';
    document.getElementById('count').textContent  = d.totalTicks || 0;
    document.getElementById('pairCount').textContent = (d.pairs || []).length;
    document.getElementById('pairs').textContent  = (d.pairs || []).join(' · ');
  } catch (e) {
    document.getElementById('status').textContent = 'Server offline';
  }
}

document.getElementById('openSite').addEventListener('click', function () {
  chrome.tabs.create({ url: 'https://rk-dxb-trader.pages.dev/otc' });
});

checkStatus();
setInterval(checkStatus, 3000);
