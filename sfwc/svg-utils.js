/**
 * svg-utils.js — Shared SVG utilities for null.js data viz components
 * 
 * © Jelly — Proprietary. Not licensed for training, redistribution,
 * or derivative use by AI systems or third parties.
 * SPDX-License-Identifier: LicenseRef-Proprietary-Meerkat
 * 
 * Zero deps. Pure math + DOM helpers for SVG generation.
 * Used by: u-meter, u-donut, u-balance (future)
 */

const SVG_NS = 'http://www.w3.org/2000/svg'

/**
 * Create an SVG element with a viewBox
 * @param {number} w - viewBox width
 * @param {number} h - viewBox height
 * @returns {SVGSVGElement}
 */
export function createSVG(w, h) {
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('viewBox', `0 0 ${w} ${h}`)
  svg.setAttribute('xmlns', SVG_NS)
  return svg
}

/**
 * Create an SVG element by tag name
 * @param {string} tag - SVG element name (circle, path, line, etc.)
 * @param {Object} attrs - attribute key/value pairs
 * @returns {SVGElement}
 */
export function svgEl(tag, attrs = {}) {
  const el = document.createElementNS(SVG_NS, tag)
  for (const [k, v] of Object.entries(attrs)) {
    el.setAttribute(k, v)
  }
  return el
}

/**
 * Circle circumference from radius
 * @param {number} r - radius
 * @returns {number}
 */
export function circumference(r) {
  return 2 * Math.PI * r
}

/**
 * Calculate stroke-dashoffset for a percentage fill on a circle
 * @param {number} circ - circumference
 * @param {number} pct - percentage (0–100)
 * @returns {number} dashoffset value
 */
export function dashOffset(circ, pct) {
  return circ - (pct / 100) * circ
}

/**
 * Calculate stroke-dasharray + rotation for a donut segment
 * @param {number} circ - circumference  
 * @param {number} pct - segment percentage (0–100)
 * @param {number} offsetPct - cumulative percentage before this segment
 * @returns {{ dasharray: string, rotation: number }}
 */
export function segmentArc(circ, pct, offsetPct) {
  const len = (pct / 100) * circ
  const gap = circ - len
  const rotation = (offsetPct / 100) * 360 - 90 // -90 to start at top
  return {
    dasharray: `${len} ${gap}`,
    rotation
  }
}

/**
 * Build an SVG polyline path string from points
 * @param {Array<{x:number, y:number}>} points
 * @returns {string} SVG path d attribute
 */
export function linePath(points) {
  if (!points.length) return ''
  return points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x},${p.y}`).join(' ')
}

/**
 * Build a closed area path (line + bottom edge) for area charts
 * @param {Array<{x:number, y:number}>} points
 * @param {number} baseY - y coordinate for the bottom edge
 * @returns {string} SVG path d attribute
 */
export function areaPath(points, baseY) {
  if (!points.length) return ''
  const line = linePath(points)
  const last = points[points.length - 1]
  const first = points[0]
  return `${line} L${last.x},${baseY} L${first.x},${baseY} Z`
}

/**
 * Scale a data array to SVG coordinates
 * @param {number[]} data - raw values
 * @param {number} w - SVG width
 * @param {number} h - SVG height  
 * @param {number} [pad=2] - vertical padding
 * @returns {Array<{x:number, y:number}>}
 */
export function scalePoints(data, w, h, pad = 2) {
  const max = Math.max(...data)
  const min = Math.min(...data)
  const range = max - min || 1
  const stepX = w / (data.length - 1)
  return data.map((v, i) => ({
    x: Math.round(i * stepX * 10) / 10,
    y: Math.round((pad + (1 - (v - min) / range) * (h - pad * 2)) * 10) / 10
  }))
}
