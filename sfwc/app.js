// ===============================================================
// app.js — Unity Design System · Data Layer
// null.js · v1 · April 2026
//
// EventTarget bus + Set registry + cache
// Components own their lifecycle via AbortController
//
// Usage:
//   import { app } from './app.js'
//   app.register('agents', this)
//   app.update('agents', data)
//   app.bus.addEventListener('agents', handler, { signal })
// ===============================================================

const app = (() => {
  const _bus      = new EventTarget()
  const _cache    = {}
  const _registry = {}

  return {

    /** The event bus — subscribe with { signal } for cleanup */
    bus: _bus,

    /** Register element for direct render(data) calls */
    register(name, el) {
      (_registry[name] ??= new Set()).add(el)
      if (_cache[name]) {
        try { el.render(_cache[name]) }
        catch (e) { console.error('[app] render:', name, e) }
      }
    },

    /** Unregister on disconnectedCallback */
    unregister(name, el) {
      _registry[name]?.delete(el)
      if (_registry[name]?.size === 0) delete _registry[name]
    },

    /** Data arrived — cache + render + notify */
    update(name, data) {
      if (_cache[name] === data) return
      _cache[name] = data
      _registry[name]?.forEach(el => {
        try { el.render(data) }
        catch (e) { console.error('[app] render:', name, e) }
      })
      _bus.dispatchEvent(new CustomEvent(name, { detail: data }))
    },

    /** Intent / command — notify only, no cache */
    emit(name, data) {
      _bus.dispatchEvent(new CustomEvent(name, { detail: data }))
    },

    /** Read cached data */
    cache(name) {
      return _cache[name]
    },

    /** Clear cache (route transitions, invalidation) */
    clear(name) {
      delete _cache[name]
    },
  }
})()

export { app }
