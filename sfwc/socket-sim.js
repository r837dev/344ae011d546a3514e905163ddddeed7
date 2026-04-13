// ===============================================================
// socket-sim.js — Unity Design System · Socket Simulator v2
// null.js · v2.1 · April 2026
//
// Development tool: mock WebSocket server with node ws-style API.
// Replaces the global WebSocket with a mock that simulates
// real server behavior including handshake negotiation,
// per-client state, and codec-aware message encoding.
//
// Pairs with socket.js v2 but has no hard dependency on it.
// Works with any WebSocket consumer.
//
// -------------------------------------------------------------
//
// Quick start (zero-config, same as v1):
//
//   import { sim } from './socket-sim.js'
//   sim.install()
//
//   import { socket } from './socket.js'
//   socket.open('wss://anything.example.com/ws')
//
//   sim.start()         // random traffic at default rate
//   sim.fire('metrics') // trigger specific generator
//   sim.stop()
//
// -------------------------------------------------------------
//
// Server-style API (node ws-style):
//
//   sim.onConnection((client, req) => {
//     client.on('message', (data) => { ... })
//     client.on('close', (code, reason) => { ... })
//     client.send('welcome', { version: '2.0' })
//   })
//
// -------------------------------------------------------------
//
// Handshake / Protocol Negotiation:
//
//   sim.onUpgrade((req, accept, reject) => {
//     if (req.protocols.includes('meteor')) accept('meteor')
//     else if (req.protocols.includes('json')) accept('json')
//     else reject(4001, 'unsupported protocol')
//   })
//
// -------------------------------------------------------------
//
// Codec-aware broadcasting:
//
//   sim.codecs.set('json', jsonCodec)
//   sim.codecs.set('meteor', meteorCodec)
//
//   // broadcast() encodes per-client based on negotiated protocol
//   sim.broadcast({ type: 'metrics', data: { cpu: 42 } })
//
//   // broadcastRaw() sends raw string to all
//   sim.broadcastRaw('raw frame')
//
// -------------------------------------------------------------
//
// Generators return domain objects with optional context:
//
//   sim.register('metrics', () => ({
//     context: 'host_node7',     // optional — used by meteor codec
//     type: 'metrics',           // namespace / bus event name
//     data: { cpu: 42 }          // payload
//   }))
//
// -------------------------------------------------------------
//
// Chaos tools:
//
//   sim.drop()          // drop all connections
//   sim.flood(20)       // 20 random messages instantly
//   sim.jitter = true   // random delay on all messages
//
// ===============================================================


// -- Helpers --
function rnd(arr) { return arr[Math.floor(Math.random() * arr.length)] }
function rndInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min }
function rndDelay(range) { return rndInt(range[0], range[1]) }


// -- Sample data pools --
const AGENTS = ['knife', 'scout', 'oxbow', 'prism', 'echo', 'drift', 'bloom', 'relay']
const STATUSES = ['running', 'idle', 'error', 'starting', 'stopping']
const LOG_LEVELS = ['info', 'warn', 'error', 'debug']
const HOSTS = ['host_alpha', 'host_beta', 'host_gamma']
const SESSIONS = ['sess-a1b2', 'sess-c3d4', 'sess-e5f6']
const LOG_MSGS = [
  'Processing batch 847/1200', 'Connection pool exhausted',
  'Retrying request (attempt 3)', 'Cache miss for key agent:config',
  'Memory pressure detected', 'GC pause 12ms',
  'Stream consumer lag: 142ms', 'Checkpoint saved',
  'Index rebuilt in 340ms', 'Heartbeat OK',
  'Batch committed: 1024 rows', 'TLS handshake complete',
  'Worker pool scaled to 8', 'Rate limiter: 42 req/s',
  'Snapshot written: 2.4MB',
]
const ALERT_MSGS = [
  'CPU threshold exceeded', 'Disk space low',
  'Error rate spike', 'Latency P99 > 500ms',
  'Memory leak detected', 'Connection pool saturated',
  'Queue depth critical', 'Certificate expiring in 7d',
]
const TOAST_MSGS = [
  'Agent deployed successfully', 'Build complete',
  'Connection restored', 'Rate limit approaching',
  'Task queue full', 'Sync complete',
  'Configuration saved', 'Export ready for download',
]


// -- Built-in generators --
// Generators return { context?, type, data }.
// context is optional — used by context-aware codecs (Meteor).
// For JSON codec, context is ignored during encoding.
const GENERATORS = {
  agents: () => ({
    context: 'app',
    type: 'agents',
    data: AGENTS.slice(0, rndInt(3, 6)).map(name => ({
      name,
      status: rnd(STATUSES),
      tasks: rndInt(0, 20),
      uptime: `${rndInt(1, 99)}h`,
    }))
  }),

  metrics: () => ({
    context: rnd(HOSTS),
    type: 'metrics',
    data: {
      cpu: rndInt(5, 95),
      mem: +(Math.random() * 8).toFixed(1),
      disk: rndInt(20, 90),
      net_ms: rndInt(12, 340),
      rps: rndInt(100, 5000),
    }
  }),

  'log:entry': () => ({
    context: rnd(HOSTS),
    type: 'log.entry',
    data: {
      level: rnd(LOG_LEVELS),
      agent: rnd(AGENTS),
      message: rnd(LOG_MSGS),
      ts: Date.now(),
    }
  }),

  alert: () => ({
    context: 'system',
    type: 'alerts',
    data: {
      severity: rnd(['info', 'warn', 'critical']),
      agent: rnd(AGENTS),
      message: rnd(ALERT_MSGS),
    }
  }),

  'agent:status': () => {
    const name = rnd(AGENTS)
    return {
      context: 'app',
      type: 'agent.status',
      data: {
        name,
        status: rnd(STATUSES),
        tasks: rndInt(0, 15),
        cpu: rndInt(1, 100),
        mem_mb: rndInt(50, 2000),
      }
    }
  },

  'toast:show': () => ({
    context: rnd(SESSIONS),
    type: 'ui.toast',
    data: {
      message: rnd(TOAST_MSGS),
      variant: rnd(['ok', 'warn', 'err', 'info']),
    }
  }),
}


// ===============================================================
// MockClient — server-side handle for a connection (node ws-style)
// ===============================================================

let _clientId = 0

class MockClient {
  id = ++_clientId
  protocol = ''
  url = ''
  readyState = 0  // CONNECTING

  _ws = null       // back-reference to MockWebSocket
  _handlers = {}   // event → [fn, ...]

  constructor(ws) {
    this._ws = ws
    this.url = ws.url
  }

  /** Register an event handler (node-style) */
  on(event, fn) {
    (this._handlers[event] ??= []).push(fn)
    return this
  }

  /** Remove an event handler */
  off(event, fn) {
    const arr = this._handlers[event]
    if (arr) this._handlers[event] = arr.filter(f => f !== fn)
    return this
  }

  /** Send a typed message (encoded via client's codec) */
  send(type, data) {
    if (this._ws.readyState !== 1) return
    const codec = _resolveCodec(this.protocol)
    const raw = codec ? codec.encode(type, data) : JSON.stringify({ type, data })
    this._pushToClient(raw)
  }

  /** Send a raw string (bypasses codec) */
  sendRaw(raw) {
    if (this._ws.readyState !== 1) return
    this._pushToClient(raw)
  }

  /** Close this client's connection */
  close(code = 1000, reason = '') {
    if (this._ws.readyState >= 2) return
    this._ws.readyState = 2
    setTimeout(() => {
      this._ws.readyState = 3
      _clients.delete(this)
      _instances.delete(this._ws)
      this._ws._fire('close', { code, reason, wasClean: code === 1000 })
      this._fireLocal('close', code, reason)
    }, _signals.closeDelay)
  }

  _pushToClient(raw) {
    if (_jitter) {
      setTimeout(() => {
        if (this._ws.readyState === 1) this._ws._fire('message', { data: raw })
      }, Math.random() * 600)
    } else {
      this._ws._fire('message', { data: raw })
    }
  }

  _fireLocal(event, ...args) {
    const fns = this._handlers[event]
    if (fns) fns.forEach(fn => fn(...args))
  }
}


// ===============================================================
// MockWebSocket — client-side (replaces window.WebSocket)
// ===============================================================

class MockWebSocket {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSING = 2
  static CLOSED = 3

  readyState = MockWebSocket.CONNECTING
  protocol = ''
  url = ''
  _listeners = {}
  _client = null

  constructor(url, protocols) {
    this.url = url
    this._requestedProtocols = Array.isArray(protocols)
      ? protocols
      : (protocols ? [protocols] : [])

    _instances.add(this)
    this._client = new MockClient(this)
    _clients.add(this._client)
    this._handshake()
  }

  addEventListener(type, fn) { (this._listeners[type] ??= []).push(fn) }

  removeEventListener(type, fn) {
    const arr = this._listeners[type]
    if (arr) this._listeners[type] = arr.filter(f => f !== fn)
  }

  send(data) {
    if (this.readyState !== MockWebSocket.OPEN) return

    // Heartbeat handling
    if (data === _signals.heartbeatReply || data === 'ping') {
      const delay = _jitter ? 100 + Math.random() * 400 : 10
      setTimeout(() => {
        if (this.readyState === MockWebSocket.OPEN) {
          this._fire('message', { data: _signals.heartbeatReply })
        }
      }, delay)
      return
    }

    // Forward to server-side client handlers
    if (this._client) {
      const delay = _jitter ? 200 + Math.random() * 800 : 5
      setTimeout(() => {
        if (this.readyState === MockWebSocket.OPEN) {
          this._client._fireLocal('message', data)
        }
      }, delay)
    }
  }

  close(code = 1000, reason = '') {
    if (this.readyState >= MockWebSocket.CLOSING) return
    this.readyState = MockWebSocket.CLOSING
    _instances.delete(this)
    _clients.delete(this._client)

    setTimeout(() => {
      this.readyState = MockWebSocket.CLOSED
      this._fire('close', { code, reason, wasClean: code === 1000 })
      if (this._client) {
        this._client.readyState = 3
        this._client._fireLocal('close', code, reason)
      }
    }, _signals.closeDelay)
  }

  simulateDrop() {
    this.readyState = MockWebSocket.CLOSED
    _instances.delete(this)
    _clients.delete(this._client)
    this._fire('close', { code: 1006, reason: 'abnormal closure', wasClean: false })
    if (this._client) {
      this._client.readyState = 3
      this._client._fireLocal('close', 1006, 'abnormal closure')
    }
  }

  _fire(type, data) {
    const fns = this._listeners[type]
    if (fns) fns.forEach(fn => fn(data))
  }

  _handshake() {
    const delay = rndDelay(_signals.connectDelay)

    setTimeout(() => {
      if (this.readyState !== MockWebSocket.CONNECTING) return

      const req = {
        url: this.url,
        protocols: [...this._requestedProtocols],
        headers: { 'upgrade': 'websocket', 'connection': 'Upgrade' },
      }

      if (_upgradeHandler) {
        let resolved = false

        const accept = (protocol = '') => {
          if (resolved) return
          resolved = true
          this._completeHandshake(protocol)
        }

        const reject = (code = 4000, reason = 'rejected') => {
          if (resolved) return
          resolved = true
          this.readyState = MockWebSocket.CLOSED
          _instances.delete(this)
          _clients.delete(this._client)
          this._fire('close', { code, reason, wasClean: false })
        }

        _upgradeHandler(req, accept, reject)

        if (!resolved) {
          setTimeout(() => {
            if (!resolved) accept(this._requestedProtocols[0] || '')
          }, 0)
        }
      } else {
        this._completeHandshake(this._requestedProtocols[0] || '')
      }
    }, delay)
  }

  _completeHandshake(protocol) {
    this.readyState = MockWebSocket.OPEN
    this.protocol = protocol
    this._client.readyState = 1
    this._client.protocol = protocol
    this._fire('open', {})

    if (_connectionHandler) {
      const req = {
        url: this.url,
        protocols: [...this._requestedProtocols],
        headers: { 'upgrade': 'websocket', 'connection': 'Upgrade' },
      }
      _connectionHandler(this._client, req)
    }
  }
}


// ===============================================================
// Module State
// ===============================================================

let _installed = false
let _RealWebSocket = null
let _jitter = false
let _interval = null
let _instances = new Set()
let _clients = new Set()
let _connectionHandler = null
let _upgradeHandler = null
const _generators = { ...GENERATORS }
const _codecs = new Map()

const _signals = {
  connectDelay:   [40, 120],
  closeDelay:     10,
  heartbeatReply: 'pong',
}


// -- Codec resolution --
function _resolveCodec(protocol) {
  if (!protocol) return _codecs.get('json') || null
  return _codecs.get(protocol) || null
}

// -- Default JSON codec fallback --
const _fallbackJsonCodec = {
  protocol: 'json',
  decode(raw) {
    const parsed = JSON.parse(raw)
    return { type: parsed.type || 'message', data: parsed.data !== undefined ? parsed.data : parsed }
  },
  encode(type, data) {
    return JSON.stringify({ type, data })
  },
}
_codecs.set('json', _fallbackJsonCodec)


// ===============================================================
// Simulator Controller
// ===============================================================

const sim = {

  // -- Setup --

  install() {
    if (_installed) return
    _RealWebSocket = globalThis.WebSocket
    globalThis.WebSocket = MockWebSocket
    _installed = true
  },

  uninstall() {
    if (!_installed) return
    this.stop()
    _connectionHandler = null
    _upgradeHandler = null
    for (const ws of _instances) ws.close(1000, 'simulator uninstalled')
    _instances.clear()
    _clients.clear()
    globalThis.WebSocket = _RealWebSocket
    _installed = false
  },

  get installed() { return _installed },


  // -- Server-Side Handlers --

  onConnection(fn) { _connectionHandler = fn },
  onUpgrade(fn) { _upgradeHandler = fn },


  // -- Codec Registry --

  codecs: _codecs,

  // -- Handshake Signals --

  signals: _signals,


  // -- Traffic Generation --

  start(rateMs = 1500) {
    this.stop()
    _interval = setInterval(() => this.tick(), rateMs)
  },

  stop() {
    if (_interval) { clearInterval(_interval); _interval = null }
  },

  get running() { return _interval !== null },

  tick() {
    const keys = Object.keys(_generators)
    if (keys.length === 0) return
    this.broadcast(_generators[rnd(keys)]())
  },

  fire(name) {
    const gen = _generators[name]
    if (!gen) {
      console.warn(`[socket-sim] Unknown generator: "${name}"`)
      return
    }
    this.broadcast(gen())
  },

  /**
   * Broadcast a message to all connected clients.
   * Encodes per-client based on their negotiated protocol.
   *
   * @param {{ context?: string, type: string, data: any }} msg
   *
   * For context-aware codecs (Meteor), the codec's encode() receives
   * the full msg so it can build the ctx:namespace:tail wire format.
   * For JSON codec, context is included in the data payload.
   */
  broadcast(msg) {
    for (const client of _clients) {
      if (client.readyState !== 1) continue
      const codec = _resolveCodec(client.protocol)
      let raw

      if (codec && codec.protocol !== 'json' && codec.encodeMessage) {
        // Context-aware codec: pass full message with context
        raw = codec.encodeMessage(msg)
      } else if (codec) {
        // Standard codec: encode type + data, include context in data if present
        const data = msg.context
          ? { ...msg.data, _context: msg.context }
          : msg.data
        raw = codec.encode(msg.type, data)
      } else {
        raw = JSON.stringify(msg)
      }

      client._pushToClient(raw)
    }
  },

  broadcastRaw(raw) {
    for (const client of _clients) {
      if (client.readyState !== 1) continue
      client._pushToClient(raw)
    }
  },


  // -- Generators --

  register(name, fn) { _generators[name] = fn },
  unregister(name) { delete _generators[name] },
  get generators() { return Object.keys(_generators) },


  // -- Chaos --

  set jitter(enabled) { _jitter = enabled },
  get jitter() { return _jitter },

  drop() {
    const instances = [..._instances]
    for (const ws of instances) ws.simulateDrop()
  },

  flood(count = 20) {
    for (let i = 0; i < count; i++) this.tick()
  },


  // -- Diagnostics --

  get connections() { return _instances.size },
  get clients() { return [..._clients] },
  MockWebSocket,
  MockClient,
}


export { sim, MockWebSocket, MockClient }
