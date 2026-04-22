# TradingView → Binance Futures Webhook

Receives TradingView strategy alerts and executes orders on Binance USDT-M Futures.

## How it works

```
TradingView alert fires
  → POST /webhook  (JSON payload from Pine Script make_msg())
    → parse action
    → call Binance fapi.binance.com
    → return result
```

### Supported actions

| Action | What it does |
|---|---|
| `entry` | Market order (BUY/SELL) + place STOP_MARKET SL |
| `close_half` | Market close 50% + move SL to breakeven |
| `trail_activated` | Cancel old SL, place new STOP_MARKET at trail level |
| `exit` | Cancel SL, close remaining position at market |

### Expected payload (sent by the Pine Script strategy)

```json
{
  "symbol":   "BINANCE:BTCUSDT.P",
  "action":   "entry",
  "side":     "long",
  "quantity": 0.003421,
  "price":    77872.5,
  "sl_price": 76500.00
}
```

The server strips `BINANCE:` and `.P` automatically — Binance receives `BTCUSDT`.

---

## Local setup

```bash
cd webhook
cp .env.example .env        # fill in your keys
npm install
npm start
```

Test it with curl:
```bash
curl -X POST http://localhost:3000/webhook \
  -H "Content-Type: application/json" \
  -d '{"symbol":"BTCUSDT","action":"entry","side":"long","quantity":0.001,"price":80000,"sl_price":79000}'
```

Health check:
```bash
curl http://localhost:3000/health
```

---

## Deploy to Railway.app

### 1. Push the `webhook/` folder as its own repo (or use a monorepo)

Railway needs a `package.json` at the root of whatever folder it deploys.
The easiest path: create a separate GitHub repo containing only the `webhook/` contents.

```bash
cd webhook
git init
git add .
git commit -m "Initial webhook server"
gh repo create tradingview-webhook --public --push
```

### 2. Create a new Railway project

1. Go to [railway.app](https://railway.app) → **New Project → Deploy from GitHub**
2. Select your `tradingview-webhook` repo
3. Railway auto-detects Node.js and runs `npm start`

### 3. Set environment variables in Railway

In your Railway project → **Variables** tab, add:

| Variable | Value |
|---|---|
| `BINANCE_API_KEY` | Your Binance Futures API key |
| `BINANCE_SECRET` | Your Binance Futures secret |
| `WEBHOOK_SECRET` | A random string (e.g. `openssl rand -hex 16`) |

Railway injects `PORT` automatically — do not set it yourself.

### 4. Get your public URL

Railway → **Settings → Domains** → Generate domain.
You'll get something like `https://tradingview-webhook-production.up.railway.app`.

### 5. Create TradingView alerts

In TradingView, for each alert on the **EMA/VWAP Multi-Model** strategy:

- **Condition**: Any alert() function call
- **Webhook URL**: `https://your-app.up.railway.app/webhook`
- **Message**: (leave empty — the strategy sends the JSON payload via `alert_message`)

If you set `WEBHOOK_SECRET`, add a header in the TradingView alert:
```
Authorization: Bearer your_secret_here
```
(TradingView → Alert → Notifications → Webhook → Additional headers)

---

## Binance API key permissions

Your Binance Futures API key needs:
- ✅ Enable Futures
- ✅ Enable Trading
- ❌ Disable Withdrawals (not needed, keeps it safe)
- ✅ Restrict to your Railway IP (recommended)

Get your Railway outbound IP from: **Railway project → Settings → Networking**.

---

## Important notes

### Lot size precision
Binance has per-symbol lot size rules (min qty, step size). The server defaults to
**3 decimal places** for quantity and **2 for price**, which works for BTCUSDT.
For other symbols adjust `roundQty()` and `roundPrice()` in `server.js`, or fetch
`/fapi/v1/exchangeInfo` at startup to read exact filters.

### One-way mode required
This server assumes Binance account is set to **one-way position mode** (the default).
Hedge mode (separate LONG/SHORT positions) is not supported.

### SL order state is in-memory
The server tracks open SL order IDs in a `Map`. If the process restarts, the map
is lost and the next `close_half` / `trail_activated` / `exit` won't know the old
SL order ID to cancel. The order stays open on Binance until it fills or you cancel
it manually. For production, store SL order IDs in Redis or a small database.

### Pine Script SL vs Binance SL
Both Pine Script's backtester and Binance's STOP_MARKET order will try to close the
position. The `exit` handler calls `getPositionAmt()` first and skips the market
close if Binance already closed it via its own stop — preventing double-close errors.
