'use strict'

const express = require('express')
const crypto  = require('crypto')
const axios   = require('axios')

// ─── CONFIG ──────────────────────────────────────────────────────────────────
const PORT           = process.env.PORT           || 3000
const API_KEY        = process.env.BINANCE_API_KEY || ''
const SECRET         = process.env.BINANCE_SECRET  || ''
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET  || '' // optional bearer token
const BASE_URL       = process.env.BINANCE_BASE_URL || 'https://testnet.binancefuture.com'

if (!API_KEY || !SECRET) {
  console.error('BINANCE_API_KEY and BINANCE_SECRET must be set')
  process.exit(1)
}

// ─── BINANCE CLIENT ───────────────────────────────────────────────────────────

function sign(params) {
  const qs = new URLSearchParams(params).toString()
  return crypto.createHmac('sha256', SECRET).update(qs).digest('hex')
}

async function binance(method, path, params = {}) {
  const timestamp  = Date.now()
  const signed     = { ...params, timestamp }
  const signature  = sign(signed)
  const url        = `${BASE_URL}${path}`
  const headers    = { 'X-MBX-APIKEY': API_KEY }

  try {
    if (method === 'GET' || method === 'DELETE') {
      const res = await axios({ method, url, headers, params: { ...signed, signature } })
      return res.data
    } else {
      const body = new URLSearchParams({ ...signed, signature }).toString()
      const res  = await axios.post(url, body, { headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded' } })
      return res.data
    }
  } catch (err) {
    const binanceErr = err.response?.data
    throw binanceErr ?? err
  }
}

// ─── SYMBOL NORMALISATION ─────────────────────────────────────────────────────
// TradingView sends "BINANCE:BTCUSDT.P" — strip exchange prefix and .P suffix.
function normaliseSymbol(raw) {
  return raw.replace(/^[^:]+:/, '').replace(/\.P$/, '').toUpperCase()
}

// ─── ORDER HELPERS ────────────────────────────────────────────────────────────

// Round quantity to Binance lot-size precision.
// BTC=3dp, ETH=3dp, XRP=1dp — fetch /fapi/v1/exchangeInfo for exact rules.
// Default to 3dp which is safe for most major coins.
function roundQty(qty, decimals = 3) {
  return parseFloat(Number(qty).toFixed(decimals))
}

function roundPrice(price, decimals = 2) {
  return parseFloat(Number(price).toFixed(decimals))
}

// In-memory store: symbol → Binance SL order ID
// For multi-process/restart resilience, replace with Redis.
const slOrderIds = new Map()

async function cancelSL(symbol) {
  const orderId = slOrderIds.get(symbol)
  if (!orderId) return
  try {
    await binance('DELETE', '/fapi/v1/order', { symbol, orderId })
    log(`Cancelled SL order ${orderId} for ${symbol}`)
  } catch (e) {
    // Already filled or cancelled — safe to ignore
    log(`SL cancel skipped (already gone): ${JSON.stringify(e)}`)
  } finally {
    slOrderIds.delete(symbol)
  }
}

async function placeSL(symbol, closeSide, stopPrice) {
  await cancelSL(symbol)
  const order = await binance('POST', '/fapi/v1/order', {
    symbol,
    side:          closeSide,
    type:          'STOP_MARKET',
    stopPrice:     roundPrice(stopPrice),
    closePosition: true,   // closes 100% of remaining position when triggered
    workingType:   'MARK_PRICE',
    timeInForce:   'GTC',
  })
  slOrderIds.set(symbol, order.orderId)
  log(`Placed SL ${closeSide} STOP_MARKET @ ${stopPrice} → orderId ${order.orderId}`)
  return order
}

async function getPositionAmt(symbol) {
  const positions = await binance('GET', '/fapi/v2/positionRisk', { symbol })
  const pos = Array.isArray(positions) ? positions[0] : positions
  return parseFloat(pos?.positionAmt ?? 0)
}

// ─── ACTION HANDLERS ──────────────────────────────────────────────────────────

async function handleEntry({ symbol, side, quantity, sl_price }) {
  const binanceSide = side === 'long' ? 'BUY' : 'SELL'
  const closeSide   = side === 'long' ? 'SELL' : 'BUY'
  const qty         = roundQty(quantity)

  // 1. Open position at market
  const order = await binance('POST', '/fapi/v1/order', {
    symbol,
    side:     binanceSide,
    type:     'MARKET',
    quantity: qty,
  })
  log(`Entry ${binanceSide} ${qty} ${symbol} @ market → orderId ${order.orderId}`)

  // 2. Place stop-loss
  await placeSL(symbol, closeSide, sl_price)

  return order
}

async function handleCloseHalf({ symbol, side, quantity, sl_price }) {
  const closeSide = side === 'long' ? 'SELL' : 'BUY'
  const qty       = roundQty(quantity)

  // 1. Cancel current SL (will be replaced at breakeven)
  await cancelSL(symbol)

  // 2. Close 50% at market
  const order = await binance('POST', '/fapi/v1/order', {
    symbol,
    side:       closeSide,
    type:       'MARKET',
    quantity:   qty,
    reduceOnly: true,
  })
  log(`CloseHalf ${closeSide} ${qty} ${symbol} @ market → orderId ${order.orderId}`)

  // 3. Place new BE stop on remaining half
  //    sl_price = ep (entry price) sent by Pine Script after 2R close
  await placeSL(symbol, closeSide, sl_price)

  return order
}

async function handleTrailActivated({ symbol, side, sl_price }) {
  // Pine fires this once when the 3R trail activates.
  // Update SL stop to the current trail level.
  const closeSide = side === 'long' ? 'SELL' : 'BUY'
  const order = await placeSL(symbol, closeSide, sl_price)
  log(`Trail activated — SL moved to ${sl_price}`)
  return order
}

async function handleExit({ symbol, side }) {
  const closeSide = side === 'long' ? 'SELL' : 'BUY'

  // 1. Cancel open SL order (Pine's backtester fired the exit — we handle it here)
  await cancelSL(symbol)

  // 2. Check whether Binance already closed the position (e.g., its own SL filled first)
  const posAmt = await getPositionAmt(symbol)
  if (posAmt === 0) {
    log(`Exit skipped — ${symbol} already flat`)
    return { skipped: true, reason: 'position already closed' }
  }

  // 3. Close whatever remains
  const order = await binance('POST', '/fapi/v1/order', {
    symbol,
    side:       closeSide,
    type:       'MARKET',
    quantity:   roundQty(Math.abs(posAmt)),
    reduceOnly: true,
  })
  log(`Exit ${closeSide} ${Math.abs(posAmt)} ${symbol} @ market → orderId ${order.orderId}`)
  return order
}

// ─── SERVER ───────────────────────────────────────────────────────────────────

const app = express()
app.use(express.json())

app.get('/health', (_req, res) => res.json({ ok: true, ts: new Date().toISOString() }))

app.post('/webhook', async (req, res) => {
  // Optional: simple bearer-token auth
  if (WEBHOOK_SECRET) {
    const token = (req.headers.authorization || '').replace('Bearer ', '')
    if (token !== WEBHOOK_SECRET) {
      return res.status(401).json({ error: 'Unauthorised' })
    }
  }

  const raw = req.body
  log(`Received → ${JSON.stringify(raw)}`)

  const { action, symbol: rawSymbol, side, quantity, price, sl_price } = raw

  if (!action || !rawSymbol) {
    return res.status(400).json({ error: 'Missing action or symbol' })
  }

  const symbol  = normaliseSymbol(rawSymbol)
  const payload = { symbol, side, quantity, price, sl_price }

  try {
    let result
    switch (action) {
      case 'entry':
        result = await handleEntry(payload)
        break
      case 'close_half':
        result = await handleCloseHalf(payload)
        break
      case 'trail_activated':
        result = await handleTrailActivated(payload)
        break
      case 'exit':
        result = await handleExit(payload)
        break
      default:
        return res.status(400).json({ error: `Unknown action: ${action}` })
    }

    log(`OK ${action} ${symbol}`)
    return res.json({ ok: true, action, symbol, result })

  } catch (err) {
    console.error(`[ERROR] ${action} ${symbol}:`, JSON.stringify(err))
    return res.status(500).json({ error: err })
  }
})

app.listen(PORT, () => log(`Webhook server listening on port ${PORT}`))

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`)
}
