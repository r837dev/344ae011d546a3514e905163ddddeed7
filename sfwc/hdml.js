/**
 * hdml.js — Live HDML-to-DOM renderer.
 *
 * Full-featured: tags, nesting, @prefix, $tokens, on-* events,
 * #{interpolation}, !{raw}, if/else, each loops, mixin/+mixin(),
 * #[inline tags], comments, pipe text, void elements.
 *
 * Usage:
 *   hdml.render(source, targetEl, { prefix: 'u', data: { title: 'Hi' } })
 *   hdml.parse(source, opts) -> DocumentFragment
 *   hdml.mount(source, '#app', opts)
 *
 * (c) Meerkat — Proprietary.
 */

const hdml = (() => {
  const VOID = new Set([
    'area','base','br','col','embed','hr','img','input',
    'link','meta','param','source','track','wbr'
  ]);

  const DEFAULT_PROPS = {
    bg: 'background', 'bg-color': 'background-color',
    color: 'color', 'border-color': 'border-color',
    padding: 'padding', pt: 'padding-top', pb: 'padding-bottom',
    pl: 'padding-left', pr: 'padding-right',
    margin: 'margin', mt: 'margin-top', mb: 'margin-bottom',
    ml: 'margin-left', mr: 'margin-right',
    gap: 'gap', radius: 'border-radius', border: 'border',
    shadow: 'box-shadow', opacity: 'opacity', z: 'z-index',
    font: 'font-family', size: 'font-size', weight: 'font-weight',
    leading: 'line-height', tracking: 'letter-spacing', align: 'text-align',
    width: 'width', height: 'height',
    'max-w': 'max-width', 'max-h': 'max-height',
    'min-w': 'min-width', 'min-h': 'min-height',
    transition: 'transition', transform: 'transform',
    cursor: 'cursor', overflow: 'overflow',
  };

  const AXIS_PROPS = {
    px: ['padding-left', 'padding-right'],
    py: ['padding-top', 'padding-bottom'],
    mx: ['margin-left', 'margin-right'],
    my: ['margin-top', 'margin-bottom'],
  };

  // ── Interpolation ─────────────────────────────────────────────

  function interpolate(text, data) {
    if (!text) return text;
    return text.replace(/(!?\{)(.*?)\}/g, (match, open, expr) => {
      if (!open.startsWith('#') && !open.startsWith('!')) {
        // Check for #{...} or !{...} by looking one char before.
        return match;
      }
      const raw = open === '!{';
      const val = resolvePath(data, expr.trim());
      const str = val == null ? '' : String(val);
      return raw ? str : escapeHtml(str);
    }).replace(/#\{(.*?)\}/g, (_, expr) => {
      const val = resolvePath(data, expr.trim());
      return val == null ? '' : escapeHtml(String(val));
    }).replace(/!\{(.*?)\}/g, (_, expr) => {
      const val = resolvePath(data, expr.trim());
      return val == null ? '' : String(val);
    });
  }

  function resolvePath(data, path) {
    if (!data || !path) return undefined;
    return path.split('.').reduce((obj, key) => obj && obj[key], data);
  }

  function escapeHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;')
            .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // ── Inline tags: #[tag(attrs) content] ────────────────────────

  function processInlineText(text, data) {
    const interpolated = interpolate(text, data);
    if (!interpolated || !interpolated.includes('#[')) return interpolated;

    let result = '';
    let pos = 0;
    while (pos < interpolated.length) {
      const idx = interpolated.indexOf('#[', pos);
      if (idx === -1) {
        result += interpolated.slice(pos);
        break;
      }
      result += interpolated.slice(pos, idx);
      pos = idx + 2;

      // Parse tag name.
      let tagEnd = pos;
      while (tagEnd < interpolated.length && /[a-zA-Z0-9\-_]/.test(interpolated[tagEnd])) tagEnd++;
      const tag = interpolated.slice(pos, tagEnd);
      pos = tagEnd;

      // Parse optional attrs.
      let attrsStr = '';
      if (interpolated[pos] === '(') {
        pos++;
        const attrStart = pos;
        while (pos < interpolated.length && interpolated[pos] !== ')') pos++;
        attrsStr = interpolated.slice(attrStart, pos);
        pos++; // skip )
      }

      // Skip space.
      if (interpolated[pos] === ' ') pos++;

      // Content until matching ].
      const contentStart = pos;
      let depth = 1;
      while (pos < interpolated.length && depth > 0) {
        if (interpolated[pos] === '[') depth++;
        else if (interpolated[pos] === ']') { depth--; if (depth === 0) break; }
        pos++;
      }
      const content = interpolated.slice(contentStart, pos);
      pos++; // skip ]

      // Build tag HTML.
      let attrHtml = '';
      if (attrsStr) {
        attrsStr.replace(/([a-zA-Z\-]+)="([^"]*)"/g, (_, name, val) => {
          attrHtml += ` ${name}="${escapeHtml(val)}"`;
        });
      }

      // Recurse for nested inline tags.
      const inner = processInlineText(content, data);
      result += `<${tag}${attrHtml}>${inner}</${tag}>`;
    }
    return result;
  }

  // ── Condition helpers ─────────────────────────────────────────

  function evalCondition(expr, data) {
    expr = expr.trim();
    if (expr.startsWith('(') && expr.endsWith(')')) {
      return evalHelper(expr.slice(1, -1).trim(), data);
    }
    // String literal comparison not in simple truthiness.
    return isTruthy(resolvePath(data, expr));
  }

  function evalHelper(expr, data) {
    const spaceIdx = expr.indexOf(' ');
    if (spaceIdx === -1) return isTruthy(resolvePath(data, expr));
    const helper = expr.slice(0, spaceIdx);
    const rest = expr.slice(spaceIdx + 1).trim();

    switch (helper) {
      case 'not': return !evalCondition(rest, data);
      case 'and': { const [a, b] = splitTwo(rest); return evalCondition(a, data) && evalCondition(b, data); }
      case 'or':  { const [a, b] = splitTwo(rest); return evalCondition(a, data) || evalCondition(b, data); }
      case 'eq':  { const [a, b] = splitTwo(rest); return resolveArg(a, data) === resolveArg(b, data); }
      case 'ne':  { const [a, b] = splitTwo(rest); return resolveArg(a, data) !== resolveArg(b, data); }
      case 'gt':  { const [a, b] = splitTwo(rest); return Number(resolveArg(a, data)) > Number(resolveArg(b, data)); }
      case 'lt':  { const [a, b] = splitTwo(rest); return Number(resolveArg(a, data)) < Number(resolveArg(b, data)); }
      case 'gte': { const [a, b] = splitTwo(rest); return Number(resolveArg(a, data)) >= Number(resolveArg(b, data)); }
      case 'lte': { const [a, b] = splitTwo(rest); return Number(resolveArg(a, data)) <= Number(resolveArg(b, data)); }
      default: return false;
    }
  }

  function splitTwo(s) {
    s = s.trim();
    // Handle quoted first arg.
    if (s[0] === '"') {
      const end = s.indexOf('"', 1);
      return [s.slice(0, end + 1), s.slice(end + 1).trim()];
    }
    // Handle nested s-expression.
    if (s[0] === '(') {
      let depth = 0;
      for (let i = 0; i < s.length; i++) {
        if (s[i] === '(') depth++;
        else if (s[i] === ')') { depth--; if (depth === 0) return [s.slice(0, i + 1), s.slice(i + 1).trim()]; }
      }
    }
    const sp = s.indexOf(' ');
    return sp === -1 ? [s, ''] : [s.slice(0, sp), s.slice(sp + 1).trim()];
  }

  function resolveArg(arg, data) {
    arg = arg.trim();
    if (arg.startsWith('"') && arg.endsWith('"')) return arg.slice(1, -1);
    if (arg.startsWith('(')) return evalCondition(arg, data);
    const val = resolvePath(data, arg);
    return val == null ? '' : val;
  }

  function isTruthy(val) {
    if (val == null) return false;
    if (val === false || val === 0 || val === '') return false;
    if (Array.isArray(val) && val.length === 0) return false;
    return true;
  }

  // ── Core parser ───────────────────────────────────────────────

  function parse(source, opts = {}) {
    const prefix = opts.prefix || null;
    const tokenPrefix = opts.tokenPrefix || opts.prefix || 'u';
    const props = { ...DEFAULT_PROPS, ...(opts.props || {}) };
    const data = opts.data || {};
    // Template provider: opts.templates map, or auto-discover <script type="text/hdml">.
    const templates = opts.templates || discoverTemplates();
    const lines = source.split('\n');

    // Pre-scan for directives and mixins.
    const mixins = {};
    const fileProps = {};
    let filePrefix = prefix;
    const contentLines = [];
    let inMixin = null;
    let mixinIndent = 0;

    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i];
      const content = raw.trimStart();
      const indent = raw.length - raw.trimStart().length;

      if (content.startsWith('@prefix ')) {
        filePrefix = content.slice(8).trim();
        continue;
      }
      if (content.startsWith('@prop ')) {
        const rest = content.slice(6).trim();
        const eq = rest.indexOf('=');
        if (eq !== -1) fileProps[rest.slice(0, eq).trim()] = rest.slice(eq + 1).trim();
        continue;
      }

      // Mixin collection.
      if (content.startsWith('mixin ')) {
        const rest = content.slice(6).trim();
        const parenIdx = rest.indexOf('(');
        let name, params = [];
        if (parenIdx !== -1) {
          name = rest.slice(0, parenIdx);
          params = rest.slice(parenIdx + 1, rest.indexOf(')')).split(',').map(s => s.trim()).filter(Boolean);
        } else {
          name = rest;
        }
        inMixin = { name, params, lines: [], indent };
        mixinIndent = indent;
        continue;
      }
      if (inMixin) {
        if (indent > mixinIndent || content === '') {
          inMixin.lines.push(raw);
          continue;
        } else {
          mixins[inMixin.name] = { params: inMixin.params, body: inMixin.lines.join('\n') };
          inMixin = null;
        }
      }

      contentLines.push(raw);
    }
    if (inMixin) {
      mixins[inMixin.name] = { params: inMixin.params, body: inMixin.lines.join('\n') };
    }

    const allProps = { ...props, ...fileProps };
    const resolvedPrefix = filePrefix;

    // Handle extends: load parent, merge blocks.
    let finalLines = contentLines;
    const extendsLine = contentLines.find(l => l.trimStart().startsWith('extends '));
    if (extendsLine) {
      const parentPath = extendsLine.trimStart().slice(8).trim();
      const parentSource = resolveTemplate(parentPath, templates);
      if (parentSource) {
        // Collect child blocks.
        const childBlocks = {};
        let blockName = null, blockLines = [], blockIndent = 0;
        for (const line of contentLines) {
          const content = line.trimStart();
          const indent = line.length - content.length;
          if (content.startsWith('extends ')) continue;
          if (content.startsWith('block ')) {
            if (blockName) childBlocks[blockName] = blockLines;
            blockName = content.slice(6).trim();
            blockLines = [];
            blockIndent = indent;
            continue;
          }
          if (blockName) {
            if (line.trim() === '' || indent > blockIndent) {
              blockLines.push(line);
            } else {
              childBlocks[blockName] = blockLines;
              blockName = null;
              blockLines = [];
            }
          }
        }
        if (blockName) childBlocks[blockName] = blockLines;

        // Replace blocks in parent.
        const parentLines = parentSource.split('\n');
        finalLines = mergeBlocks(parentLines, childBlocks);
      }
    }

    // Expand includes, mixin calls, and control flow, then render.
    const expanded = expandControlFlow(finalLines, data, mixins, resolvedPrefix, templates);
    return renderLines(expanded, resolvedPrefix, tokenPrefix, allProps, data);
  }

  function resolveTemplate(path, templates) {
    if (templates[path]) return templates[path];
    // Try with .hdml extension.
    if (templates[path + '.hdml']) return templates[path + '.hdml'];
    return null;
  }

  function mergeBlocks(parentLines, childBlocks) {
    const result = [];
    let i = 0;
    while (i < parentLines.length) {
      const content = parentLines[i].trimStart();
      const indent = parentLines[i].length - content.length;
      if (content.startsWith('block ')) {
        const name = content.slice(6).trim();
        if (childBlocks[name]) {
          result.push(...childBlocks[name]);
        }
        // Skip parent block's default children.
        i++;
        while (i < parentLines.length) {
          const ci = parentLines[i].trimStart();
          const cIndent = parentLines[i].length - ci.length;
          if (parentLines[i].trim() === '' || cIndent > indent) { i++; }
          else break;
        }
        continue;
      }
      result.push(parentLines[i]);
      i++;
    }
    return result;
  }

  function discoverTemplates() {
    const templates = {};
    if (typeof document === 'undefined') return templates;
    document.querySelectorAll('script[type="text/hdml"]').forEach(script => {
      const id = script.id || script.getAttribute('data-path') || '';
      if (id) templates[id] = script.textContent;
    });
    return templates;
  }

  // ── Control flow expansion ────────────────────────────────────

  function expandControlFlow(lines, data, mixins, prefix, templates) {
    templates = templates || {};
    const result = [];
    let i = 0;

    while (i < lines.length) {
      const raw = lines[i];
      const content = raw.trimStart();
      const indent = raw.length - raw.trimStart().length;

      if (content === 'doctype html') { result.push(raw); i++; continue; }
      if (content.startsWith('extends ')) { i++; continue; }

      // include path — inline the template.
      if (content.startsWith('include ')) {
        const path = content.slice(8).trim();
        const tmplSource = resolveTemplate(path, templates);
        if (tmplSource) {
          // Indent included content to match the include line's indent.
          const padding = ' '.repeat(indent);
          const includedLines = tmplSource.split('\n').map(l => l.trim() ? padding + l : l);
          result.push(...expandControlFlow(includedLines, data, mixins, prefix, templates));
        }
        i++;
        continue;
      }

      // if condition.
      if (content.startsWith('if ')) {
        const condition = content.slice(3).trim();
        const body = collectBlock(lines, i + 1, indent);
        i += 1 + body.length;

        // Check for else.
        let elseBody = [];
        if (i < lines.length && lines[i].trimStart() === 'else') {
          elseBody = collectBlock(lines, i + 1, indent);
          i += 1 + elseBody.length;
        }

        if (evalCondition(condition, data)) {
          result.push(...expandControlFlow(body, data, mixins, prefix, templates));
        } else {
          result.push(...expandControlFlow(elseBody, data, mixins, prefix, templates));
        }
        continue;
      }

      // each item in collection.
      if (content.startsWith('each ')) {
        const match = content.match(/^each\s+(\w+)(?:\s*,\s*(\w+))?\s+in\s+(.+)$/);
        if (match) {
          const [, itemName, indexName, collPath] = match;
          const collection = resolvePath(data, collPath.trim());
          const body = collectBlock(lines, i + 1, indent);
          i += 1 + body.length;

          if (Array.isArray(collection)) {
            for (let ci = 0; ci < collection.length; ci++) {
              const scopedData = { ...data, [itemName]: collection[ci] };
              if (indexName) scopedData[indexName] = ci;
              result.push(...expandControlFlow(body, scopedData, mixins, prefix, templates));
            }
          }
          continue;
        }
      }

      // +mixin call.
      if (content.startsWith('+')) {
        const rest = content.slice(1);
        const parenIdx = rest.indexOf('(');
        let name, args = [];
        if (parenIdx !== -1) {
          name = rest.slice(0, parenIdx);
          const argsStr = rest.slice(parenIdx + 1, rest.lastIndexOf(')'));
          args = argsStr.match(/"[^"]*"|[^,]+/g)?.map(s => s.trim().replace(/^"|"$/g, '')) || [];
        } else {
          name = rest.split(/\s/)[0];
        }

        const mixin = mixins[name];
        if (mixin) {
          // Bind args to params.
          const scopedData = { ...data };
          mixin.params.forEach((p, pi) => { scopedData[p] = args[pi] || ''; });

          // Caller's block children.
          const callerBlock = collectBlock(lines, i + 1, indent);
          i += 1 + callerBlock.length;

          // Expand mixin body with substitution.
          const bodyLines = mixin.body.split('\n');
          const expanded = expandControlFlow(bodyLines, scopedData, mixins, prefix, templates);
          // TODO: substitute `block` placeholder with caller children.
          result.push(...expanded);
        } else {
          i++;
        }
        continue;
      }

      // Regular line — interpolate text.
      result.push(interpolateLine(raw, data));
      i++;
    }
    return result;
  }

  function collectBlock(lines, start, parentIndent) {
    const block = [];
    let i = start;
    while (i < lines.length) {
      const raw = lines[i];
      if (raw.trim() === '') { block.push(raw); i++; continue; }
      const indent = raw.length - raw.trimStart().length;
      if (indent <= parentIndent) break;
      block.push(raw);
      i++;
    }
    return block;
  }

  function interpolateLine(raw, data) {
    // Interpolate #{} and !{} in the text portion (after tag/attrs).
    return raw.replace(/#\{(.*?)\}/g, (_, expr) => {
      const val = resolvePath(data, expr.trim());
      return val == null ? '' : escapeHtml(String(val));
    }).replace(/!\{(.*?)\}/g, (_, expr) => {
      const val = resolvePath(data, expr.trim());
      return val == null ? '' : String(val);
    });
  }

  // ── DOM rendering ─────────────────────────────────────────────

  function renderLines(lines, prefix, tokenPrefix, props, data) {
    const frag = document.createDocumentFragment();
    const stack = [{ el: frag, indent: -1 }];

    for (const raw of lines) {
      const trimmed = raw.trimEnd();
      if (!trimmed) continue;

      let indent = 0;
      for (let j = 0; j < raw.length; j++) {
        if (raw[j] === ' ') indent++;
        else if (raw[j] === '\t') indent = (indent + 2) & ~1;
        else break;
      }

      const content = trimmed.trimStart();

      if (content.startsWith('@prefix ') || content.startsWith('@prop ')) continue;
      if (content === 'doctype html') continue;
      if (content.startsWith('//-')) continue;

      if (content.startsWith('// ') || content === '//') {
        const text = content.slice(2).trim();
        findParent(stack, indent).appendChild(document.createComment(' ' + text + ' '));
        continue;
      }

      if (content.startsWith('| ') || content === '|') {
        const text = content.slice(1).trimStart();
        const node = document.createTextNode(text + '\n');
        findParent(stack, indent).appendChild(node);
        continue;
      }

      const parsed = parseLine(content, prefix);
      if (!parsed) continue;

      const el = document.createElement(parsed.tag);
      if (parsed.id) el.id = parsed.id;
      if (parsed.classes.length) el.className = parsed.classes.join(' ');

      const styleParts = [];
      for (const attr of parsed.attrs) {
        if (attr.name.startsWith('on-')) {
          const event = attr.name.slice(3);
          el.setAttribute('data-on-' + event, attr.value || '');
          if (attr.value && typeof window !== 'undefined' && typeof window[attr.value] === 'function') {
            el.addEventListener(event, window[attr.value]);
          }
          continue;
        }
        if (attr.name.startsWith('$')) {
          let shorthand = attr.name.slice(1);
          let isRaw = false;
          if (shorthand.endsWith('!')) { shorthand = shorthand.slice(0, -1); isRaw = true; }
          if (AXIS_PROPS[shorthand]) {
            for (const cssProp of AXIS_PROPS[shorthand]) {
              styleParts.push(isRaw ? `${cssProp}: ${attr.value}` : `${cssProp}: var(--${tokenPrefix}-${attr.value})`);
            }
            continue;
          }
          const cssProp = props[shorthand] || shorthand;
          styleParts.push(isRaw ? `${cssProp}: ${attr.value}` : `${cssProp}: var(--${tokenPrefix}-${attr.value})`);
          continue;
        }
        if (attr.name === 'style') { styleParts.push(attr.value); continue; }
        if (attr.value !== null) el.setAttribute(attr.name, attr.value);
        else el.setAttribute(attr.name, '');
      }
      if (styleParts.length) el.setAttribute('style', styleParts.join('; '));

      // Handle inline text with #[inline tags].
      if (parsed.text) {
        const processed = processInlineText(parsed.text, data);
        if (processed.includes('<')) {
          // Contains HTML from inline tags — use innerHTML for this text.
          const span = document.createElement('span');
          span.innerHTML = processed;
          while (span.firstChild) el.appendChild(span.firstChild);
        } else {
          el.appendChild(document.createTextNode(processed));
        }
      }

      findParent(stack, indent).appendChild(el);

      if (!VOID.has(parsed.tag) && !parsed.selfClose) {
        while (stack.length > 1 && stack[stack.length - 1].indent >= indent) stack.pop();
        stack.push({ el, indent });
      }
    }
    return frag;
  }

  function findParent(stack, indent) {
    while (stack.length > 1 && stack[stack.length - 1].indent >= indent) stack.pop();
    return stack[stack.length - 1].el;
  }

  // ── Line parser ───────────────────────────────────────────────

  function parseLine(content, prefix) {
    let pos = 0;
    let tag = '', id = null, classes = [], attrs = [], text = '', selfClose = false;

    if (content[0] === '@') {
      pos = 1;
      const name = scanIdent(content, pos);
      pos += name.length;
      tag = prefix ? prefix + '-' + name : name;
    } else if (content[0] === '#' || content[0] === '.') {
      tag = 'div';
    } else {
      tag = scanIdent(content, pos);
      pos += tag.length;
      if (!tag) return null;
    }

    while (pos < content.length) {
      if (content[pos] === '#') { pos++; const n = scanIdent(content, pos); id = n; pos += n.length; }
      else if (content[pos] === '.') { pos++; const n = scanIdent(content, pos); if (n) classes.push(n); pos += n.length; }
      else break;
    }

    if (content[pos] === '(') {
      pos++;
      while (pos < content.length && content[pos] !== ')') {
        while (pos < content.length && /\s/.test(content[pos])) pos++;
        if (content[pos] === ')') break;
        let nameStart = pos;
        if (content[pos] === '$') pos++;
        while (pos < content.length && /[a-zA-Z0-9\-_]/.test(content[pos])) pos++;
        if (content[pos] === '!') pos++;
        const name = content.slice(nameStart, pos);
        while (pos < content.length && content[pos] === ' ') pos++;
        if (content[pos] === '=') {
          pos++;
          while (pos < content.length && content[pos] === ' ') pos++;
          if (content[pos] === '"') {
            pos++;
            const vs = pos;
            while (pos < content.length && content[pos] !== '"') { if (content[pos] === '\\') pos++; pos++; }
            attrs.push({ name, value: content.slice(vs, pos) });
            pos++;
          } else attrs.push({ name, value: null });
        } else attrs.push({ name, value: null });
      }
      if (content[pos] === ')') pos++;
    }

    if (content[pos] === '/') { selfClose = true; pos++; }
    if (content[pos] === ' ') text = content.slice(pos + 1);

    return { tag, id, classes, attrs, text, selfClose };
  }

  function scanIdent(s, pos) {
    let end = pos;
    while (end < s.length && /[a-zA-Z0-9\-_]/.test(s[end])) end++;
    return s.slice(pos, end);
  }

  // ── Public API ────────────────────────────────────────────────

  function render(source, target, opts = {}) {
    target.innerHTML = '';
    target.appendChild(parse(source, opts));
  }

  function mount(source, selector, opts = {}) {
    const target = document.querySelector(selector);
    if (target) render(source, target, opts);
  }

  return { parse, render, mount };
})();

if (typeof module !== 'undefined') module.exports = hdml;
