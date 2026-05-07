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

  // ── Error model ──────────────────────────────────────────────

  class HdmlError extends Error {
    constructor(code, stage, message, { line = null, details = null } = {}) {
      super(message);
      this.name = 'HdmlError';
      this.code = code;
      this.stage = stage;
      this.line = line;
      this.details = details;
    }
  }

  const E = {
    UNCLOSED_ATTR:       'UNCLOSED_ATTR',
    BAD_INDENT:          'BAD_INDENT',
    CIRCULAR_INCLUDE:    'CIRCULAR_INCLUDE',
    CIRCULAR_EXTENDS:    'CIRCULAR_EXTENDS',
    UNDEFINED_MIXIN:     'UNDEFINED_MIXIN',
    RECURSIVE_MIXIN:     'RECURSIVE_MIXIN',
    MISSING_PREFIX:      'MISSING_PREFIX',
    INVALID_DOCTYPE:     'INVALID_DOCTYPE',
    MISPLACED_DIRECTIVE: 'MISPLACED_DIRECTIVE',
    INVALID_HANDLER:     'INVALID_HANDLER',
  };

  function hdmlError(code, stage, message, opts) {
    return new HdmlError(code, stage, message, opts);
  }

  // ── Constants ───────────────────────────────────────────────

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

  // ── Tokenizer ────────────────────────────────────────────────
  //
  // INDENT/DEDENT tokenizer matching Rust's lexer.rs. Produces a flat
  // token array that the parser consumes. Handles multiline attributes
  // (newlines inside parens) and tab normalization.

  const T = {
    Indent: 'Indent', Dedent: 'Dedent', Newline: 'Newline',
    Tag: 'Tag', Text: 'Text',
    AttrOpen: 'AttrOpen', AttrClose: 'AttrClose',
    AttrName: 'AttrName', AttrEquals: 'AttrEquals', AttrValue: 'AttrValue',
    Doctype: 'Doctype', SelfClose: 'SelfClose',
    Id: 'Id', Class: 'Class',
    CommentKeep: 'CommentKeep', CommentStrip: 'CommentStrip',
    PipeText: 'PipeText', RawBlock: 'RawBlock',
    Prefix: 'Prefix', Prop: 'Prop', ComponentTag: 'ComponentTag',
    Extends: 'Extends', Include: 'Include', BlockDef: 'BlockDef',
    MixinDef: 'MixinDef', MixinParams: 'MixinParams',
    MixinCall: 'MixinCall', MixinArgs: 'MixinArgs',
    If: 'If', Else: 'Else', Each: 'Each',
    Eof: 'Eof',
  };

  function tokenize(source) {
    const input = source;
    const len = input.length;
    let pos = 0;
    let line = 1;
    const indentStack = [0];
    const tokens = [];

    while (pos < len) {
      scanLine();
    }

    // Close remaining indent levels.
    while (indentStack.length > 1) {
      indentStack.pop();
      tokens.push({ kind: T.Dedent, line });
    }
    tokens.push({ kind: T.Eof, line });
    return tokens;

    // ── Line scanning ───────────────────────────────────────

    function scanLine() {
      const lineStart = pos;
      let indent = 0;
      while (pos < len) {
        if (input[pos] === ' ') { indent++; pos++; }
        else if (input[pos] === '\t') { indent = (indent + 2) & ~1; pos++; }
        else break;
      }

      // Blank line — skip.
      if (pos >= len || input[pos] === '\n' || input[pos] === '\r') {
        skipNewline();
        return;
      }

      // Emit INDENT/DEDENT/NEWLINE.
      const currentIndent = indentStack[indentStack.length - 1];
      if (indent > currentIndent) {
        indentStack.push(indent);
        tokens.push({ kind: T.Indent, line });
      } else if (indent < currentIndent) {
        while (indentStack.length > 1 && indentStack[indentStack.length - 1] > indent) {
          indentStack.pop();
          tokens.push({ kind: T.Dedent, line });
        }
        if (tokens.length) tokens.push({ kind: T.Newline, line });
      } else {
        if (tokens.length) tokens.push({ kind: T.Newline, line });
      }

      scanLineContent();
      skipNewline();
    }

    function scanLineContent() {
      const rest = remaining();

      // Stripped comment.
      if (rest.startsWith('//- ') || rest === '//-') {
        const start = pos;
        pos += 3; skipSpaces();
        tokens.push({ kind: T.CommentStrip, value: consumeToEol(), line });
        return;
      }
      // Kept comment.
      if (rest.startsWith('// ') || rest === '//') {
        pos += 2; skipSpaces();
        tokens.push({ kind: T.CommentKeep, value: consumeToEol(), line });
        return;
      }
      // Pipe text.
      if (rest.startsWith('| ') || rest === '|') {
        pos += 1; if (pos < len && input[pos] === ' ') pos++;
        tokens.push({ kind: T.PipeText, value: consumeToEol(), line });
        return;
      }
      // Raw block.
      if (rest.trimEnd() === 'raw') {
        consumeToEol(); skipNewline();
        const bodyIndent = indentStack[indentStack.length - 1] + 2;
        tokens.push({ kind: T.RawBlock, value: consumeRawBlock(bodyIndent), line });
        return;
      }
      // extends.
      if (rest.startsWith('extends ')) {
        pos += 8; skipSpaces();
        tokens.push({ kind: T.Extends, value: consumeToEol().trim(), line });
        return;
      }
      // include.
      if (rest.startsWith('include ')) {
        pos += 8; skipSpaces();
        tokens.push({ kind: T.Include, value: consumeToEol().trim(), line });
        return;
      }
      // block.
      if (rest.startsWith('block ')) {
        pos += 6; skipSpaces();
        tokens.push({ kind: T.BlockDef, value: consumeToEol().trim(), line });
        return;
      }
      // mixin definition.
      if (rest.startsWith('mixin ')) {
        pos += 6; skipSpaces();
        const name = scanIdent();
        const params = (pos < len && input[pos] === '(') ? scanMixinParams() : [];
        tokens.push({ kind: T.MixinDef, value: name, line });
        if (params.length) tokens.push({ kind: T.MixinParams, value: params, line });
        return;
      }
      // mixin call.
      if (pos < len && input[pos] === '+') {
        pos++;
        const name = scanIdent();
        if (name) {
          const args = (pos < len && input[pos] === '(') ? scanMixinArgs() : [];
          tokens.push({ kind: T.MixinCall, value: name, line });
          if (args.length) tokens.push({ kind: T.MixinArgs, value: args, line });
          return;
        }
      }
      // if.
      if (rest.startsWith('if ')) {
        pos += 3; skipSpaces();
        tokens.push({ kind: T.If, value: consumeToEol().trim(), line });
        return;
      }
      // else.
      if (rest.trimEnd() === 'else') {
        pos += 4;
        tokens.push({ kind: T.Else, line });
        return;
      }
      // each.
      if (rest.startsWith('each ')) {
        pos += 5; skipSpaces();
        const eachRest = consumeToEol();
        const m = eachRest.match(/^(\w+)(?:\s*,\s*(\w+))?\s+in\s+(.+)$/);
        if (m) {
          tokens.push({ kind: T.Each, item: m[1], index: m[2] || null, collection: m[3].trim(), line });
        }
        return;
      }
      // doctype.
      if (rest.startsWith('doctype ')) {
        pos += 8; skipSpaces();
        tokens.push({ kind: T.Doctype, value: consumeToEol().trim(), line });
        return;
      }
      // @prefix directive.
      if (rest.startsWith('@prefix ')) {
        pos += 8; skipSpaces();
        tokens.push({ kind: T.Prefix, value: consumeToEol().trim(), line });
        return;
      }
      // @prop directive.
      if (rest.startsWith('@prop ')) {
        pos += 6; skipSpaces();
        const propRest = consumeToEol();
        const eq = propRest.indexOf('=');
        if (eq !== -1) {
          tokens.push({ kind: T.Prop, shorthand: propRest.slice(0, eq).trim(), property: propRest.slice(eq + 1).trim(), line });
        }
        return;
      }
      // @component tag.
      if (pos < len && input[pos] === '@') {
        const start = pos;
        pos++; // skip @
        const name = scanIdent();
        if (name) {
          tokens.push({ kind: T.ComponentTag, value: name, line });
          scanShorthand();
          if (pos < len && input[pos] === '(') scanAttrs();
          if (pos < len && input[pos] === '/') { tokens.push({ kind: T.SelfClose, line }); pos++; }
          scanInlineTextTail();
          return;
        }
      }

      // Tag or implicit div.
      scanTagLine();
    }

    function scanTagLine() {
      // Implicit div: starts with # or .
      if (pos < len && (input[pos] === '#' || input[pos] === '.')) {
        // No tag token — shorthand scanner handles it.
      } else {
        const tag = scanIdent();
        if (tag) tokens.push({ kind: T.Tag, value: tag, line });
      }

      scanShorthand();
      if (pos < len && input[pos] === '(') scanAttrs();
      if (pos < len && input[pos] === '/') { tokens.push({ kind: T.SelfClose, line }); pos++; }
      scanInlineTextTail();
    }

    function scanInlineTextTail() {
      if (pos < len && input[pos] === ' ') pos++;

      // != value (raw insertion).
      if (pos + 1 < len && input[pos] === '!' && input[pos + 1] === '=') {
        pos += 2; skipSpaces();
        const expr = consumeToEol().trim();
        if (expr) tokens.push({ kind: T.Text, value: `!{${expr}}`, line });
        return;
      }
      // = value (escaped insertion).
      if (pos < len && input[pos] === '=') {
        pos++; skipSpaces();
        const expr = consumeToEol().trim();
        if (expr) tokens.push({ kind: T.Text, value: `#{${expr}}`, line });
        return;
      }
      // Remaining text.
      if (pos < len && input[pos] !== '\n' && input[pos] !== '\r') {
        const text = consumeToEol();
        if (text) tokens.push({ kind: T.Text, value: text, line });
      }
    }

    function scanShorthand() {
      while (pos < len) {
        if (input[pos] === '#') {
          pos++;
          const name = scanIdent();
          if (name) tokens.push({ kind: T.Id, value: name, line });
        } else if (input[pos] === '.') {
          pos++;
          const name = scanIdent();
          if (name) tokens.push({ kind: T.Class, value: name, line });
        } else break;
      }
    }

    function scanAttrs() {
      tokens.push({ kind: T.AttrOpen, line });
      pos++; // skip (

      while (true) {
        skipAttrWhitespace();
        if (pos >= len) {
          throw hdmlError(E.UNCLOSED_ATTR, 'lex', `line ${line}: unclosed attribute list`, { line });
          break;
        }
        if (input[pos] === ')') {
          tokens.push({ kind: T.AttrClose, line });
          pos++;
          break;
        }

        // Attribute name (may start with $ for tokens).
        const nameStart = pos;
        if (pos < len && input[pos] === '$') pos++;
        scanIdent();
        // $prop!= raw token — include trailing !
        if (pos < len && input[pos] === '!') pos++;
        const name = input.slice(nameStart, pos);
        if (!name) { pos++; continue; }

        tokens.push({ kind: T.AttrName, value: name, line });

        // Check for = value.
        skipAttrWhitespace();
        if (pos < len && input[pos] === '=') {
          tokens.push({ kind: T.AttrEquals, line });
          pos++;
          skipAttrWhitespace();

          if (pos < len && input[pos] === '"') {
            // Quoted value.
            pos++;
            const vs = pos;
            while (pos < len && input[pos] !== '"') {
              if (input[pos] === '\\' && pos + 1 < len) pos++;
              pos++;
            }
            tokens.push({ kind: T.AttrValue, value: input.slice(vs, pos), line });
            if (pos < len) pos++; // skip closing "
          } else if (pos < len && input[pos] === '(') {
            // S-expression value.
            const vs = pos;
            let depth = 0;
            while (pos < len) {
              if (input[pos] === '(') depth++;
              else if (input[pos] === ')') { depth--; pos++; if (depth === 0) break; continue; }
              pos++;
            }
            tokens.push({ kind: T.AttrValue, value: input.slice(vs, pos).trim(), line });
          } else if (pos < len) {
            // Unquoted value (variable path) → wrap in #{}.
            const vs = pos;
            while (pos < len && input[pos] !== ')' && input[pos] !== ' ' && input[pos] !== '\t') pos++;
            const expr = input.slice(vs, pos).trim();
            tokens.push({ kind: T.AttrValue, value: `#{${expr}}`, line });
          }
        }
        // Otherwise boolean attribute (name only).
      }
    }

    function skipAttrWhitespace() {
      while (pos < len) {
        if (input[pos] === ' ' || input[pos] === '\t') pos++;
        else if (input[pos] === '\n') { pos++; line++; }
        else if (input[pos] === '\r') { pos++; if (pos < len && input[pos] === '\n') pos++; line++; }
        else break;
      }
    }

    function scanMixinParams() {
      const params = [];
      pos++; // skip (
      while (true) {
        skipSpaces();
        if (pos >= len || input[pos] === ')') { if (pos < len) pos++; break; }
        if (input[pos] === ',') { pos++; continue; }
        const name = scanIdent();
        if (name) params.push(name);
        else pos++;
      }
      return params;
    }

    function scanMixinArgs() {
      const args = [];
      pos++; // skip (
      while (true) {
        skipSpaces();
        if (pos >= len || input[pos] === ')') { if (pos < len) pos++; break; }
        if (input[pos] === ',') { pos++; continue; }
        if (input[pos] === '"') {
          pos++;
          const start = pos;
          while (pos < len && input[pos] !== '"') pos++;
          args.push(input.slice(start, pos));
          if (pos < len) pos++;
        } else {
          const arg = scanIdent();
          if (arg) args.push(arg);
          else pos++;
        }
      }
      return args;
    }

    // ── Primitives ──────────────────────────────────────────

    function scanIdent() {
      const start = pos;
      while (pos < len && /[a-zA-Z0-9\-_]/.test(input[pos])) pos++;
      return input.slice(start, pos);
    }

    function skipSpaces() {
      while (pos < len && input[pos] === ' ') pos++;
    }

    function consumeToEol() {
      const start = pos;
      while (pos < len && input[pos] !== '\n' && input[pos] !== '\r') pos++;
      return input.slice(start, pos);
    }

    function consumeRawBlock(bodyIndent) {
      let out = '';
      while (pos < len) {
        const lineStart = pos;
        let probe = pos, probeIndent = 0;
        while (probe < len) {
          if (input[probe] === ' ') { probeIndent++; probe++; }
          else if (input[probe] === '\t') { probeIndent = (probeIndent + 2) & ~1; probe++; }
          else break;
        }
        if (probe >= len || input[probe] === '\n' || input[probe] === '\r') {
          pos = probe; out += '\n'; skipNewline(); continue;
        }
        if (probeIndent < bodyIndent) { pos = lineStart; break; }
        // Strip body indent prefix.
        pos = lineStart;
        let consumed = 0;
        while (pos < len && consumed < bodyIndent) {
          if (input[pos] === ' ') { consumed++; pos++; }
          else if (input[pos] === '\t') { consumed = (consumed + 2) & ~1; pos++; }
          else break;
        }
        out += consumeToEol();
        if (pos < len) { out += '\n'; skipNewline(); }
      }
      if (out.endsWith('\n')) out = out.slice(0, -1);
      return out;
    }

    function remaining() {
      let end = pos;
      while (end < len && input[end] !== '\n' && input[end] !== '\r') end++;
      return input.slice(pos, end);
    }

    function skipNewline() {
      if (pos < len) {
        if (input[pos] === '\r') { pos++; if (pos < len && input[pos] === '\n') pos++; }
        else if (input[pos] === '\n') pos++;
      }
      line++;
    }
  }

  // ── AST Parser ──────────────────────────────────────────────
  //
  // Recursive descent parser over tokens. Produces an HdmlDocument
  // matching Rust's ast.rs node structure.

  function parseTokens(tokens) {
    let pos = 0;
    const seenIds = [];

    const prefix = parsePrefixDirective();
    const props = parsePropDirectives();
    const ext = parseExtendsDirective();
    const nodes = parseNodes();

    return { prefix, props, extends: ext, nodes };

    function peek() {
      return pos < tokens.length ? tokens[pos] : { kind: T.Eof };
    }

    function advance() {
      return tokens[pos++];
    }

    function eat(kind) {
      if (peek().kind === kind) { advance(); return true; }
      return false;
    }

    function atEof() { return peek().kind === T.Eof; }

    function parsePrefixDirective() {
      while (eat(T.Newline)) {}
      if (peek().kind === T.Prefix) return advance().value;
      return null;
    }

    function parsePropDirectives() {
      const result = [];
      while (true) {
        while (eat(T.Newline)) {}
        if (peek().kind === T.Prop) {
          const tok = advance();
          result.push([tok.shorthand, tok.property]);
        } else break;
      }
      return result;
    }

    function parseExtendsDirective() {
      while (eat(T.Newline)) {}
      if (peek().kind === T.Extends) return advance().value;
      return null;
    }

    function parseNodes() {
      const nodes = [];
      while (true) {
        while (eat(T.Newline)) {}
        if (atEof() || peek().kind === T.Dedent) break;
        const node = parseNode();
        if (node) nodes.push(node);
      }
      return nodes;
    }

    function parseNode() {
      const tok = peek();
      switch (tok.kind) {
        case T.Doctype: return parseDoctype();
        case T.Tag: return parseElement();
        case T.ComponentTag: return parseComponentElement();
        case T.Id: case T.Class: return parseImplicitDiv();
        case T.CommentKeep: return parseComment();
        case T.CommentStrip: return parseStrippedComment();
        case T.PipeText: return parsePipeText();
        case T.RawBlock: return parseRawBlock();
        case T.Text: return parseText();
        case T.Include: return parseInclude();
        case T.BlockDef: return parseBlockDef();
        case T.MixinDef: return parseMixinDef();
        case T.MixinCall: return parseMixinCall();
        case T.If: return parseIf();
        case T.Each: return parseEach();
        case T.Prefix: case T.Prop: case T.Extends:
          throw hdmlError(E.MISPLACED_DIRECTIVE, 'parse',
            'directives must appear before content', { line: tok.line });
        default:
          advance(); // skip unexpected
          return null;
      }
    }

    function parseDoctype() {
      const tok = advance();
      if (tok.value !== 'html') {
        throw hdmlError(E.INVALID_DOCTYPE, 'parse',
          `doctype must be exactly "html", got "${tok.value}"`, { line: tok.line });
      }
      return { type: 'Doctype', line: tok.line };
    }

    function parseElement() {
      const tagTok = advance();
      const tag = tagTok.value;
      const { id, classes } = parseShorthand();
      if (id) checkDuplicateId(id, tagTok.line);
      const attrs = parseAttrs();
      const selfClosing = eat(T.SelfClose);
      const inlineText = peek().kind === T.Text ? advance().value : null;
      const children = parseChildren();
      return { type: 'Element', tag, id, classes, attrs, selfClosing, inlineText, children, line: tagTok.line };
    }

    function parseComponentElement() {
      const tok = advance();
      const { id, classes } = parseShorthand();
      if (id) checkDuplicateId(id, tok.line);
      const attrs = parseAttrs();
      const selfClosing = eat(T.SelfClose);
      const inlineText = peek().kind === T.Text ? advance().value : null;
      const children = parseChildren();
      return { type: 'Element', tag: null, componentName: tok.value, id, classes, attrs, selfClosing, inlineText, children, line: tok.line };
    }

    function parseImplicitDiv() {
      const lineno = peek().line;
      const { id, classes } = parseShorthand();
      if (id) checkDuplicateId(id, lineno);
      const attrs = parseAttrs();
      const selfClosing = eat(T.SelfClose);
      const inlineText = peek().kind === T.Text ? advance().value : null;
      const children = parseChildren();
      return { type: 'Element', tag: 'div', id, classes, attrs, selfClosing, inlineText, children, line: lineno };
    }

    function parseShorthand() {
      let id = null;
      const classes = [];
      while (true) {
        if (peek().kind === T.Id) { id = advance().value; }
        else if (peek().kind === T.Class) { classes.push(advance().value); }
        else break;
      }
      return { id, classes };
    }

    function parseAttrs() {
      if (!eat(T.AttrOpen)) return [];
      const attrs = [];
      const seen = new Set();
      while (true) {
        const k = peek().kind;
        if (k === T.AttrClose || k === T.Eof) { eat(T.AttrClose); break; }
        if (k === T.AttrName) {
          const nameTok = advance();
          const name = nameTok.value;
          let value = null;
          if (eat(T.AttrEquals)) {
            if (peek().kind === T.AttrValue) value = advance().value;
          }
          if (seen.has(name)) {
            // Diagnostic: duplicate attribute (non-fatal, matches Rust).
          }
          seen.add(name);
          attrs.push(classifyAttribute(name, value, nameTok.line));
        } else {
          advance(); // skip unexpected
        }
      }
      return attrs;
    }

    function classifyAttribute(name, value, lineno) {
      // Event: on-*
      if (name.startsWith('on-')) {
        const event = name.slice(3);
        const handler = value || '';
        if (handler && !/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(handler)) {
          throw hdmlError(E.INVALID_HANDLER, 'parse',
            `on-${event} must be a function name, got "${handler}"`, { line: lineno });
        }
        return { type: 'Event', event, handler };
      }
      // Token: $*
      if (name.startsWith('$')) {
        let shorthand = name.slice(1);
        let raw = false;
        if (shorthand.endsWith('!')) { shorthand = shorthand.slice(0, -1); raw = true; }
        return { type: 'Token', shorthand, value: value || '', raw };
      }
      // Standard
      return { type: 'Standard', name, value };
    }

    function parseChildren() {
      if (!eat(T.Indent)) return [];
      const nodes = parseNodes();
      eat(T.Dedent);
      return nodes;
    }

    function parseComment() {
      const tok = advance();
      return { type: 'Comment', value: tok.value, line: tok.line };
    }

    function parseStrippedComment() {
      advance();
      parseChildren(); // consume indented children
      return null;
    }

    function parsePipeText() {
      const tok = advance();
      return { type: 'Text', content: tok.value, line: tok.line };
    }

    function parseText() {
      const tok = advance();
      return { type: 'Text', content: tok.value, line: tok.line };
    }

    function parseRawBlock() {
      const tok = advance();
      return { type: 'Raw', content: tok.value, line: tok.line };
    }

    function parseInclude() {
      const tok = advance();
      return { type: 'Include', path: tok.value, line: tok.line };
    }

    function parseBlockDef() {
      const tok = advance();
      const children = parseChildren();
      return { type: 'Block', name: tok.value, children, line: tok.line };
    }

    function parseMixinDef() {
      const tok = advance();
      const params = peek().kind === T.MixinParams ? advance().value : [];
      const children = parseChildren();
      return { type: 'MixinDef', name: tok.value, params, children, line: tok.line };
    }

    function parseMixinCall() {
      const tok = advance();
      const args = peek().kind === T.MixinArgs ? advance().value : [];
      const children = parseChildren();
      return { type: 'MixinCall', name: tok.value, args, children, line: tok.line };
    }

    function parseIf() {
      const tok = advance();
      const ifChildren = parseChildren();

      // Check for else branch.
      let elseChildren = [];
      if (peek().kind === T.Newline) {
        const saved = pos;
        advance();
        if (peek().kind === T.Else) {
          advance();
          elseChildren = parseChildren();
        } else {
          pos = saved; // backtrack
        }
      } else if (peek().kind === T.Else) {
        advance();
        elseChildren = parseChildren();
      }

      return { type: 'If', condition: tok.value, ifChildren, elseChildren, line: tok.line };
    }

    function parseEach() {
      const tok = advance();
      const children = parseChildren();
      return { type: 'Each', item: tok.item, index: tok.index, collection: tok.collection, children, line: tok.line };
    }

    function checkDuplicateId(id, lineno) {
      if (seenIds.includes(id)) {
        // Non-fatal diagnostic, matches Rust behavior.
      }
      seenIds.push(id);
    }
  }

  // ── Template Resolution ────────────────────────────────────────
  //
  // Resolves include, extends/block, and mixin nodes over the AST.
  // Matches Rust's template.rs. Caller provides template map.

  const MAX_MIXIN_DEPTH = 100;

  function resolveTemplates(doc, templates, currentPath) {
    templates = templates || {};
    // Step 1-2: mixin collection and expansion.
    resolveMixins(doc);
    // Step 3: include resolution.
    const seen = new Set();
    if (currentPath) seen.add(currentPath);
    resolveIncludes(doc.nodes, templates, currentPath || '', seen, doc.prefix);
    // Step 4: extends/block inheritance.
    if (doc.extends) {
      const extSeen = new Set();
      if (currentPath) extSeen.add(currentPath);
      resolveExtends(doc, doc.extends, templates, currentPath || '', extSeen);
      resolveMixins(doc);
      resolveIncludes(doc.nodes, templates, currentPath || '', seen, doc.prefix);
    }
  }

  function resolveMixins(doc) {
    const mixins = collectMixinDefs(doc.nodes);
    expandMixinCalls(doc.nodes, mixins, 0);
    // Write back since collectMixinDefs drains.
  }

  function collectMixinDefs(nodes) {
    const mixins = {};
    const retained = [];
    for (const node of nodes) {
      if (node.type === 'MixinDef') {
        mixins[node.name] = { params: node.params, children: node.children };
      } else {
        retained.push(node);
      }
    }
    nodes.length = 0;
    nodes.push(...retained);
    return mixins;
  }

  function expandMixinCalls(nodes, mixins, depth) {
    const expanded = [];
    for (const node of nodes) {
      if (node.type === 'MixinCall') {
        if (depth >= MAX_MIXIN_DEPTH) {
          throw hdmlError(E.RECURSIVE_MIXIN, 'resolve', `recursive mixin call: ${node.name}`, { line: node.line });
        }
        const mixin = mixins[node.name];
        if (!mixin) {
          throw hdmlError(E.UNDEFINED_MIXIN, 'resolve', `undefined mixin: ${node.name}`, { line: node.line });
        }
        const body = cloneNodes(mixin.children);
        const bindings = {};
        mixin.params.forEach((p, i) => { bindings[p] = node.args[i] || ''; });
        substituteParams(body, bindings);
        substituteBlock(body, node.children);
        expandMixinCalls(body, mixins, depth + 1);
        expanded.push(...body);
      } else {
        const children = nodeChildren(node);
        if (children) expandMixinCalls(children, mixins, depth);
        expanded.push(node);
      }
    }
    nodes.length = 0;
    nodes.push(...expanded);
  }

  function substituteParams(nodes, bindings) {
    if (!Object.keys(bindings).length) return;
    for (const node of nodes) {
      if (node.type === 'Element') {
        if (node.inlineText) node.inlineText = substituteText(node.inlineText, bindings);
        for (const attr of node.attrs) {
          if (attr.type === 'Standard' && attr.value != null) {
            attr.value = substituteAttrValue(attr.value, bindings);
          } else if (attr.type === 'Token') {
            attr.value = substituteAttrValue(attr.value, bindings);
          }
        }
        substituteParams(node.children, bindings);
      } else if (node.type === 'Text') {
        node.content = substituteText(node.content, bindings);
      } else {
        const children = nodeChildren(node);
        if (children) substituteParams(children, bindings);
      }
    }
  }

  function substituteText(text, bindings) {
    let result = text;
    for (const [param, value] of Object.entries(bindings)) {
      result = result
        .replace(new RegExp(`#\\{${escapeRegExp(param)}\\}`, 'g'), value)
        .replace(new RegExp(`!\\{${escapeRegExp(param)}\\}`, 'g'), value);
      // Direct param name as whole text (= param pattern from lexer).
      if (result === `#{${param}}`) result = value;
    }
    return result;
  }

  function substituteAttrValue(value, bindings) {
    let result = value;
    for (const [param, replacement] of Object.entries(bindings)) {
      if (result === param || result === `#{${param}}` || result === `!{${param}}`) return replacement;
      result = result
        .replace(new RegExp(`#\\{${escapeRegExp(param)}\\}`, 'g'), replacement)
        .replace(new RegExp(`!\\{${escapeRegExp(param)}\\}`, 'g'), replacement);
    }
    return result;
  }

  function substituteBlock(body, callerChildren) {
    if (!callerChildren.length) return;
    for (let i = 0; i < body.length; i++) {
      if (body[i].type === 'Block' && (body[i].name === 'block' || !body[i].children.length)) {
        body.splice(i, 1, ...cloneNodes(callerChildren));
        return;
      }
      const children = nodeChildren(body[i]);
      if (children) substituteBlock(children, callerChildren);
    }
  }

  function resolveIncludes(nodes, templates, currentPath, seen, prefix) {
    const resolved = [];
    for (const node of nodes) {
      if (node.type === 'Include') {
        if (seen.has(node.path)) {
          throw hdmlError(E.CIRCULAR_INCLUDE, 'resolve', `circular include detected: ${node.path}`, { line: node.line });
        }
        const source = resolveTemplate(node.path, templates);
        if (source) {
          seen.add(node.path);
          const tokens = tokenize(source);
          const included = parseTokens(tokens);
          resolveMixins(included);
          if (included.extends) {
            const extSeen = new Set([node.path]);
            resolveExtends(included, included.extends, templates, node.path, extSeen);
          }
          resolveIncludes(included.nodes, templates, node.path, seen, prefix);
          resolved.push(...included.nodes);
          seen.delete(node.path);
        }
      } else {
        const children = nodeChildren(node);
        if (children) resolveIncludes(children, templates, currentPath, seen, prefix);
        resolved.push(node);
      }
    }
    nodes.length = 0;
    nodes.push(...resolved);
  }

  function resolveExtends(child, parentPath, templates, currentPath, seen) {
    if (seen.has(parentPath)) {
      throw hdmlError(E.CIRCULAR_EXTENDS, 'resolve', `circular extends detected: ${parentPath}`, { line: 0 });
    }
    const source = resolveTemplate(parentPath, templates);
    if (!source) return;

    const tokens = tokenize(source);
    const parent = parseTokens(tokens);
    seen.add(parentPath);

    // Recurse for chained extends.
    if (parent.extends) {
      resolveExtends(parent, parent.extends, templates, parentPath, seen);
    }
    resolveMixins(parent);

    // Collect child block overrides.
    const childPrefix = child.prefix;
    const childProps = child.props.slice();
    const childBlocks = {};
    for (const node of child.nodes) {
      if (node.type === 'Block') childBlocks[node.name] = node.children;
    }

    // Replace parent blocks with child overrides.
    replaceBlocks(parent.nodes, childBlocks);

    // Merge into child.
    child.nodes = parent.nodes;
    child.prefix = childPrefix || parent.prefix;
    child.extends = null;
    // Child props take precedence.
    const merged = childProps.slice();
    for (const [name, value] of parent.props) {
      if (!merged.some(([n]) => n === name)) merged.push([name, value]);
    }
    child.props = merged;
    seen.delete(parentPath);
  }

  function replaceBlocks(nodes, overrides) {
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      if (node.type === 'Block' && overrides[node.name]) {
        node.children = cloneNodes(overrides[node.name]);
        node.name = '';
        continue;
      }
      const children = nodeChildren(node);
      if (children) replaceBlocks(children, overrides);
    }
  }

  function nodeChildren(node) {
    if (node.type === 'Element') return node.children;
    if (node.type === 'Block') return node.children;
    if (node.type === 'MixinDef') return node.children;
    if (node.type === 'MixinCall') return node.children;
    if (node.type === 'If') return node.ifChildren;
    if (node.type === 'Each') return node.children;
    return null;
  }

  function cloneNodes(nodes) {
    return JSON.parse(JSON.stringify(nodes));
  }

  function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  // ── Interpolation ─────────────────────────────────────────────

  function interpolate(text, data, htmlMode = false, allowRaw = true) {
    if (!text) return text;
    return text.replace(/#\{(.*?)\}/g, (_, expr) => {
      const val = resolveValueArg(expr.trim(), data);
      const str = valueToString(val);
      return htmlMode ? escapeHtml(str) : str;
    }).replace(/!\{(.*?)\}/g, (_, expr) => {
      const str = valueToString(resolveValueArg(expr.trim(), data));
      return (htmlMode && !allowRaw) ? escapeHtml(str) : str;
    });
  }

  function resolvePath(data, path) {
    if (!data || !path) return undefined;
    return path.split('.').reduce((obj, key) => {
      if (obj == null) return undefined;
      if (key === 'length' && (Array.isArray(obj) || typeof obj === 'string')) return obj.length;
      if (Array.isArray(obj) && /^\d+$/.test(key)) return obj[Number(key)];
      return obj[key];
    }, data);
  }

  function escapeHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;')
            .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // ── Inline tags: #[tag(attrs) content] ────────────────────────

  function processInlineText(text, data, htmlMode = false, allowRaw = true) {
    let interpolated = interpolate(text, data, htmlMode, allowRaw);
    interpolated = interpolateSExprs(interpolated, data, htmlMode);
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
      const inner = processInlineText(content, data, true);
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
      case 'eq':  { const [a, b] = splitTwo(rest); return resolveValueArg(a, data) === resolveValueArg(b, data); }
      case 'ne':  { const [a, b] = splitTwo(rest); return resolveValueArg(a, data) !== resolveValueArg(b, data); }
      case 'gt':  { const [a, b] = splitTwo(rest); return Number(resolveValueArg(a, data)) > Number(resolveValueArg(b, data)); }
      case 'lt':  { const [a, b] = splitTwo(rest); return Number(resolveValueArg(a, data)) < Number(resolveValueArg(b, data)); }
      case 'gte': { const [a, b] = splitTwo(rest); return Number(resolveValueArg(a, data)) >= Number(resolveValueArg(b, data)); }
      case 'lte': { const [a, b] = splitTwo(rest); return Number(resolveValueArg(a, data)) <= Number(resolveValueArg(b, data)); }
      default: return false;
    }
  }

  function splitTwo(s) {
    s = s.trim();
    // Handle double-quoted first arg.
    if (s[0] === '"') {
      const end = s.indexOf('"', 1);
      return [s.slice(0, end + 1), s.slice(end + 1).trim()];
    }
    // Handle single-quoted first arg (used in inline S-expressions).
    if (s[0] === "'") {
      const end = s.indexOf("'", 1);
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

  // ── Inline S-expression values ──────────────────────────────────

  const SEXPR_HELPERS = new Set([
    'if','eq','ne','gt','lt','gte','lte','and','or','not',
    'len','default','upper','lower','slug','truncate'
  ]);

  function evalSExprValue(expr, data) {
    expr = expr.trim();
    const sp = expr.indexOf(' ');
    if (sp === -1) return '';
    const helper = expr.slice(0, sp);
    const rest = expr.slice(sp + 1).trim();

    if (helper === 'if') {
      const [cond, remainder] = splitTwo(rest);
      const [truthy, falsy] = splitTwo(remainder);
      return evalCondition(cond, data)
        ? resolveStringArg(truthy, data)
        : resolveStringArg(falsy, data);
    }
    if (helper === 'len') return String(valueLength(resolveValueArg(rest, data)));
    if (helper === 'default') {
      const [valueArg, fallbackArg] = splitTwo(rest);
      const value = resolveValueArg(valueArg, data);
      return isTruthy(value) ? valueToString(value) : resolveStringArg(fallbackArg, data);
    }
    if (helper === 'upper') return resolveStringArg(rest, data).toUpperCase();
    if (helper === 'lower') return resolveStringArg(rest, data).toLowerCase();
    if (helper === 'slug') return slugify(resolveStringArg(rest, data));
    if (helper === 'truncate') {
      const [valueArg, lenArg] = splitTwo(rest);
      const max = Math.max(0, Number(resolveValueArg(lenArg, data)) || 0);
      return Array.from(resolveStringArg(valueArg, data)).slice(0, max).join('');
    }
    // Boolean helpers — return string.
    return evalHelper(expr, data) ? 'true' : 'false';
  }

  function resolveValueArg(arg, data) {
    arg = String(arg || '').trim();
    if (!arg) return undefined;
    if ((arg.startsWith("'") && arg.endsWith("'")) || (arg.startsWith('"') && arg.endsWith('"'))) {
      return arg.slice(1, -1);
    }
    if (arg.startsWith('(') && arg.endsWith(')')) return evalSExprValue(arg.slice(1, -1), data);
    if (arg === 'true') return true;
    if (arg === 'false') return false;
    if (arg === 'null') return null;
    if (/^-?\d+(\.\d+)?$/.test(arg)) return Number(arg);
    return resolvePath(data, arg);
  }

  function valueToString(value) {
    if (value == null) return '';
    if (Array.isArray(value)) return '[Array]';
    if (typeof value === 'object') return '[Object]';
    return String(value);
  }

  function valueLength(value) {
    if (value == null) return 0;
    if (Array.isArray(value) || typeof value === 'string') return value.length;
    if (typeof value === 'object') return Object.keys(value).length;
    return valueToString(value).length;
  }

  function slugify(value) {
    return Array.from(value).reduce((out, ch) => {
      if (/[a-zA-Z0-9]/.test(ch)) return out + ch.toLowerCase();
      return out.endsWith('-') || out.length === 0 ? out : out + '-';
    }, '').replace(/-+$/g, '');
  }

  function resolveStringArg(arg, data) {
    arg = arg.trim();
    if (arg.startsWith("'") && arg.endsWith("'") && arg.length >= 2) return arg.slice(1, -1);
    if (arg.startsWith('"') && arg.endsWith('"') && arg.length >= 2) return arg.slice(1, -1);
    if (arg.startsWith('(') && arg.endsWith(')')) return evalSExprValue(arg.slice(1, -1), data);
    if (!arg) return '';
    return valueToString(resolveValueArg(arg, data));
  }

  function interpolateSExprs(text, data, escapeValues = false) {
    if (!text || !text.includes('(')) return text;
    let result = '';
    let pos = 0;
    while (pos < text.length) {
      if (text[pos] === '(') {
        let depth = 0, end = pos;
        for (let i = pos; i < text.length; i++) {
          if (text[i] === '(') depth++;
          else if (text[i] === ')') { depth--; if (depth === 0) { end = i; break; } }
        }
        if (depth === 0) {
          const inner = text.slice(pos + 1, end).trim();
          const keyword = inner.split(/\s/)[0];
          if (SEXPR_HELPERS.has(keyword)) {
            const value = evalSExprValue(inner, data);
            result += escapeValues ? escapeHtml(value) : value;
            pos = end + 1;
            continue;
          }
        }
      }
      result += text[pos];
      pos++;
    }
    return result;
  }

  function isTruthy(val) {
    if (val == null) return false;
    if (val === false || val === 0 || val === '') return false;
    if (Array.isArray(val) && val.length === 0) return false;
    return true;
  }

  // ── DOM Emitter ──────────────────────────────────────────────
  //
  // Walks the AST and builds a DocumentFragment. Evaluates data
  // binding (#{}, !{}, if, each, S-exprs) during emission.

  // ── Security defaults ────────────────────────────────────────
  // These can be overridden via opts. Backward-compat: defaults match
  // prior behavior. Set allowRaw:false and handlers:{} for strict mode.

  const SECURITY_DEFAULTS = {
    allowRaw: true,               // allow !{} and raw blocks (true = legacy compat)
    allowRawInterpolation: true,  // allow !{} in text (true = legacy compat)
    maxEachItems: 10000,          // 0 = unlimited
    handlers: null,               // null = fall back to window[name] (legacy); {} = explicit map
  };

  function buildEmitCtx(opts) {
    const sec = {
      allowRaw: opts.allowRaw ?? SECURITY_DEFAULTS.allowRaw,
      allowRawInterpolation: opts.allowRawInterpolation ?? SECURITY_DEFAULTS.allowRawInterpolation,
      maxEachItems: opts.maxEachItems ?? SECURITY_DEFAULTS.maxEachItems,
      handlers: opts.handlers ?? SECURITY_DEFAULTS.handlers,
    };
    // Deprecation warnings for unsafe legacy defaults
    if (sec.handlers === null && typeof console !== 'undefined') {
      // Only warn once per page load
      if (!buildEmitCtx._warnedHandlers) {
        buildEmitCtx._warnedHandlers = true;
        console.warn('[hdml] on-* events resolve from window globals. Pass opts.handlers for explicit binding.');
      }
    }
    return sec;
  }

  function emitDOM(doc, opts) {
    const prefix = doc.prefix || opts.prefix || null;
    const tokenPrefix = opts.tokenPrefix ?? prefix ?? 'u';
    const fileProps = Object.fromEntries(doc.props || []);
    const props = { ...DEFAULT_PROPS, ...(opts.props || {}), ...fileProps };
    const data = opts.data || {};
    const sec = buildEmitCtx(opts);
    const frag = document.createDocumentFragment();
    emitNodes(doc.nodes, frag, data, prefix, tokenPrefix, props, sec);
    return frag;
  }

  function emitNodes(nodes, parent, data, prefix, tokenPrefix, props, sec) {
    for (const node of nodes) {
      emitNode(node, parent, data, prefix, tokenPrefix, props, sec);
    }
  }

  function emitNode(node, parent, data, prefix, tokenPrefix, props, sec) {
    switch (node.type) {
      case 'Doctype':
        // DocumentFragment can't hold doctype nodes — skip (browser limitation).
        break;

      case 'Element':
        emitElement(node, parent, data, prefix, tokenPrefix, props, sec);
        break;

      case 'Text': {
        const text = processInlineText(node.content, data, true, sec.allowRawInterpolation);
        const tmpl = document.createElement('template');
        tmpl.innerHTML = text;
        parent.appendChild(tmpl.content.cloneNode(true));
        break;
      }

      case 'Comment':
        parent.appendChild(document.createComment(' ' + node.value + ' '));
        break;

      case 'Raw': {
        if (!sec.allowRaw) {
          parent.appendChild(document.createComment(' [hdml: raw block disabled by policy] '));
          break;
        }
        const tmpl = document.createElement('template');
        tmpl.innerHTML = node.content;
        parent.appendChild(tmpl.content.cloneNode(true));
        break;
      }

      case 'Block':
        emitNodes(node.children, parent, data, prefix, tokenPrefix, props, sec);
        break;

      case 'Include':
        parent.appendChild(document.createComment(` include: ${node.path} `));
        break;

      case 'MixinDef':
        break; // definitions don't emit

      case 'MixinCall':
        parent.appendChild(document.createComment(` +${node.name} `));
        break;

      case 'If':
        if (evalCondition(node.condition, data)) {
          emitNodes(node.ifChildren, parent, data, prefix, tokenPrefix, props, sec);
        } else {
          emitNodes(node.elseChildren, parent, data, prefix, tokenPrefix, props, sec);
        }
        break;

      case 'Each': {
        const collection = resolvePath(data, node.collection);
        if (Array.isArray(collection)) {
          const max = sec.maxEachItems > 0 ? sec.maxEachItems : collection.length;
          const items = collection.length > max ? collection.slice(0, max) : collection;
          for (let i = 0; i < items.length; i++) {
            const scopedData = { ...data, [node.item]: items[i] };
            if (node.index) scopedData[node.index] = i;
            emitNodes(node.children, parent, scopedData, prefix, tokenPrefix, props, sec);
          }
          if (collection.length > max) {
            parent.appendChild(document.createComment(` [hdml: each truncated at ${max} items] `));
          }
        }
        break;
      }
    }
  }

  function emitElement(node, parent, data, prefix, tokenPrefix, props, sec) {
    // Resolve component tag.
    let tag = node.tag;
    if (!tag && node.componentName) {
      if (!prefix) throw hdmlError(E.MISSING_PREFIX, 'emit', '@ used but no @prefix declared', { line: node.line });
      tag = prefix + '-' + node.componentName;
    }

    const el = document.createElement(tag);
    if (node.id) el.id = node.id;
    if (node.classes.length) el.className = node.classes.join(' ');

    // Attributes.
    const styleParts = [];
    for (const attr of node.attrs) {
      if (attr.type === 'Event') {
        el.setAttribute('data-on-' + attr.event, attr.handler);
        if (attr.handler) {
          // Prefer explicit handlers map; fall back to window globals (legacy compat)
          const fn = sec.handlers
            ? sec.handlers[attr.handler]
            : (typeof window !== 'undefined' ? window[attr.handler] : undefined);
          if (typeof fn === 'function') {
            el.addEventListener(attr.event, fn);
          }
        }
      } else if (attr.type === 'Token') {
        const shorthand = attr.shorthand;
        const value = interpolateSExprs(interpolate(attr.value, data), data);
        if (AXIS_PROPS[shorthand]) {
          for (const cssProp of AXIS_PROPS[shorthand]) {
            styleParts.push(attr.raw ? `${cssProp}: ${value}` : `${cssProp}: var(--${tokenPrefix ? tokenPrefix + '-' : ''}${value})`);
          }
        } else {
          const cssProp = props[shorthand] || shorthand;
          styleParts.push(attr.raw ? `${cssProp}: ${value}` : `${cssProp}: var(--${tokenPrefix ? tokenPrefix + '-' : ''}${value})`);
        }
      } else {
        // Standard attribute.
        if (attr.name === 'style') {
          styleParts.push(interpolateSExprs(interpolate(attr.value, data), data));
        } else if (attr.value != null) {
          el.setAttribute(attr.name, interpolateSExprs(interpolate(attr.value, data), data));
        } else {
          el.setAttribute(attr.name, '');
        }
      }
    }
    if (styleParts.length) el.setAttribute('style', styleParts.join('; '));

    // Inline text.
    if (node.inlineText) {
      const text = processInlineText(node.inlineText, data, true, sec.allowRawInterpolation);
      const tmpl = document.createElement('template');
      tmpl.innerHTML = text;
      while (tmpl.content.firstChild) el.appendChild(tmpl.content.firstChild);
    }

    parent.appendChild(el);

    // Children.
    if (!VOID.has(tag) && !node.selfClosing) {
      emitNodes(node.children, el, data, prefix, tokenPrefix, props, sec);
    }
  }

  // ── Template discovery ────────────────────────────────────────

  function discoverTemplates() {
    const templates = {};
    if (typeof document === 'undefined') return templates;
    document.querySelectorAll('script[type="text/hdml"]').forEach(script => {
      const id = script.id || script.getAttribute('data-path') || '';
      if (id) templates[id] = script.textContent;
    });
    return templates;
  }

  function resolveTemplate(path, templates) {
    if (templates[path]) return templates[path];
    if (templates[path + '.hdml']) return templates[path + '.hdml'];
    return null;
  }

  // ── Public API ────────────────────────────────────────────────

  function parse(source, opts = {}) {
    const templates = opts.templates || discoverTemplates();
    const tokens = tokenize(source);
    const doc = parseTokens(tokens);
    resolveTemplates(doc, templates, opts.currentPath || '');
    return emitDOM(doc, opts);
  }

  function render(source, target, opts = {}) {
    target.innerHTML = '';
    target.appendChild(parse(source, opts));
  }

  function mount(source, selector, opts = {}) {
    const target = document.querySelector(selector);
    if (target) render(source, target, opts);
  }

  return { parse, render, mount, tokenize, parseTokens, resolveTemplates, emitDOM, HdmlError };
})();

if (typeof module !== 'undefined') module.exports = hdml;
if (typeof window !== 'undefined') window.hdml = hdml;
