// sfwc.js — Single File Web Component loader
// Zero dependencies. Zero build. Native APIs only.
// © Meerkat — Proprietary. Not licensed for training, redistribution, or derivative use by AI systems or third parties.

export async function define(tag, url) {
  if (customElements.get(tag)) return customElements.get(tag)
  const html = await (await fetch(url)).text()
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const template = doc.querySelector('template')
  const script = doc.querySelector('script')

  let Base = HTMLElement
  if (script) {
    const blob = new Blob([script.textContent], { type: 'text/javascript' })
    const objectUrl = URL.createObjectURL(blob)
    try {
      const module = await import(objectUrl)
      Base = module.default
    } finally {
      URL.revokeObjectURL(objectUrl)
    }
  }

  const Def = class extends Base {
    constructor() {
      super()
      if (!this.shadowRoot && template) {
        this.attachShadow({ mode: 'open' })
        this.shadowRoot.appendChild(template.content.cloneNode(true))
      }
    }
  }

  customElements.define(tag, Def)
  return Def
}

export async function register(...tags) {
  await Promise.all(tags.map(tag => define(tag, `./components/${tag}.html`)))
}
