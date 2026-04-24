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

function getQtyPrecision(symbol) {
  if (['BTCUSDT'].includes(symbol)) return 4
  if (['ETHUSDT', 'XAUUSDT', 'XAGUSD'].includes(symbol)) return 3
  if (['SOLUSDT', 'HYPEUSDT'].includes(symbol)) return 2
  if (['VIRTUALUSDT', 'XRPUSDT'].includes(symbol)) return 1
  return 3
}

function roundQty(qty, decimals = 3) {
  return parseFloat(Number(qty).toFixed(decimals))
}

function roundPrice(price, decimals = 2) {
  return parseFloat(Number(price).toFixed(decimals))
}

// In-memory store: symbol → Binance SL order ID
const slOrderIds = new Map()

async function cancelSL(symbol) {
  const orderId = slOrderIds.get(symbol)
  if (!orderId) return
  try {
    await binance('DELETE', '/fapi/v1/order', { symbol, orderId })
    log(`Cancelled SL order ${orderId} for ${symbol}`)
  } catch (e) {
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
    closePosition: true,
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
  const amt = parseFloat(pos?.positionAmt ?? 0)
  return isFinite(amt) ? amt : 0
}

// ─── ACTION HANDLERS ──────────────────────────────────────────────────────────

async function handleEntry({ symbol, side, quantity, sl_price }) {
  const binanceSide = side === 'long' ? 'BUY' : 'SELL'
  // const closeSide   = side === 'long' ? 'SELL' : 'BUY'  // not needed without SL
  const qty         = roundQty(quantity, getQtyPrecision(symbol))

  // 1. Open position at market
  const order = await binance('POST', '/fapi/v1/order', {
    symbol,
    side:     binanceSide,
    type:     'MARKET',
    quantity: qty,
  })
  log(`Entry ${binanceSide} ${qty} ${symbol} @ market → orderId ${order.orderId}`)

  // 2. SL disabled for testnet (STOP_MARKET not supported)
  // await placeSL(symbol, closeSide, sl_price)

  return order
}

async function handleCloseHalf({ symbol, side, quantity, sl_price }) {
  const closeSide = side === 'long' ? 'SELL' : 'BUY'
  const prec      = getQtyPrecision(symbol)

  // If Pine sends NaN/missing quantity, fetch live position and halve it
  let qty = parseFloat(quantity)
  if (!isFinite(qty) || qty <= 0) {
    const posAmt = await getPositionAmt(symbol)
    if (posAmt === 0) {
      log(`CloseHalf skipped — ${symbol} already flat`)
      return { skipped: true, reason: 'position already closed' }
    }
    qty = Math.abs(posAmt) / 2
    log(`CloseHalf: quantity from Pine was invalid, using live posAmt/2 = ${qty}`)
  }
  qty = roundQty(qty, prec)

  // 1. Cancel current SL (disabled for testnet)
  // await cancelSL(symbol)

  // 2. Close 50% at market
  const order = await binance('POST', '/fapi/v1/order', {
    symbol,
    side:       closeSide,
    type:       'MARKET',
    quantity:   qty,
    reduceOnly: true,
  })
  log(`CloseHalf ${closeSide} ${qty} ${symbol} @ market → orderId ${order.orderId}`)

  // 3. SL disabled for testnet
  // await placeSL(symbol, closeSide, sl_price)

  return order
}

async function handleTrailActivated({ symbol, side, sl_price }) {
  // SL disabled for testnet
  // const closeSide = side === 'long' ? 'SELL' : 'BUY'
  // const order = await placeSL(symbol, closeSide, sl_price)
  log(`Trail activated — SL disabled for testnet (would move to ${sl_price})`)
  return { skipped: true, reason: 'SL disabled for testnet' }
}

async function handleExit({ symbol, side, quantity }) {
  const closeSide = side === 'long' ? 'SELL' : 'BUY'
  const prec      = getQtyPrecision(symbol)

  // 1. Cancel open SL (disabled for testnet)
  // await cancelSL(symbol)

  // 2. Always fetch live position — Pine quantity may be NaN or stale
  const posAmt = await getPositionAmt(symbol)
  if (posAmt === 0) {
    log(`Exit skipped — ${symbol} already flat`)
    return { skipped: true, reason: 'position already closed' }
  }

  const qty = roundQty(Math.abs(posAmt), prec)

  // 3. Close whatever remains
  const order = await binance('POST', '/fapi/v1/order', {
    symbol,
    side:       closeSide,
    type:       'MARKET',
    quantity:   qty,
    reduceOnly: true,
  })
  log(`Exit ${closeSide} ${qty} ${symbol} @ market → orderId ${order.orderId}`)
  return order
}

// ─── SERVER ───────────────────────────────────────────────────────────────────

const app = express()
app.use(express.json())

app.get('/health', (_req, res) => res.json({ ok: true, ts: new Date().toISOString() }))

app.post('/webhook', async (req, res) => {
  // Optional: simple bearer-token auth (header OR json body)
  if (WEBHOOK_SECRET) {
    const headerToken = (req.headers.authorization || '').replace('Bearer ', '')
    const bodyToken   = req.body?.secret || ''
    if (headerToken !== WEBHOOK_SECRET && bodyToken !== WEBHOOK_SECRET) {
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

try {
  app.listen(PORT, () => log(`Webhook server listening on port ${PORT}`))
} catch (err) {
  console.error('[LISTEN ERROR]', err)
  process.exit(1)
}

process.on('unhandledRejection', (err) => {
  console.error('[UNHANDLED]', err)
})

process.on('uncaughtException', (err) => {
  console.error('[UNCAUGHT]', err)
})

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`)
}
