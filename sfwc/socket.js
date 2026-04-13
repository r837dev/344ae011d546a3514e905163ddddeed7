// ===============================================================
// socket.js — Unity Design System · WebSocket Module
// null.js · v2.1 · April 2026
//
// Thin, zero-dep WebSocket wrapper built on native APIs.
// Same philosophy as app.js and router.js:
//   native API + EventTarget + clean lifecycle.
//
// v2: Codec strategy pattern for pluggable wire formats.
//     Ships with jsonCodec (OSS). Custom codecs (e.g. Meteor)
//     drop in via the format option.
//
// Features:
//   · Pluggable wire format via codec strategy
//   · Dual-emit routing (context-qualified + namespace-only)
//   · Sub-protocol negotiation (Sec-WebSocket-Protocol)
//   · Auto-reconnect with exponential backoff
//   · Heartbeat (ping interval + pong timeout)
//   · Message queue (buffer sends while disconnected)
//   · EventTarget bus for typed messages
//   · Connection state events
//   · Filter/middleware pipeline
//   · Standalone — no dependency on app.js
//
// -------------------------------------------------------------
//
// Codec Interface:
//
//   A codec is a plain object with three properties:
//
//   {
//     protocol: 'json',            // Sec-WebSocket-Protocol name
//     decode(raw) {},              // string → { type, data, context? }
//     encode(type, data) {},       // (string, any) → string
//   }
//
//   decode returns:
//     type    — namespace / event name (used as bus event)
//     data    — payload for e.detail.data
//     context — (optional) if present, triggers dual-emit:
//               1. 'context:type' — context-qualified event
//               2. 'type'         — namespace-only event
//               Both carry identical detail including context.
//
//   encode:
//     type + data → wire string for sending
//
//   protocol:
//     declared as Sec-WebSocket-Protocol during handshake
//
// -------------------------------------------------------------
//
// Dual-Emit Routing (Meteor / context-aware codecs):
//
//   When a codec returns { context: 'host_7', type: 'metrics', data }
//   the bus fires TWO events:
//
//   'host_7:metrics'  ← precise: only this host's metrics
//   'metrics'         ← broad: all metrics regardless of context
//
//   Both events carry the same detail:
//   { data, context: 'host_7', raw: MessageEvent }
//
//   JSON codec returns no context → single emit on type only.
//   This means existing JSON consumers are unaffected.
//
//   // Precise subscriber (specific context)
//   socket.bus.addEventListener('host_7:metrics', e => {
//     // only host_7 metrics
//   })
//
//   // Broad subscriber (all contexts)
//   socket.bus.addEventListener('metrics', e => {
//     console.log(e.detail.context)  // 'host_7', 'host_8', etc.
//   })
//
// -------------------------------------------------------------
//
// Usage:
//
//   import { socket, jsonCodec } from './socket.js'
//
//   // Default — jsonCodec is used automatically
//   socket.open('wss://api.example.com/ws')
//
//   // Explicit codec
//   socket.open('wss://api.example.com/ws', { format: jsonCodec })
//
//   // Custom codec (e.g. Meteor — commercial add-on)
//   import { meteorCodec } from './meteor-codec.js'
//   socket.open('wss://api.example.com/ws', { format: meteorCodec })
//
//   // Raw mode — no codec, no parsing
//   socket.open('wss://api.example.com/ws', { format: null })
//
//   // Listen to typed messages
//   socket.bus.addEventListener('metrics', e => {
//     console.log(e.detail.data)
//     console.log(e.detail.context)  // present if codec provides it
//   })
//
//   // Send (auto-queued if disconnected)
//   socket.send('metrics', { cpu: 42 })
//
//   // Send raw (bypasses codec entirely)
//   socket.sendRaw('ping')
//
//   // Close
//   socket.close()
//
// -------------------------------------------------------------
//
// Wire to app.bus:
//
//   // Forward everything — context flows through naturally
//   socket.onMessage = (type, data, context) =>
//     app.update(context ? `${context}:${type}` : type, data)
//
// -------------------------------------------------------------
//
// Filters (middleware):
//
//   socket.use('in', (type, data) => {
//     if (type === 'metrics') data.receivedAt = Date.now()
//     return { type, data }
//   })
//
//   socket.use('out', (type, data) => {
//     data._token = getToken()
//     return { type, data }
//   })
//
//   const id = socket.use('in', myFilter)
//   socket.remove(id)
//   socket.clearFilters()
//
// -------------------------------------------------------------
//
// Options:
//
//   socket.open(url, {
//     format:         jsonCodec,    // codec object, or null for raw
//     protocols:      [],           // additional WebSocket sub-protocols
//     reconnect:      true,         // auto-reconnect on close
//     maxRetries:     Infinity,     // max reconnect attempts
//     backoff:        1000,         // initial backoff ms
//     backoffMax:     30000,        // max backoff ms
//     backoffFactor:  2,            // exponential multiplier
//     heartbeat:      0,            // ping interval ms (0 = disabled)
//     heartbeatMsg:   'ping',       // heartbeat message to send
//     heartbeatAck:   'pong',       // expected heartbeat response
//     heartbeatTimeout: 5000,       // ms to wait for pong
//     queue:          true,         // queue sends while disconnected
//     maxQueue:       100,          // max queued messages
//   })
//
// -------------------------------------------------------------
//
// Back-compat (v1 → v2):
//
//   socket.open(url)                        // v2 default (jsonCodec)
//   socket.open(url, { json: true })        // v1 style — still works
//   socket.open(url, { format: jsonCodec }) // v2 explicit
//   socket.open(url, { json: false })       // v1 raw
//   socket.open(url, { format: null })      // v2 raw
//
// ===============================================================


// ===================================
// JSON CODEC (ships with socket.js)
// ===================================

/**
 * JSON wire format codec.
 *
 * Expects: { "type": "eventName", "data": { ... } }
 * Falls back gracefully if type or data is missing.
 *
 * No context returned — single-emit only. This is the OSS default.
 */
const jsonCodec = {
  protocol: 'json',

  decode(raw) {
    const parsed = JSON.parse(raw)
    return {
      type: parsed.type || 'message',
      data: parsed.data !== undefined ? parsed.data : parsed,
    }
  },

  encode(type, data) {
    return JSON.stringify({ type, data })
  },
}


// ===================================
// DEFAULTS
// ===================================

const DEFAULTS = {
  format:           jsonCodec,
  protocols:        [],
  reconnect:        true,
  maxRetries:       Infinity,
  backoff:          1000,
  backoffMax:       30000,
  backoffFactor:    2,
  heartbeat:        0,
  heartbeatMsg:     'ping',
  heartbeatAck:     'pong',
  heartbeatTimeout: 5000,
  queue:            true,
  maxQueue:         100,
}


// ===================================
// SOCKET CLASS
// ===================================

class Socket {

  /** EventTarget — subscribe to typed messages + lifecycle events */
  bus = new EventTarget()

  /**
   * Optional hook: called for every incoming message AFTER filters.
   * Receives namespace-level type + context separately.
   *
   * @type {((type: string, data: any, context: string|undefined, raw: MessageEvent) => void) | null}
   */
  onMessage = null

  // -- Private state --
  #ws = null
  #url = null
  #opts = { ...DEFAULTS }
  #codec = jsonCodec
  #state = 'closed'       // closed | connecting | open | reconnecting
  #retryCount = 0
  #retryTimer = null
  #heartbeatTimer = null
  #heartbeatTimeout = null
  #queue = []
  #closedByUser = false
  #filters = { in: [], out: [] }
  #filterId = 0


  // ===================================
  // PUBLIC API
  // ===================================

  open(url, opts = {}) {
    if (this.#ws) this.close()

    this.#opts = { ...DEFAULTS, ...opts }

    if ('json' in opts && !('format' in opts)) {
      this.#codec = opts.json ? jsonCodec : null
    } else {
      this.#codec = this.#opts.format
    }

    this.#url = url
    this.#closedByUser = false
    this.#retryCount = 0
    this.#connect()
  }

  send(type, data) {
    const filtered = this.#runFilters('out', type, data)
    if (filtered === null) return

    const msg = this.#codec
      ? this.#codec.encode(filtered.type, filtered.data)
      : filtered.data

    this.#enqueue(msg)
  }

  sendRaw(data) {
    this.#enqueue(data)
  }

  close(code = 1000, reason = '') {
    this.#closedByUser = true
    this.#stopReconnect()
    this.#stopHeartbeat()

    if (this.#ws) {
      this.#ws.close(code, reason)
      this.#ws = null
    }

    this.#setState('closed')
  }

  get state() { return this.#state }
  get connected() { return this.#state === 'open' && this.#ws?.readyState === WebSocket.OPEN }
  get protocol() { return this.#ws?.protocol ?? '' }
  get codec() { return this.#codec }
  get queueSize() { return this.#queue.length }
  get retryCount() { return this.#retryCount }
  clearQueue() { this.#queue.length = 0 }


  // ===================================
  // FILTERS (MIDDLEWARE)
  // ===================================

  use(direction, fn) {
    const id = ++this.#filterId
    this.#filters[direction]?.push({ id, fn })
    return id
  }

  remove(id) {
    this.#filters.in = this.#filters.in.filter(f => f.id !== id)
    this.#filters.out = this.#filters.out.filter(f => f.id !== id)
  }

  clearFilters() {
    this.#filters.in.length = 0
    this.#filters.out.length = 0
  }

  #runFilters(direction, type, data) {
    const pipeline = this.#filters[direction]
    let current = { type, data }

    for (const { fn } of pipeline) {
      const result = fn(current.type, current.data)
      if (result === null) return null
      if (result !== undefined) current = result
    }

    return current
  }


  // ===================================
  // CONNECTION MANAGEMENT
  // ===================================

  #connect() {
    this.#setState('connecting')

    try {
      const protocols = [
        ...(this.#codec?.protocol ? [this.#codec.protocol] : []),
        ...this.#opts.protocols,
      ]

      this.#ws = protocols.length
        ? new WebSocket(this.#url, protocols)
        : new WebSocket(this.#url)
    } catch (err) {
      this.#emit('socket:error', { error: err })
      this.#scheduleReconnect()
      return
    }

    this.#ws.addEventListener('open', this.#onOpen)
    this.#ws.addEventListener('close', this.#onClose)
    this.#ws.addEventListener('error', this.#onError)
    this.#ws.addEventListener('message', this.#onMessage)
  }


  // ===================================
  // WEBSOCKET EVENT HANDLERS
  // ===================================

  #onOpen = () => {
    this.#setState('open')
    this.#retryCount = 0

    const negotiated = this.#ws?.protocol ?? ''
    this.#emit('socket:open', { url: this.#url, protocol: negotiated })
    this.#emit('socket:protocol', { protocol: negotiated })

    this.#flushQueue()
    this.#startHeartbeat()
  }

  #onClose = (e) => {
    this.#stopHeartbeat()
    this.#emit('socket:close', {
      code: e.code,
      reason: e.reason,
      wasClean: e.wasClean,
    })

    if (!this.#closedByUser) {
      this.#scheduleReconnect()
    } else {
      this.#setState('closed')
    }
  }

  #onError = (e) => {
    this.#emit('socket:error', { event: e })
  }

  /**
   * Inbound message handler.
   *
   * Codec decode → filter pipeline → dual-emit → onMessage hook.
   *
   * Dual-emit: when decoded.context is present (e.g. Meteor codec),
   * fires BOTH 'context:type' and 'type' on the bus. When absent
   * (e.g. JSON codec), fires 'type' only. This means JSON consumers
   * are completely unaffected by the dual-emit path.
   */
  #onMessage = (e) => {
    // Heartbeat ack check (raw string, bypasses codec)
    if (this.#opts.heartbeat && e.data === this.#opts.heartbeatAck) {
      this.#clearHeartbeatTimeout()
      return
    }

    let type, data, context

    if (this.#codec) {
      try {
        const decoded = this.#codec.decode(e.data)
        type = decoded.type
        data = decoded.data
        context = decoded.context  // undefined for JSON, string for Meteor
      } catch {
        type = 'message'
        data = e.data
      }
    } else {
      type = 'message'
      data = e.data
    }

    // Run inbound filters
    const filtered = this.#runFilters('in', type, data)
    if (filtered === null) return
    type = filtered.type
    data = filtered.data

    // Build detail — always include context if codec provided it
    const detail = { data, raw: e }
    if (context !== undefined) detail.context = context

    // -- Dual-emit --
    // Context present: fire 'ctx:ns' (precise) then 'ns' (broad)
    // Context absent:  fire 'type' only (JSON / raw path)
    if (context) {
      this.#emit(`${context}:${type}`, detail)
    }
    this.#emit(type, detail)

    // onMessage hook — namespace type + context as separate arg
    if (typeof this.onMessage === 'function') {
      this.onMessage(type, data, context, e)
    }
  }


  // ===================================
  // RECONNECTION
  // ===================================

  #scheduleReconnect() {
    if (!this.#opts.reconnect) {
      this.#setState('closed')
      return
    }

    if (this.#opts.maxRetries !== Infinity && this.#retryCount >= this.#opts.maxRetries) {
      this.#emit('socket:exhausted', { attempts: this.#retryCount })
      this.#setState('closed')
      return
    }

    this.#setState('reconnecting')
    this.#retryCount++

    const base = Math.min(
      this.#opts.backoff * Math.pow(this.#opts.backoffFactor, this.#retryCount - 1),
      this.#opts.backoffMax
    )
    const jitter = base * (0.5 + Math.random() * 0.5)
    const delay = Math.round(jitter)

    this.#emit('socket:reconnect', { attempt: this.#retryCount, delay })

    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = null
      this.#connect()
    }, delay)
  }

  #stopReconnect() {
    if (this.#retryTimer) {
      clearTimeout(this.#retryTimer)
      this.#retryTimer = null
    }
  }


  // ===================================
  // HEARTBEAT
  // ===================================

  #startHeartbeat() {
    if (!this.#opts.heartbeat) return
    this.#stopHeartbeat()

    this.#heartbeatTimer = setInterval(() => {
      if (this.#ws?.readyState === WebSocket.OPEN) {
        this.#ws.send(this.#opts.heartbeatMsg)
        this.#heartbeatTimeout = setTimeout(() => {
          this.#emit('socket:timeout', { message: 'Heartbeat timeout' })
          this.#ws?.close(4000, 'heartbeat timeout')
        }, this.#opts.heartbeatTimeout)
      }
    }, this.#opts.heartbeat)
  }

  #stopHeartbeat() {
    if (this.#heartbeatTimer) {
      clearInterval(this.#heartbeatTimer)
      this.#heartbeatTimer = null
    }
    this.#clearHeartbeatTimeout()
  }

  #clearHeartbeatTimeout() {
    if (this.#heartbeatTimeout) {
      clearTimeout(this.#heartbeatTimeout)
      this.#heartbeatTimeout = null
    }
  }


  // ===================================
  // QUEUE
  // ===================================

  #enqueue(msg) {
    if (this.#state === 'open' && this.#ws?.readyState === WebSocket.OPEN) {
      this.#ws.send(msg)
    } else if (this.#opts.queue) {
      if (this.#queue.length < this.#opts.maxQueue) {
        this.#queue.push(msg)
      }
    }
  }

  #flushQueue() {
    while (this.#queue.length > 0 && this.#ws?.readyState === WebSocket.OPEN) {
      this.#ws.send(this.#queue.shift())
    }
  }


  // ===================================
  // HELPERS
  // ===================================

  #setState(state) {
    this.#state = state
  }

  #emit(type, detail = {}) {
    this.bus.dispatchEvent(new CustomEvent(type, { detail }))
  }
}


// -- Singleton export --
const socket = new Socket()

export { socket, Socket, jsonCodec }
