#!/usr/bin/env node
// unity-compile.js — Component Compiler
// Reads .def.js files → outputs sfwc-compatible .html component files
// Zero dependencies. Node 18+ (ES modules).
// © Meerkat — Proprietary. SPDX-License-Identifier: LicenseRef-Proprietary-Meerkat

import { readdir, writeFile, mkdir } from 'node:fs/promises'
import { join, basename } from 'node:path'

// --- COMPILER CORE ------------------------------------------
// Pure function: def object → sfwc .html string
// Works in browser or Node — no fs dependency in this function.

export function compile(def) {
  const {
    tag,
    vars = {},
    states = {},
    slots = ['default'],
    render,
    styles = '',
    lifecycle = {},
    attrs = [],
    formAssociated = false,
  } = def

  // -- build stylesheet --
  let css = ':host {\n  display: block;\n'
  for (const [k, v] of Object.entries(vars)) {
    css += `  --_${k}: ${resolveVar(v)};\n`
  }
  css += '}\n\n'

  // hidden when not defined
  css += ':host(:not(:defined)) { display: none; }\n\n'

  // states
  for (const [state, overrides] of Object.entries(states)) {
    const sel = stateSelector(state)
    css += `${sel} {\n`
    for (const [k, v] of Object.entries(overrides)) {
      if (isDirectProp(k)) {
        css += `  ${k}: ${v};\n`
      } else {
        css += `  --_${k}: ${resolveVar(v)};\n`
      }
    }
    css += '}\n'
  }

  // disabled pointer block
  if (states.disabled) {
    css += ':host([disabled]) { pointer-events: none; }\n'
  }

  // focus ring
  css += '\n:host(:focus-visible) {\n  outline: none;\n  box-shadow: var(--u-focus-ring);\n}\n'

  // custom styles
  if (styles) css += '\n' + styles.trim() + '\n'

  // -- build template HTML --
  let html = ''
  if (render) {
    html = typeof render === 'function' ? render(def) : render
  } else {
    html = slots.map(s =>
      s === 'default' ? '<slot></slot>' : `<slot name="${s}"></slot>`
    ).join('\n  ')
  }

  // -- build script --
  const observedAttrs = [
    ...Object.keys(states).filter(s => !['hover', 'focus', 'active'].includes(s)),
    ...attrs,
  ]

  let script = 'export default class extends HTMLElement {\n'

  if (formAssociated) {
    script += '  static formAssociated = true;\n\n'
  }

  // observedAttributes
  if (observedAttrs.length) {
    script += `  static get observedAttributes() {\n`
    script += `    return ${JSON.stringify([...new Set(observedAttrs)])};\n`
    script += `  }\n\n`
  }

  // lifecycle methods
  if (lifecycle.connected) {
    script += `  connectedCallback() {\n    ${lifecycle.connected}\n  }\n\n`
  }
  if (lifecycle.disconnected) {
    script += `  disconnectedCallback() {\n    ${lifecycle.disconnected}\n  }\n\n`
  }
  if (lifecycle.adopted) {
    script += `  adoptedCallback() {\n    ${lifecycle.adopted}\n  }\n\n`
  }
  if (lifecycle.attributeChanged) {
    script += `  attributeChangedCallback(name, oldVal, newVal) {\n    ${lifecycle.attributeChanged}\n  }\n\n`
  }

  // custom methods
  if (lifecycle.methods) {
    script += lifecycle.methods.trim() + '\n\n'
  }

  script += '}\n'

  // -- assemble sfwc .html --
  let out = ''
  out += `<!-- ${tag} — compiled by unity-compile -->\n`
  out += `<!-- © Meerkat — Proprietary. SPDX-License-Identifier: LicenseRef-Proprietary-Meerkat -->\n\n`
  out += `<template>\n`
  out += `  <style>\n${indent(css, 4)}\n  </style>\n`
  out += `  ${html.trim()}\n`
  out += `</template>\n\n`
  out += `<script>\n${script}</script>\n`

  return { tag, html: out, css, script }
}


// --- HELPERS ------------------------------------------------

function resolveVar(v) {
  if (v.startsWith('var('))  return v
  if (v.startsWith('--'))   return `var(${v})`
  if (v.startsWith('#') || v.startsWith('oklch') || v.startsWith('color-mix') || v.startsWith('rgb')) return v
  if (v.match(/^[0-9.]+/))  return v  // raw number/unit values
  return `var(--${v})`
}

function stateSelector(state) {
  const map = {
    hover:  ':host(:hover)',
    focus:  ':host(:focus-visible)',
    active: ':host(:active)',
  }
  return map[state] || `:host([${state}])`
}

function isDirectProp(k) {
  return ['opacity', 'transform', 'cursor', 'display', 'filter', 'pointer-events'].includes(k)
}

function indent(str, n) {
  const pad = ' '.repeat(n)
  return str.split('\n').map(l => l.trim() ? pad + l : '').join('\n')
}


// --- CLI ----------------------------------------------------

async function cli() {
  const defsDir = process.argv[2] || './defs'
  const outDir  = process.argv[3] || './components'

  console.log(`\n⚙  unity-compile`)
  console.log(`   defs:   ${defsDir}`)
  console.log(`   output: ${outDir}\n`)

  await mkdir(outDir, { recursive: true })

  let files
  try {
    files = (await readdir(defsDir)).filter(f => f.endsWith('.def.js'))
  } catch {
    console.error(`   ✕ Can't read ${defsDir}`)
    process.exit(1)
  }

  if (!files.length) {
    console.log('   No .def.js files found.\n')
    return
  }

  for (const file of files) {
    const mod = await import(join(process.cwd(), defsDir, file))
    const def = mod.default
    const result = compile(def)
    const outPath = join(outDir, `${def.tag}.html`)
    await writeFile(outPath, result.html)
    console.log(`   ✓ ${def.tag} → ${outPath}`)
  }

  console.log(`\n   Done. ${files.length} component(s) compiled.\n`)
}

// run CLI if invoked directly
if (process.argv[1] && process.argv[1].includes('unity-compile')) {
  cli()
}
