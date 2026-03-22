# RK DXB Trader

Real market forex signal website for QX Broker — 1-minute binary options.

## Stack
- **Frontend**: Cloudflare Pages (`/client` folder)
- **Backend**: Render.com free tier (`/server` folder)
- **Data**: Twelve Data API — 6 keys rotating
- **Alerts**: Telegram bot

## Pairs
EUR/USD, GBP/USD, USD/JPY, AUD/USD, USD/CAD, EUR/GBP, GBP/JPY, EUR/JPY

## Indicators
RSI(14), EMA 8/21/55/200, Bollinger Bands(20,2), MACD(12,26,9), Stochastic(14,3),
Williams %R(14), CCI(20), Candle Patterns, Multi-Candle Logic, Volume

---

## Step 1 — Deploy Backend (Render)

1. Go to https://render.com → New → Web Service
2. Connect this GitHub repo
3. Root directory: `server`
4. Build command: `npm install`
5. Start command: `node server.js`
6. Add env vars:
   - `TELEGRAM_TOKEN` = your bot token
   - `TELEGRAM_CHAT_ID` = your chat ID
7. Deploy
8. Copy your Render URL (e.g. `https://rk-dxb-trader-server.onrender.com`)

## Step 2 — Update WebSocket URL

In `client/dashboard.html`, find this line:
```
'wss://rk-dxb-trader-server.onrender.com'
```
Replace with your actual Render URL.

## Step 3 — Deploy Frontend (Cloudflare Pages)

1. Go to https://pages.cloudflare.com → Create project
2. Connect this GitHub repo
3. Build directory: `client`
4. No build command needed (static HTML)
5. Deploy

## Step 4 — Keep Render Alive (UptimeRobot)

1. Go to https://uptimerobot.com → Free account
2. Add monitor: HTTP(s) → your Render URL
3. Interval: every 5 minutes
4. Done — server stays awake 24/7

---

## Login
Email: rafhidk.rk@gmail.com (hardcoded in index.html)
No password needed.
