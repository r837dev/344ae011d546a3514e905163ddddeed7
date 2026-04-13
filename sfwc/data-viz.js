/**
 * data-viz.js — Core data visualization web components
 * 
 * © Jelly — Proprietary. Not licensed for training, redistribution,
 * or derivative use by AI systems or third parties.
 * SPDX-License-Identifier: LicenseRef-Proprietary-Meerkat
 * 
 * Components: <u-sparkline>, <u-meter>, <u-donut>
 * Dependencies: svg-utils.js (ES module import)
 * 
 * All components use:
 *   - Constructable stylesheets (adoptedStyleSheets)
 *   - #private class fields (ES2022)
 *   - Token var map pattern (CSS custom props → component vars)
 *   - render(data) method for external updates
 *   - u: namespaced events
 */

import { createSVG, svgEl, circumference, dashOffset, segmentArc } from './svg-utils.js'


// =======================================================
// U-SPARKLINE
// Tiny inline bar chart from a numeric data array
// =======================================================

const sparkSheet = new CSSStyleSheet()
sparkSheet.replaceSync(`
  :host {
    /* -- token map -- */
    --spark-color:  var(--u-accent, oklch(0.55 0.22 250));
    --spark-height: 32px;
    --spark-bar-w:  3px;
    --spark-gap:    1px;
    --spark-radius: 1px;

    /* -- build -- */
    display: inline-flex;
    align-items: flex-end;
    gap: var(--spark-gap);
    height: var(--spark-height);
    contain: layout style;
  }
  :host([hidden]) { display: none; }

  /* sizes */
  :host([size="sm"])  { --spark-height: 20px; --spark-bar-w: 2px; }
  :host([size="lg"])  { --spark-height: 48px; --spark-bar-w: 4px; --spark-gap: 2px; --spark-radius: 2px; }
  :host([size="xl"])  { --spark-height: 64px; --spark-bar-w: 5px; --spark-gap: 2px; --spark-radius: 2px; }

  /* fill mode — bars expand to fill width */
  :host([fill]) { --spark-gap: 0px; --spark-radius: 0px; }
  :host([fill]) .bar { flex: 1; }

  /* gradient mode */
  :host([gradient]) .bar {
    background: linear-gradient(to top, var(--spark-color), color-mix(in srgb, var(--spark-color) 40%, transparent));
  }

  .bar {
    width: var(--spark-bar-w);
    border-radius: var(--spark-radius) var(--spark-radius) 0 0;
    background: var(--spark-color);
    min-height: 1px;
    transition: height 150ms ease;
  }

  /* -- rainbow / status colors via custom state -- */
  :host(:state(color-ok))     { --spark-color: var(--u-ok,     #94DB82); }
  :host(:state(color-err))    { --spark-color: var(--u-err,    #FB6460); }
  :host(:state(color-warn))   { --spark-color: var(--u-warn,   #ffa64d); }
  :host(:state(color-red))    { --spark-color: #FB6460; }
  :host(:state(color-orange)) { --spark-color: #ffa64d; }
  :host(:state(color-green))  { --spark-color: #94DB82; }
  :host(:state(color-teal))   { --spark-color: #14cab8; }
  :host(:state(color-blue))   { --spark-color: #75BAFF; }
  :host(:state(color-purple)) { --spark-color: #7D7DFF; }
  :host(:state(color-pink))   { --spark-color: #f965cb; }
  :host(:state(color-dream))  { --spark-color: #c1aafa; }
  :host(:state(color-salmon)) { --spark-color: #ff9da4; }
`)

class USparkline extends HTMLElement {
  #internals
  #data = []

  static get observedAttributes() { return ['data', 'color'] }

  constructor() {
    super()
    this.attachShadow({ mode: 'open' })
    this.shadowRoot.adoptedStyleSheets = [sparkSheet]
    this.#internals = this.attachInternals()
  }

  connectedCallback() {
    // Parse initial data from attribute
    const raw = this.getAttribute('data')
    if (raw) this.#parseAndRender(raw)
  }

  attributeChangedCallback(name, old, val) {
    if (name === 'data' && val !== old) this.#parseAndRender(val)
    if (name === 'color') this.#setColor(val)
  }

  #parseAndRender(raw) {
    try {
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) {
        this.#data = parsed
        this.#render()
      }
    } catch { /* invalid JSON, ignore */ }
  }

  #setColor(color) {
    // Clear previous color states
    for (const s of [...this.#internals.states]) {
      if (s.startsWith('color-')) this.#internals.states.delete(s)
    }
    if (color) this.#internals.states.add(`color-${color}`)
  }

  #render() {
    const data = this.#data
    if (!data.length) { this.shadowRoot.innerHTML = ''; return }
    const max = Math.max(...data)
    if (max === 0) { this.shadowRoot.innerHTML = ''; return }

    // Build bars — reuse existing DOM if count matches
    const existing = this.shadowRoot.querySelectorAll('.bar')
    if (existing.length === data.length) {
      data.forEach((v, i) => {
        existing[i].style.height = `${(v / max) * 100}%`
      })
    } else {
      const frag = document.createDocumentFragment()
      data.forEach(v => {
        const bar = document.createElement('div')
        bar.className = 'bar'
        bar.style.height = `${(v / max) * 100}%`
        frag.appendChild(bar)
      })
      this.shadowRoot.replaceChildren(frag)
    }

    this.dispatchEvent(new CustomEvent('u:render', {
      bubbles: true, composed: true,
      detail: { count: data.length, max }
    }))
  }

  /**
   * Render from external data
   * @param {number[]} data - array of numeric values
   */
  render(data) {
    if (Array.isArray(data)) {
      this.#data = data
      this.#render()
      // Sync attribute (without re-triggering render)
      this.setAttribute('data', JSON.stringify(data))
    }
  }

  /** @returns {number[]} current data */
  get data() { return [...this.#data] }
}

customElements.define('u-sparkline', USparkline)


// =======================================================
// U-METER
// SVG ring gauge driven by value attribute
// =======================================================

const meterSheet = new CSSStyleSheet()
meterSheet.replaceSync(`
  :host {
    /* -- token map -- */
    --meter-size:     80px;
    --meter-stroke:   6px;
    --meter-color:    var(--u-accent, oklch(0.55 0.22 250));
    --meter-track:    var(--u-surface-2, oklch(0.955 0.004 240));
    --meter-fg:       var(--u-fg, oklch(0.05 0 0));
    --meter-fg-muted: var(--u-fg-muted, oklch(0.44 0.005 240));

    /* -- build -- */
    position: relative;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: var(--meter-size);
    height: var(--meter-size);
    contain: layout style;
  }
  :host([hidden]) { display: none; }

  /* sizes */
  :host([size="sm"]) { --meter-size: 56px; --meter-stroke: 4px; }
  :host([size="lg"]) { --meter-size: 112px; --meter-stroke: 8px; }
  :host([size="xl"]) { --meter-size: 144px; --meter-stroke: 10px; }

  svg {
    width: 100%;
    height: 100%;
    transform: rotate(-90deg);
  }
  .track {
    fill: none;
    stroke: var(--meter-track);
    stroke-width: var(--meter-stroke);
  }
  .fill {
    fill: none;
    stroke: var(--meter-color);
    stroke-width: var(--meter-stroke);
    stroke-linecap: round;
    transition: stroke-dashoffset 600ms cubic-bezier(0.4, 0, 0.2, 1);
  }
  .label {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 1px;
    pointer-events: none;
  }
  .value {
    font: 600 1rem/1 var(--u-font-mono, 'JetBrains Mono', monospace);
    color: var(--meter-fg);
    font-variant-numeric: tabular-nums;
  }
  :host([size="sm"]) .value { font-size: 0.75rem; }
  :host([size="lg"]) .value { font-size: 1.25rem; }
  :host([size="xl"]) .value { font-size: 1.5rem; }

  .sub {
    font: 500 0.5625rem/1 var(--u-font-mono, 'JetBrains Mono', monospace);
    color: var(--meter-fg-muted);
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }

  /* -- colors via custom state -- */
  :host(:state(color-ok))     { --meter-color: var(--u-ok,   #94DB82); }
  :host(:state(color-warn))   { --meter-color: var(--u-warn, #ffa64d); }
  :host(:state(color-err))    { --meter-color: var(--u-err,  #FB6460); }
  :host(:state(color-teal))   { --meter-color: #14cab8; }
  :host(:state(color-blue))   { --meter-color: #75BAFF; }
  :host(:state(color-purple)) { --meter-color: #7D7DFF; }
  :host(:state(color-green))  { --meter-color: #94DB82; }
  :host(:state(color-pink))   { --meter-color: #f965cb; }
  :host(:state(color-dream))  { --meter-color: #c1aafa; }
`)

class UMeter extends HTMLElement {
  #internals
  #svg
  #track
  #fill
  #valueEl
  #subEl
  #value = 0

  static get observedAttributes() { return ['value', 'label', 'sub', 'color', 'size'] }

  constructor() {
    super()
    this.attachShadow({ mode: 'open' })
    this.shadowRoot.adoptedStyleSheets = [meterSheet]
    this.#internals = this.attachInternals()
  }

  connectedCallback() {
    this.#buildDOM()
    this.#setColor(this.getAttribute('color'))
    this.#update()
  }

  attributeChangedCallback(name, old, val) {
    if (!this.#svg) return // not yet connected
    if (name === 'value') this.#update()
    if (name === 'label') this.#valueEl.textContent = val ?? ''
    if (name === 'sub') this.#subEl.textContent = val ?? ''
    if (name === 'color') this.#setColor(val)
    if (name === 'size') this.#rebuildSVG()
  }

  #buildDOM() {
    this.shadowRoot.innerHTML = ''
    this.#buildSVG()

    const label = document.createElement('div')
    label.className = 'label'
    this.#valueEl = document.createElement('span')
    this.#valueEl.className = 'value'
    this.#valueEl.textContent = this.getAttribute('label') ?? ''
    this.#subEl = document.createElement('span')
    this.#subEl.className = 'sub'
    this.#subEl.textContent = this.getAttribute('sub') ?? ''
    label.append(this.#valueEl, this.#subEl)

    this.shadowRoot.append(this.#svg, label)
  }

  #buildSVG() {
    // Read computed size from CSS
    const sizeAttr = this.getAttribute('size')
    const sizeMap = { sm: 56, lg: 112, xl: 144 }
    const strokeMap = { sm: 4, lg: 8, xl: 10 }
    const size = sizeMap[sizeAttr] || 80
    const stroke = strokeMap[sizeAttr] || 6
    const r = (size - stroke) / 2
    const cx = size / 2, cy = size / 2

    this.#svg = createSVG(size, size)
    this.#track = svgEl('circle', { cx, cy, r, class: 'track' })
    this.#fill = svgEl('circle', { cx, cy, r, class: 'fill' })

    const circ = circumference(r)
    this.#fill.setAttribute('stroke-dasharray', circ)
    this.#fill.setAttribute('stroke-dashoffset', circ) // start empty
    this.#fill.dataset.circ = circ
    this.#fill.dataset.r = r

    this.#svg.append(this.#track, this.#fill)
  }

  #rebuildSVG() {
    const oldSVG = this.#svg
    this.#buildSVG()
    oldSVG.replaceWith(this.#svg)
    this.#update()
  }

  #update() {
    const raw = parseFloat(this.getAttribute('value')) || 0
    this.#value = Math.max(0, Math.min(100, raw))
    const circ = parseFloat(this.#fill.dataset.circ)
    this.#fill.setAttribute('stroke-dashoffset', dashOffset(circ, this.#value))

    // Auto-set label if not explicitly set
    if (!this.hasAttribute('label')) {
      this.#valueEl.textContent = `${Math.round(this.#value)}%`
    }

    this.dispatchEvent(new CustomEvent('u:change', {
      bubbles: true, composed: true,
      detail: { value: this.#value }
    }))
  }

  #setColor(color) {
    for (const s of [...this.#internals.states]) {
      if (s.startsWith('color-')) this.#internals.states.delete(s)
    }
    if (color) this.#internals.states.add(`color-${color}`)
  }

  /**
   * Update meter value programmatically
   * @param {Object} d - { value?: number, label?: string, sub?: string, color?: string }
   */
  render(d) {
    if (d.value !== undefined) this.setAttribute('value', d.value)
    if (d.label !== undefined) this.setAttribute('label', d.label)
    if (d.sub !== undefined) this.setAttribute('sub', d.sub)
    if (d.color !== undefined) this.setAttribute('color', d.color)
  }

  get value() { return this.#value }
  set value(v) { this.setAttribute('value', v) }
}

customElements.define('u-meter', UMeter)


// =======================================================
// U-DONUT
// SVG donut/pie chart with segments
// =======================================================

const donutSheet = new CSSStyleSheet()
donutSheet.replaceSync(`
  :host {
    /* -- token map -- */
    --donut-size:   120px;
    --donut-stroke: 24px;
    --donut-track:  var(--u-surface-2, oklch(0.955 0.004 240));
    --donut-fg:     var(--u-fg, oklch(0.05 0 0));
    --donut-fg-dim: var(--u-fg-dim, oklch(0.65 0.004 240));

    /* -- build -- */
    position: relative;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: var(--donut-size);
    height: var(--donut-size);
    contain: layout style;
  }
  :host([hidden]) { display: none; }

  /* sizes */
  :host([size="sm"]) { --donut-size: 80px; --donut-stroke: 16px; }
  :host([size="lg"]) { --donut-size: 160px; --donut-stroke: 28px; }

  /* pie mode — filled circle */
  :host([pie]) { --donut-stroke: calc(var(--donut-size) / 2); }

  svg {
    width: 100%;
    height: 100%;
    transform: rotate(-90deg);
  }
  .track {
    fill: none;
    stroke: var(--donut-track);
  }
  .seg {
    fill: none;
    stroke-linecap: butt;
    transition: stroke-dasharray 400ms ease, opacity 150ms ease;
  }
  .seg:hover { opacity: 0.8; }

  .label {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 1px;
    pointer-events: none;
  }
  .value {
    font: 600 1.125rem/1 var(--u-font-mono, 'JetBrains Mono', monospace);
    color: var(--donut-fg);
    font-variant-numeric: tabular-nums;
  }
  :host([size="sm"]) .value { font-size: 0.8125rem; }
  :host([size="lg"]) .value { font-size: 1.375rem; }
  .sub {
    font: 500 0.5625rem/1 var(--u-font-mono, 'JetBrains Mono', monospace);
    color: var(--donut-fg-dim);
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }
`)

// Default rainbow palette for auto-coloring
const RAINBOW = [
  '#75BAFF', '#7D7DFF', '#14cab8', '#94DB82',
  '#ffa64d', '#f965cb', '#c1aafa', '#FB6460',
  '#ff9da4', '#ffe13f'
]

class UDonut extends HTMLElement {
  #internals
  #svg
  #labelEl
  #valueEl
  #subEl
  #segments = []

  static get observedAttributes() { return ['label', 'sub', 'size', 'pie'] }

  constructor() {
    super()
    this.attachShadow({ mode: 'open' })
    this.shadowRoot.adoptedStyleSheets = [donutSheet]
    this.#internals = this.attachInternals()
  }

  connectedCallback() {
    this.#buildDOM()

    // Check for inline data attribute
    const raw = this.getAttribute('data')
    if (raw) {
      try {
        const parsed = JSON.parse(raw)
        if (Array.isArray(parsed)) this.render(parsed)
      } catch { /* ignore */ }
    }
  }

  attributeChangedCallback(name, old, val) {
    if (!this.#svg) return
    if (name === 'label') this.#valueEl.textContent = val ?? ''
    if (name === 'sub') this.#subEl.textContent = val ?? ''
    if (name === 'size' || name === 'pie') this.#redraw()
  }

  #buildDOM() {
    this.shadowRoot.innerHTML = ''

    this.#svg = null // built during render
    this.#labelEl = document.createElement('div')
    this.#labelEl.className = 'label'
    this.#valueEl = document.createElement('span')
    this.#valueEl.className = 'value'
    this.#valueEl.textContent = this.getAttribute('label') ?? ''
    this.#subEl = document.createElement('span')
    this.#subEl.className = 'sub'
    this.#subEl.textContent = this.getAttribute('sub') ?? ''
    this.#labelEl.append(this.#valueEl, this.#subEl)

    this.shadowRoot.append(this.#labelEl)
  }

  #getGeometry() {
    const sizeAttr = this.getAttribute('size')
    const sizeMap = { sm: 80, lg: 160 }
    const strokeMap = { sm: 16, lg: 28 }
    const size = sizeMap[sizeAttr] || 120
    let stroke = strokeMap[sizeAttr] || 24
    if (this.hasAttribute('pie')) stroke = size / 2
    const r = (size - stroke) / 2
    const cx = size / 2, cy = size / 2
    const circ = circumference(r)
    return { size, stroke, r, cx, cy, circ }
  }

  #redraw() {
    if (this.#segments.length) this.render(this.#segments)
  }

  /**
   * Render donut segments
   * @param {Array<{value: number, color?: string, label?: string}>} segments
   *   value: numeric weight (will be normalized to %)
   *   color: CSS color string (optional, auto-assigned from rainbow)
   *   label: segment label for hover title (optional)
   */
  render(segments) {
    this.#segments = segments
    const { size, stroke, r, cx, cy, circ } = this.#getGeometry()

    // Normalize values to percentages
    const total = segments.reduce((s, seg) => s + (seg.value || 0), 0)
    if (total === 0) return

    // Build SVG
    const svg = createSVG(size, size)

    // Background track
    const track = svgEl('circle', { cx, cy, r, class: 'track', 'stroke-width': stroke })
    svg.appendChild(track)

    // Segments
    let offsetPct = 0
    segments.forEach((seg, i) => {
      const pct = (seg.value / total) * 100
      const color = seg.color || RAINBOW[i % RAINBOW.length]
      const { dasharray, rotation } = segmentArc(circ, pct, offsetPct)

      const circle = svgEl('circle', {
        cx, cy, r,
        class: 'seg',
        'stroke-width': stroke,
        stroke: color,
        'stroke-dasharray': dasharray,
        transform: `rotate(${rotation} ${cx} ${cy})`
      })

      if (seg.label) {
        const title = document.createElementNS('http://www.w3.org/2000/svg', 'title')
        title.textContent = `${seg.label}: ${Math.round(pct)}%`
        circle.appendChild(title)
      }

      svg.appendChild(circle)
      offsetPct += pct
    })

    // Replace SVG
    if (this.#svg) {
      this.#svg.replaceWith(svg)
    } else {
      this.shadowRoot.insertBefore(svg, this.#labelEl)
    }
    this.#svg = svg

    this.dispatchEvent(new CustomEvent('u:render', {
      bubbles: true, composed: true,
      detail: { segments: segments.length, total }
    }))
  }

  /** @returns {Array} current segments */
  get segments() { return [...this.#segments] }
}

customElements.define('u-donut', UDonut)
