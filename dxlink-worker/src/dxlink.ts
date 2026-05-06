// dxFeed DXLink WebSocket client.
//
// Protocol summary (we only implement the parts we need):
//   1. Open WS → server sends nothing
//   2. Client → SETUP    (channel 0)
//   3. Server ← AUTH_STATE: UNAUTHORIZED
//   4. Client → AUTH    (channel 0, token)
//   5. Server ← AUTH_STATE: AUTHORIZED
//   6. Client → CHANNEL_REQUEST (channel 3, service: FEED)
//   7. Server ← CHANNEL_OPENED (channel 3)
//   8. Client → FEED_SETUP (declare event types + which fields per event)
//   9. Server ← FEED_CONFIG (echoes config back)
//  10. Client → FEED_SUBSCRIPTION (add: [{type, symbol}, ...])
//  11. Server ← FEED_DATA frames forever
//
// Keepalive: we send a KEEPALIVE on channel 0 every 30s; if we don't
// hear one back in 60s we tear the connection down and reconnect.
//
// Reconnect: exponential backoff capped at 60s. On reconnect we
// re-auth + re-subscribe to whatever the application last asked for.

import type { StreamerAuth } from './tastytrade.ts'

export type EventType = 'Quote' | 'Greeks' | 'Summary' | 'Trade' | 'Profile'

export interface SubSpec {
  type: EventType
  symbol: string
}

// Field projections we care about, indexed by event type. The order
// matters — dxFeed echoes back fields in this order in COMPACT format.
const FEED_FIELDS: Record<EventType, string[]> = {
  Quote:   ['eventType', 'eventSymbol', 'bidPrice', 'askPrice'],
  Greeks:  ['eventType', 'eventSymbol', 'volatility', 'delta', 'gamma', 'theta', 'vega', 'rho'],
  Summary: ['eventType', 'eventSymbol', 'openInterest', 'prevDayClosePrice', 'dayVolume'],
  Trade:   ['eventType', 'eventSymbol', 'time', 'price', 'size'],
  Profile: ['eventType', 'eventSymbol'],
}

export type EventHandler = (event: Record<string, unknown>) => void | Promise<void>

const FEED_CHANNEL = 3
const KEEPALIVE_INTERVAL_MS = 30_000
const KEEPALIVE_TIMEOUT_MS = 60_000
const RECONNECT_BACKOFF_BASE_MS = 1_000
const RECONNECT_BACKOFF_MAX_MS = 60_000

export class DxLinkClient {
  private ws: WebSocket | null = null
  private auth: StreamerAuth
  private getFreshAuth: () => Promise<StreamerAuth>
  private subscribed = new Set<string>()        // serialized "type|symbol"
  private feedReady = false
  private reconnectAttempt = 0
  private keepaliveTimer: number | null = null
  private lastKeepaliveAt = 0
  private closedByUser = false
  private onEvent: EventHandler

  constructor(opts: {
    auth: StreamerAuth
    refreshAuth: () => Promise<StreamerAuth>
    onEvent: EventHandler
  }) {
    this.auth = opts.auth
    this.getFreshAuth = opts.refreshAuth
    this.onEvent = opts.onEvent
  }

  async start() {
    this.closedByUser = false
    await this.connect()
  }

  stop() {
    this.closedByUser = true
    this.feedReady = false
    if (this.keepaliveTimer) clearInterval(this.keepaliveTimer)
    this.ws?.close()
    this.ws = null
  }

  // Application-level subscribe; safe to call before feedReady. We
  // accumulate into `subscribed` and flush whenever the feed is up.
  async subscribe(specs: SubSpec[]) {
    for (const s of specs) this.subscribed.add(`${s.type}|${s.symbol}`)
    if (this.feedReady && this.ws?.readyState === WebSocket.OPEN) {
      this.sendFrame({
        type: 'FEED_SUBSCRIPTION',
        channel: FEED_CHANNEL,
        reset: false,
        add: specs,
      })
    }
  }

  private async connect() {
    if (Date.now() > this.auth.expiresAt - 60_000) {
      try {
        this.auth = await this.getFreshAuth()
      } catch (e) {
        console.error('[dxlink] refresh auth failed before connect:', e)
        this.scheduleReconnect()
        return
      }
    }
    console.log(`[dxlink] connecting to ${this.auth.url}`)
    const ws = new WebSocket(this.auth.url)
    this.ws = ws
    this.feedReady = false
    this.lastKeepaliveAt = Date.now()

    ws.addEventListener('open', () => this.onOpen())
    ws.addEventListener('message', (ev) => this.onMessage(ev))
    ws.addEventListener('close', (ev) => this.onClose(ev))
    ws.addEventListener('error', (ev) => {
      // 'error' on Deno's WebSocket is informational; the close event
      // carries the actual disconnect cause. Just log here.
      console.warn('[dxlink] ws error', ev)
    })
  }

  private onOpen() {
    this.sendFrame({
      type: 'SETUP',
      channel: 0,
      version: '0.1-wiley-edge',
      keepaliveTimeout: 60,
      acceptKeepaliveTimeout: 60,
    })
  }

  private onMessage(ev: MessageEvent) {
    let frame: Record<string, unknown>
    try {
      frame = JSON.parse(typeof ev.data === 'string' ? ev.data : '')
    } catch {
      return
    }
    const t = frame['type'] as string

    switch (t) {
      case 'SETUP':
        // Server echoes our SETUP. Wait for AUTH_STATE next.
        return
      case 'AUTH_STATE': {
        const state = frame['state']
        if (state === 'UNAUTHORIZED') {
          this.sendFrame({ type: 'AUTH', channel: 0, token: this.auth.token })
        } else if (state === 'AUTHORIZED') {
          this.sendFrame({
            type: 'CHANNEL_REQUEST',
            channel: FEED_CHANNEL,
            service: 'FEED',
            parameters: { contract: 'AUTO' },
          })
        }
        return
      }
      case 'CHANNEL_OPENED':
        if (frame['channel'] === FEED_CHANNEL) {
          this.sendFrame({
            type: 'FEED_SETUP',
            channel: FEED_CHANNEL,
            // 0 = no aggregation, fastest delivery; 0.5 means 500ms throttle
            acceptAggregationPeriod: 1,
            acceptDataFormat: 'COMPACT',
            acceptEventFields: FEED_FIELDS,
          })
        }
        return
      case 'FEED_CONFIG':
        if (frame['channel'] === FEED_CHANNEL) {
          this.feedReady = true
          this.reconnectAttempt = 0
          this.startKeepalive()
          // Replay all subscriptions on (re)connect.
          if (this.subscribed.size > 0) {
            const specs: SubSpec[] = []
            for (const key of this.subscribed) {
              const [type, symbol] = key.split('|')
              specs.push({ type: type as EventType, symbol })
            }
            // Reset = true ensures the server clears any stale state
            // for this channel before installing the new list.
            this.sendFrame({
              type: 'FEED_SUBSCRIPTION',
              channel: FEED_CHANNEL,
              reset: true,
              add: specs,
            })
            console.log(`[dxlink] resubscribed to ${specs.length} symbols`)
          }
        }
        return
      case 'FEED_DATA':
        this.handleFeedData(frame)
        return
      case 'KEEPALIVE':
        this.lastKeepaliveAt = Date.now()
        return
      case 'ERROR':
        console.error('[dxlink] server ERROR frame', frame)
        // AUTH errors usually mean expired token — refresh + reconnect.
        if (frame['error'] === 'UNAUTHORIZED') this.ws?.close()
        return
    }
  }

  // FEED_DATA frame shape:
  //   { type: 'FEED_DATA', channel, data: [eventType, [field1, field2, ...]] }
  // …where the inner arrays alternate between an event type label and
  // a flat array of field values for one or more events. We emit one
  // event object per record.
  private handleFeedData(frame: Record<string, unknown>) {
    const data = frame['data']
    if (!Array.isArray(data)) return
    // data is [type, [v1, v2, ..., vN]] — the inner array contains
    // multiple records concatenated, one record's worth of fields per
    // FEED_FIELDS[type].length values.
    for (let i = 0; i < data.length; i += 2) {
      const eventType = data[i] as EventType
      const values = data[i + 1] as unknown[]
      const fields = FEED_FIELDS[eventType]
      if (!fields || !Array.isArray(values)) continue
      const stride = fields.length
      for (let off = 0; off < values.length; off += stride) {
        const event: Record<string, unknown> = {}
        for (let f = 0; f < stride; f++) {
          event[fields[f]] = values[off + f]
        }
        this.onEvent(event)?.catch?.((e: unknown) =>
          console.warn('[dxlink] handler error', e),
        )
      }
    }
  }

  private startKeepalive() {
    if (this.keepaliveTimer) clearInterval(this.keepaliveTimer)
    this.keepaliveTimer = setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return
      this.sendFrame({ type: 'KEEPALIVE', channel: 0 })
      const silentMs = Date.now() - this.lastKeepaliveAt
      if (silentMs > KEEPALIVE_TIMEOUT_MS) {
        console.warn(`[dxlink] no server keepalive in ${silentMs}ms — reconnecting`)
        this.ws.close()
      }
    }, KEEPALIVE_INTERVAL_MS) as unknown as number
  }

  private onClose(ev: CloseEvent) {
    if (this.keepaliveTimer) clearInterval(this.keepaliveTimer)
    this.feedReady = false
    if (this.closedByUser) return
    console.warn(`[dxlink] closed code=${ev.code} reason=${ev.reason}`)
    this.scheduleReconnect()
  }

  private scheduleReconnect() {
    this.reconnectAttempt++
    const backoff = Math.min(
      RECONNECT_BACKOFF_BASE_MS * 2 ** this.reconnectAttempt,
      RECONNECT_BACKOFF_MAX_MS,
    )
    console.log(`[dxlink] reconnect in ${backoff}ms (attempt ${this.reconnectAttempt})`)
    setTimeout(() => this.connect(), backoff)
  }

  private sendFrame(frame: Record<string, unknown>) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return
    this.ws.send(JSON.stringify(frame))
  }
}
