// QX connection test — called once to verify pyquotex works on Render
// Uses the SSID session injection approach (no Chrome needed after first auth)
const fetch = require('node-fetch');

// Test if we can connect to QX WebSocket directly using session auth
// QX WS protocol: connect → send 40 (socket.io handshake) → send auth → subscribe candles

async function testQXWebSocket() {
  const results = {};
  
  // Step 1: HTTP login to get SSID token
  console.log('[QX Test] Step 1: Getting SSID via HTTP login...');
  
  try {
    // First get the login page to get any CSRF tokens
    const loginPageRes = await fetch('https://qxbroker.com/en/sign-in', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml',
      },
      redirect: 'follow'
    });
    
    results.loginPageStatus = loginPageRes.status;
    console.log('[QX Test] Login page status:', loginPageRes.status);
    
    const html = await loginPageRes.text();
    
    // Extract CSRF token
    const csrfMatch = html.match(/name="_token"\s+value="([^"]+)"/);
    const csrf = csrfMatch ? csrfMatch[1] : null;
    console.log('[QX Test] CSRF found:', !!csrf);
    results.csrfFound = !!csrf;
    
    if (csrf) {
      // Step 2: POST login
      const cookies = loginPageRes.headers.get('set-cookie') || '';
      
      const loginRes = await fetch('https://qxbroker.com/en/sign-in', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Referer': 'https://qxbroker.com/en/sign-in',
          'Cookie': cookies.split(',').map(c => c.split(';')[0]).join('; ')
        },
        body: new URLSearchParams({
          '_token': csrf,
          'email': 'rafiddxb2@gmail.com',
          'password': 'Rafid.01815'
        }).toString(),
        redirect: 'manual'
      });
      
      results.loginStatus = loginRes.status;
      results.loginLocation = loginRes.headers.get('location');
      console.log('[QX Test] Login response:', loginRes.status, loginRes.headers.get('location'));
    }
    
  } catch(e) {
    results.error = e.message;
    console.log('[QX Test] HTTP Error:', e.message);
  }
  
  return results;
}

module.exports = { testQXWebSocket };
