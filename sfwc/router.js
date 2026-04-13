// ===============================================================
// router.js — Unity Design System · Router
// null.js · v1 · April 2026
//
// Navigation API primary, hash fallback (auto-detected).
// URLPattern for route matching.
// No dependency on app.js — wire via router.bus.
//
// Usage:
//   import { router } from './router.js'
//
//   router.on('/dashboard', {
//     guard: (params, url) => !!getUser() || '/login',
//     load:  () => import('./pages/dashboard.js'),
//     enter: (params, ctx) => { ctx.outlet.innerHTML = '<dash-page></dash-page>' },
//   })
//
//   router.on('/agents/:id', (params, ctx) => {
//     ctx.outlet.innerHTML = '<agent-page></agent-page>'
//   })
//
//   router.outlet(document.querySelector('u-view'))
//   router.start()
//
// Events (on router.bus):
//   'route:change' — { path, params, url }
//   'route:error'  — { path, error }
//
// Navigation:
//   router.push('/path')
//   router.replace('/path')
//
// Transition:
//   Adds 'u-view-enter' class to outlet after each route enter.
//   Define the animation in CSS:
//     .u-view-enter { animation: fadeIn 150ms ease-out; }
//     @keyframes fadeIn { from { opacity: 0 } to { opacity: 1 } }
//   Disable: router.start({ transition: false })
//
// ===============================================================

const router = (() => {

  const _bus    = new EventTarget()
  const _routes = []

  let _outlet  = null
  let _current = null
  let _onExit  = null
  let _mode    = null   // 'navigation' | 'hash' — set on start()
  let _transition = true  // auto fade-in outlet on route change

  // -- Route registration --------------------------------------

  function on(path, config) {
    const handler = typeof config === 'function'
      ? { enter: config }
      : config

    _routes.push({
      pattern: new URLPattern({ pathname: path }),
      ...handler,
    })
  }

  // -- Outlet --------------------------------------------------

  function outlet(el) {
    _outlet = el
  }

  // -- Navigation ----------------------------------------------

  function push(path) {
    if (_mode === 'navigation') {
      navigation.navigate(path)
    } else {
      location.hash = '#' + path
    }
  }

  function replace(path) {
    if (_mode === 'navigation') {
      navigation.navigate(path, { history: 'replace' })
    } else {
      // replaceState fails in sandboxed iframes (about:srcdoc)
      try {
        history.replaceState(null, '', '#' + path)
        _handleHash()
      } catch (e) {
        location.hash = '#' + path  // falls back to push (triggers hashchange)
      }
    }
  }

  // -- Current route -------------------------------------------

  function current() {
    return _current
  }

  // -- Internal: match URL against routes ----------------------

  function _match(pathname) {
    // Match against pathname only — avoids new URL() which fails
    // in contexts where location.origin is "null" (e.g. srcdoc iframes).
    for (const route of _routes) {
      const result = route.pattern.exec({ pathname })
      if (result) {
        return { route, params: result.pathname.groups }
      }
    }
    return null
  }

  // -- Internal: enter a route ---------------------------------

  async function _enter(match, path, signal) {
    const { route, params } = match

    // Guard
    if (route.guard) {
      try {
        const allowed = await route.guard(params, path)
        if (allowed !== true) {
          push(typeof allowed === 'string' ? allowed : '/')
          return
        }
      } catch (err) {
        _bus.dispatchEvent(new CustomEvent('route:error', {
          detail: { path, error: err },
        }))
        return
      }
    }

    // Exit previous route
    if (_onExit) {
      try { _onExit() } catch (e) { /* exit cleanup should not block */ }
      _onExit = null
    }

    // Lazy load
    if (route.load) {
      await route.load()
    }

    // Update current
    _current = { path, params }

    // Enter
    try {
      const exitFn = await route.enter(params, {
        outlet: _outlet,
        signal: signal || null,
        path,
      })
      if (typeof exitFn === 'function') {
        _onExit = exitFn
      }
    } catch (err) {
      _bus.dispatchEvent(new CustomEvent('route:error', {
        detail: { path, error: err },
      }))
      return
    }

    // Transition: fade-in the outlet if it exists
    if (_outlet && _transition) {
      _outlet.classList.remove('u-view-enter')
      void _outlet.offsetWidth  // force reflow to restart animation
      _outlet.classList.add('u-view-enter')
    }

    // Notify
    _bus.dispatchEvent(new CustomEvent('route:change', {
      detail: _current,
    }))
  }

  // -- Hash mode handler ---------------------------------------

  function _handleHash() {
    const raw = location.hash.slice(1) || '/'
    const pathname = raw.split('?')[0]  // strip query from hash path
    const match = _match(pathname)
    if (match) {
      _enter(match, raw, null)  // pass full raw (with query) as path
    }
  }

  // -- Navigation API mode handler -----------------------------

  function _handleNavigationEvent(event) {
    if (!event.canIntercept) return
    if (event.hashChange) return
    if (event.downloadRequest !== null) return

    const url = new URL(event.destination.url)
    const match = _match(url.pathname)
    if (!match) return

    event.intercept({
      async handler() {
        await _enter(match, url.pathname, event.signal)
      },
    })
  }

  // -- Feature detection ---------------------------------------

  function _detectMode() {
    // Navigation API: check existence and that it's functional
    if (typeof navigation !== 'undefined'
      && typeof navigation.addEventListener === 'function'
      && typeof navigation.navigate === 'function') {

      // Test if we can actually intercept (some iframes block this)
      try {
        // Dry-run: just check the API shape is real
        const entries = navigation.entries?.()
        if (entries !== undefined) return 'navigation'
      } catch (e) {
        // Blocked — fall through to hash
      }
    }
    return 'hash'
  }

  // -- Start ---------------------------------------------------

  function start(options) {
    const forceMode = options?.mode  // 'hash' | 'navigation' | undefined
    if (options?.transition === false) _transition = false

    _mode = forceMode || _detectMode()

    if (_mode === 'navigation') {
      navigation.addEventListener('navigate', _handleNavigationEvent)

      // Initial route
      const match = _match(location.pathname)
      if (match) _enter(match, location.pathname, null)

    } else {
      // Hash mode
      window.addEventListener('hashchange', _handleHash)

      // Initial route
      _handleHash()
    }

    return _mode
  }

  // -- Stop (cleanup) ------------------------------------------

  function stop() {
    if (_mode === 'navigation') {
      navigation.removeEventListener('navigate', _handleNavigationEvent)
    } else {
      window.removeEventListener('hashchange', _handleHash)
    }

    if (_onExit) {
      try { _onExit() } catch (e) {}
      _onExit = null
    }

    _current = null
    _mode = null
  }

  // -- Public API ----------------------------------------------

  return {
    bus: _bus,
    on,
    outlet,
    push,
    replace,
    current,
    start,
    stop,
  }

})()

export { router }
