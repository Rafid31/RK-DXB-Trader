// Telegram Alerts for Rafid
const fetch = require('node-fetch');

const TOKEN = process.env.TELEGRAM_TOKEN || '8701910654:AAE5Xcl3tFRGhtArlOXjFQ9EFlnL3IOBl1U';
const CHAT_ID = process.env.TELEGRAM_CHAT_ID || '6063240252';

async function sendTelegram(text) {
  try {
    const url = `https://api.telegram.org/bot${TOKEN}/sendMessage`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: CHAT_ID,
        text,
        parse_mode: 'HTML'
      })
    });
    const data = await res.json();
    if (!data.ok) console.error('Telegram error:', data.description);
  } catch (err) {
    console.error('Telegram send failed:', err.message);
  }
}

function formatSignalAlert(pair, signal, confidence, reasons) {
  const arrow = signal === 'BUY' ? '🟢' : '🔴';
  const dir = signal === 'BUY' ? '▲ BUY / CALL' : '▼ SELL / PUT';
  const pairFormatted = pair.replace('/', '');
  const now = new Date();
  const timeStr = now.toUTCString().slice(17, 22) + ' UTC';

  return `${arrow} <b>RK DXB SIGNAL</b>

💱 <b>${pairFormatted}</b>
📊 Direction: <b>${dir}</b>
💪 Confidence: <b>${confidence}%</b>
⏰ Time: ${timeStr}
⏱ Expiry: <b>1 minute</b>

📈 Reasons:
${reasons.slice(0, 4).map(r => `• ${r}`).join('\n')}

⚡ <i>Real market only — QX Broker</i>`;
}

function formatSessionAlert(msg) {
  return `📢 <b>RK DXB TRADER</b>

${msg}

🔗 Check signals: your-site.pages.dev`;
}

module.exports = { sendTelegram, formatSignalAlert, formatSessionAlert };
