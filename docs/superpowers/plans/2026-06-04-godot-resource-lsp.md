# Godot Resource LSP (.tscn / .tres validator) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a second, zero-dependency Language Server to the cc-gd-lsp plugin that statically validates Godot 4 `.tscn` and `.tres` files and offers fix suggestions, surfacing accurate structural errors directly to Claude Code.

**Architecture:** A hand-rolled Node LSP server (`bin/godot-resource-lsp.js`) speaks JSON-RPC over stdio. A line tokenizer → document model → validator pipeline produces LSP diagnostics; a fixes module produces code actions. It runs alongside the existing GDScript TCP bridge via a second entry in `.lsp.json`. v1 is static-only (no Godot process needed); a Godot-backed deep-check is explicitly deferred to v2.

**Tech Stack:** Node 18+ (zero runtime dependencies). Tests use the built-in `node:test` runner and `node:assert/strict`. No build step, no `node_modules` shipped — the plugin stays clone-and-install.

---

## Background: Godot ground truth (do not skip)

Validation rules below are derived from Godot's `scene/resources/resource_format_text.cpp` (the text-format parser). The critical accuracy boundary:

- The text parser catches **structural** errors only: missing required tag attributes, unknown tags, undeclared `ExtResource`/`SubResource` ids, format-version-too-new, wrong tag in wrong file type.
- It does **NOT** validate property names, property types, missing referenced files, or dangling node parent paths — those surface later at scene instantiation. **Do not statically type-check properties in v1** (it would produce false positives). That is the deferred v2 Godot-backed path.

**Severity mapping (authoritative — match exactly):**

| Condition | LSP severity | Rationale |
|---|---|---|
| First section not `gd_scene`/`gd_resource` | Error (1) | Godot `ERR_PARSE_ERROR` |
| `.tres` `gd_resource` missing `type` | Error (1) | Godot `ERR_PARSE_ERROR` |
| `ext_resource` missing `path`/`type`/`id` | Error (1) | Godot `ERR_FILE_CORRUPT` |
| `sub_resource` missing `type`/`id` | Error (1) | Godot `ERR_FILE_CORRUPT` |
| `connection` missing `from`/`to`/`signal`/`method` | Error (1) | Godot `ERR_FILE_CORRUPT` |
| `editable` missing `path` | Error (1) | Godot `ERR_FILE_CORRUPT` |
| `[resource]` tag in `.tscn` | Error (1) | Godot `ERR_FILE_CORRUPT` |
| `[node]` tag in `.tres` | Error (1) | Godot `ERR_FILE_CORRUPT` |
| `format` > 4 | Error (1) | Godot `ERR_FILE_UNRECOGNIZED` |
| `ExtResource("id")` / `SubResource("id")` id never declared in file | Error (1) | Godot `ERR_PARSE_ERROR` / `ERR_INVALID_PARAMETER` |
| `ext_resource` `path` file missing on disk | Error (1) | Real-world breakage (`ERR_FILE_MISSING_DEPENDENCIES` in abort mode) |
| Invalid `uid://...` format | Warning (2) | Godot warns and falls back to path |
| Duplicate `ext_resource`/`sub_resource` `id` | Warning (2) | Lint beyond Godot (Godot silently overwrites) |
| `load_steps` ≠ actual resource count | Info (3) | Godot ignores `load_steps` entirely |

**Valid UID format:** `uid://` followed by 1–13 chars from `[a-y0-8]` (note: not `z`, not `9`). Anything else → invalid.

**Reference-integrity rule (avoid false positives):** flag an `ExtResource`/`SubResource` reference **only** if its id is declared **nowhere** in the file. Do **not** attempt forward-reference ordering detection in v1.

**Out of scope for v1:** binary `.scn`/`.res` (cannot be parsed as text), `project.godot`, property type/name checking, node parent-path resolution.

---

## Data Model & Conventions (canonical — all tasks must match)

LSP `Position` = `{ line, character }`, both 0-based; `character` counts UTF-16 code units (JS string index — use raw string indices).
LSP `Range` = `{ start: Position, end: Position }`.

**Tokenizer output** (`tokenize(text) -> Section[]`):

```js
// Section
{
  name: string,                       // e.g. "gd_scene", "ext_resource", "node"
  attributes: { [key]: string },      // unquoted attribute values
  attrValueRange: { [key]: Range },   // range of just the value (for replace fixes)
  attrFullRange: { [key]: Range },    // range of `key="value"` incl. key (for delete fixes)
  headerLine: number,                 // 0-based line of the `[...]` header
  headerRange: Range,                 // range covering the `[...]` header line
  nameRange: Range,                   // range of the tag name inside the header
  bodyLines: Array<{ text: string, line: number }>, // lines until next header / EOF
}
```

**Document model** (`buildDocument(sections) -> GodotResourceDocument`):

```js
{
  kind: 'scene' | 'resource' | 'unknown', // from first header tag name
  format: number | null,                  // parsed `format` attr of the first header
  header: Section | null,                 // the gd_scene/gd_resource section
  extResources: Array<{ id, type, path, uid, section }>,
  subResources: Array<{ id, type, section }>,
  nodes: Array<{ name, type, parent, section }>,
  connections: Section[],
  editables: Section[],
  resourceSection: Section | null,
  references: Array<{ kind: 'ext' | 'sub', id: string, range: Range }>,
  sections: Section[],                    // all sections in source order
}
```

**Diagnostic** (LSP shape, plus `data` for the fixer):

```js
{
  range: Range,
  severity: 1 | 2 | 3,                    // Error | Warning | Info
  code: string,                           // stable code, see list below
  source: 'godot-resource',
  message: string,                        // human text; INCLUDE suggestion inline when available
  data?: object,                          // fixer hints (e.g. { suggestions: [...] })
}
```

**Diagnostic codes** (stable strings): `unknown-root-tag`, `resource-missing-type`, `ext-missing-attr`, `sub-missing-attr`, `connection-missing-attr`, `editable-missing-path`, `resource-tag-in-scene`, `node-tag-in-resource`, `format-too-new`, `undeclared-ext-ref`, `undeclared-sub-ref`, `ext-file-missing`, `invalid-uid`, `duplicate-ext-id`, `duplicate-sub-id`, `load-steps-mismatch`.

**Project helper** (`project.js`) — passed into validate/fixes so tests can fake it:

```js
{
  root: string | null,                    // abs path of dir containing project.godot
  fileExists(resPath: string): boolean,   // resPath like "res://foo/bar.png"
  findSimilarFiles(resPath: string, max: number): string[], // res:// paths, fuzzy by basename
  listIds(): never,                       // (not used; ids come from the document)
}
```

**File layout:**

```
bin/godot-resource-lsp.js          # thin entrypoint: wires stdio JSON-RPC loop to handlers
src/resource-lsp/rpc.js            # Content-Length JSON-RPC reader/writer over streams
src/resource-lsp/tokenizer.js      # text -> Section[]
src/resource-lsp/document.js       # Section[] -> GodotResourceDocument
src/resource-lsp/project.js        # project root discovery + res:// resolution + fuzzy file search
src/resource-lsp/validate.js       # (document, project) -> Diagnostic[]
src/resource-lsp/fixes.js          # (document, diagnostics, range, project, uri) -> CodeAction[]
src/resource-lsp/server.js         # LSP lifecycle + document store + handlers (uses all of the above)
tests/resource-lsp/*.test.js       # node:test unit + integration tests
tests/resource-lsp/fixtures/*      # sample project tree + .tscn/.tres fixtures
```

`bin/godot-resource-lsp.js` requires `../src/resource-lsp/server.js`. Relative requires resolve inside the copied plugin cache, so this works post-install.

---

## Task 1: Walking skeleton — stdio JSON-RPC server that answers `initialize`

Establish the end-to-end seam first: a server that frames JSON-RPC over stdio, answers `initialize`, accepts `didOpen`, and publishes an (empty) diagnostics notification. Everything else hangs off this.

**Files:**
- Create: `src/resource-lsp/rpc.js`
- Create: `src/resource-lsp/server.js`
- Create: `bin/godot-resource-lsp.js`
- Test: `tests/resource-lsp/rpc.test.js`
- Test: `tests/resource-lsp/integration.test.js`

- [ ] **Step 1: Write the failing test for the JSON-RPC framer**

```js
// tests/resource-lsp/rpc.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');
const { createConnection } = require('../../src/resource-lsp/rpc.js');

test('reads a single framed message and parses it', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const conn = createConnection(input, output);

  const received = [];
  conn.onMessage((msg) => received.push(msg));

  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', params: {} });
  input.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);

  await new Promise((r) => setImmediate(r));
  assert.equal(received.length, 1);
  assert.equal(received[0].method, 'ping');
  assert.equal(received[0].id, 1);
});

test('send() writes a correctly framed message', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const conn = createConnection(input, output);

  const chunks = [];
  output.on('data', (c) => chunks.push(c));
  conn.send({ jsonrpc: '2.0', id: 1, result: { ok: true } });

  await new Promise((r) => setImmediate(r));
  const text = Buffer.concat(chunks).toString('utf8');
  assert.match(text, /^Content-Length: \d+\r\n\r\n/);
  const body = text.slice(text.indexOf('\r\n\r\n') + 4);
  assert.deepEqual(JSON.parse(body), { jsonrpc: '2.0', id: 1, result: { ok: true } });
});

test('handles two messages arriving in one chunk', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const conn = createConnection(input, output);
  const received = [];
  conn.onMessage((m) => received.push(m));

  const m1 = JSON.stringify({ jsonrpc: '2.0', method: 'a' });
  const m2 = JSON.stringify({ jsonrpc: '2.0', method: 'b' });
  const frame = (b) => `Content-Length: ${Buffer.byteLength(b)}\r\n\r\n${b}`;
  input.write(frame(m1) + frame(m2));

  await new Promise((r) => setImmediate(r));
  assert.deepEqual(received.map((m) => m.method), ['a', 'b']);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/resource-lsp/rpc.test.js`
Expected: FAIL — `Cannot find module '../../src/resource-lsp/rpc.js'`

- [ ] **Step 3: Implement the JSON-RPC framer**

```js
// src/resource-lsp/rpc.js
'use strict';

// Minimal LSP-style JSON-RPC framing over a pair of streams.
function createConnection(input, output) {
  let buffer = Buffer.alloc(0);
  let messageHandler = () => {};

  function tryParse() {
    while (true) {
      const headerEnd = buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) return;

      const header = buffer.slice(0, headerEnd).toString('ascii');
      const match = /Content-Length:\s*(\d+)/i.exec(header);
      if (!match) {
        // Malformed header block; drop it to avoid deadlock.
        buffer = buffer.slice(headerEnd + 4);
        continue;
      }
      const length = Number.parseInt(match[1], 10);
      const bodyStart = headerEnd + 4;
      if (buffer.length < bodyStart + length) return; // wait for more bytes

      const body = buffer.slice(bodyStart, bodyStart + length).toString('utf8');
      buffer = buffer.slice(bodyStart + length);

      let msg;
      try {
        msg = JSON.parse(body);
      } catch {
        continue; // skip undecodable frame
      }
      messageHandler(msg);
    }
  }

  input.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    tryParse();
  });

  function send(message) {
    const body = Buffer.from(JSON.stringify(message), 'utf8');
    output.write(`Content-Length: ${body.length}\r\n\r\n`);
    output.write(body);
  }

  return {
    onMessage(fn) { messageHandler = fn; },
    send,
  };
}

module.exports = { createConnection };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/resource-lsp/rpc.test.js`
Expected: PASS (3 tests)

- [ ] **Step 5: Write the failing integration test (server lifecycle)**

```js
// tests/resource-lsp/integration.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');

const ENTRY = path.join(__dirname, '..', '..', 'bin', 'godot-resource-lsp.js');

function frame(obj) {
  const body = JSON.stringify(obj);
  return `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
}

// Collect framed messages from a buffer stream.
function makeCollector(onMessage) {
  let buf = Buffer.alloc(0);
  return (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (true) {
      const he = buf.indexOf('\r\n\r\n');
      if (he === -1) return;
      const m = /Content-Length:\s*(\d+)/i.exec(buf.slice(0, he).toString('ascii'));
      if (!m) return;
      const len = Number.parseInt(m[1], 10);
      const start = he + 4;
      if (buf.length < start + len) return;
      onMessage(JSON.parse(buf.slice(start, start + len).toString('utf8')));
      buf = buf.slice(start + len);
    }
  };
}

test('server answers initialize with capabilities', async () => {
  const srv = spawn('node', [ENTRY], { stdio: ['pipe', 'pipe', 'inherit'] });
  const messages = [];
  srv.stdout.on('data', makeCollector((m) => messages.push(m)));

  srv.stdin.write(frame({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { rootUri: null, capabilities: {} } }));

  await new Promise((r) => setTimeout(r, 300));
  const init = messages.find((m) => m.id === 1);
  assert.ok(init, 'should receive an initialize response');
  assert.ok(init.result.capabilities.textDocumentSync);
  assert.equal(init.result.capabilities.codeActionProvider, true);

  srv.stdin.write(frame({ jsonrpc: '2.0', method: 'exit' }));
  await new Promise((r) => setTimeout(r, 100));
  srv.kill();
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `node --test tests/resource-lsp/integration.test.js`
Expected: FAIL — entrypoint/server modules do not exist yet.

- [ ] **Step 7: Implement the minimal server**

```js
// src/resource-lsp/server.js
'use strict';

const { createConnection } = require('./rpc.js');

function startServer(input, output) {
  const conn = createConnection(input, output);

  conn.onMessage((msg) => {
    if (msg.method === 'initialize') {
      conn.send({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          capabilities: {
            textDocumentSync: { openClose: true, change: 1, save: true }, // 1 = Full
            codeActionProvider: true,
          },
        },
      });
      return;
    }
    if (msg.method === 'initialized') return; // notification, no-op
    if (msg.method === 'shutdown') {
      conn.send({ jsonrpc: '2.0', id: msg.id, result: null });
      return;
    }
    if (msg.method === 'exit') {
      process.exit(0);
    }
    // Unknown request: reply with an empty result so clients are not blocked.
    if (msg.id !== undefined) {
      conn.send({ jsonrpc: '2.0', id: msg.id, result: null });
    }
  });

  return conn;
}

module.exports = { startServer };
```

```js
// bin/godot-resource-lsp.js
#!/usr/bin/env node
'use strict';

// Godot .tscn/.tres validation language server for Claude Code.
// Zero dependencies; speaks LSP JSON-RPC over stdio.
const { startServer } = require('../src/resource-lsp/server.js');

startServer(process.stdin, process.stdout);

process.stdin.on('end', () => process.exit(0));
```

- [ ] **Step 8: Run the integration test to verify it passes**

Run: `node --test tests/resource-lsp/integration.test.js`
Expected: PASS

- [ ] **Step 9: Verify the whole suite is green and syntax is valid**

Run: `node --check bin/godot-resource-lsp.js && node --test tests/resource-lsp/`
Expected: all tests PASS

- [ ] **Step 10: Commit**

```bash
git add bin/godot-resource-lsp.js src/resource-lsp/rpc.js src/resource-lsp/server.js tests/resource-lsp/rpc.test.js tests/resource-lsp/integration.test.js
git commit -m "feat: walking skeleton for godot-resource LSP (stdio JSON-RPC + initialize)"
```

---

## Task 2: Tokenizer — text → sections with ranges

**Files:**
- Create: `src/resource-lsp/tokenizer.js`
- Test: `tests/resource-lsp/tokenizer.test.js`

- [ ] **Step 1: Write the failing test**

```js
// tests/resource-lsp/tokenizer.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { tokenize } = require('../../src/resource-lsp/tokenizer.js');

const SAMPLE = `[gd_scene load_steps=2 format=3 uid="uid://abc"]

[ext_resource type="Script" path="res://player.gd" id="1_xy"]

[node name="Root" type="Node2D"]
script = ExtResource("1_xy")
`;

test('extracts section names in order', () => {
  const sections = tokenize(SAMPLE);
  assert.deepEqual(sections.map((s) => s.name), ['gd_scene', 'ext_resource', 'node']);
});

test('parses attributes with quoted and unquoted values', () => {
  const [scene, ext] = tokenize(SAMPLE);
  assert.equal(scene.attributes.load_steps, '2');
  assert.equal(scene.attributes.format, '3');
  assert.equal(scene.attributes.uid, 'uid://abc');
  assert.equal(ext.attributes.type, 'Script');
  assert.equal(ext.attributes.path, 'res://player.gd');
  assert.equal(ext.attributes.id, '1_xy');
});

test('records header line numbers (0-based)', () => {
  const sections = tokenize(SAMPLE);
  assert.equal(sections[0].headerLine, 0);
  assert.equal(sections[1].headerLine, 2);
  assert.equal(sections[2].headerLine, 4);
});

test('captures body lines under a section', () => {
  const node = tokenize(SAMPLE)[2];
  assert.deepEqual(node.bodyLines.map((l) => l.text), ['script = ExtResource("1_xy")', '']);
  assert.equal(node.bodyLines[0].line, 5);
});

test('value range points at the attribute value text', () => {
  const ext = tokenize(SAMPLE)[1];
  const r = ext.attrValueRange.path;
  // header line is index 2; value "res://player.gd" sits inside the quotes
  assert.equal(r.start.line, 2);
  const headerText = '[ext_resource type="Script" path="res://player.gd" id="1_xy"]';
  assert.equal(headerText.slice(r.start.character, r.end.character), 'res://player.gd');
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/resource-lsp/tokenizer.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the tokenizer**

```js
// src/resource-lsp/tokenizer.js
'use strict';

// NOTE: the attribute-span group skips over quoted spans so a `]` inside a
// quoted value does not prematurely end the header match.
const HEADER_RE = /^\s*\[([A-Za-z_][\w]*)\b((?:[^\]"]|"(?:[^"\\]|\\.)*")*)\]\s*$/;

// Parse `key=value` / `key="value"` pairs out of a header's attribute span.
// Returns { attributes, attrValueRange, attrFullRange } with ranges on `line`.
function parseAttributes(attrSpan, spanOffset, line) {
  const attributes = {};
  const attrValueRange = {};
  const attrFullRange = {};
  // Match key, then a quoted or unquoted value.
  const re = /([A-Za-z_][\w]*)\s*=\s*("(?:[^"\\]|\\.)*"|[^\s\]]+)/g;
  let m;
  while ((m = re.exec(attrSpan)) !== null) {
    const key = m[1];
    let rawValue = m[2];
    const valueStartInSpan = m.index + m[0].length - rawValue.length;
    let value = rawValue;
    let valueChar = spanOffset + valueStartInSpan;
    // The range must index the ORIGINAL source, so use the raw span length
    // (escapes kept), not the unescaped value length.
    let sourceValueLength;
    if (rawValue.startsWith('"') && rawValue.endsWith('"')) {
      value = rawValue.slice(1, -1).replace(/\\(.)/g, '$1');
      valueChar += 1; // skip opening quote
      sourceValueLength = rawValue.length - 2;
    } else {
      sourceValueLength = rawValue.length;
    }
    attributes[key] = value;
    attrValueRange[key] = {
      start: { line, character: valueChar },
      end: { line, character: valueChar + sourceValueLength },
    };
    const fullStart = spanOffset + m.index;
    attrFullRange[key] = {
      start: { line, character: fullStart },
      end: { line, character: fullStart + m[0].length },
    };
  }
  return { attributes, attrValueRange, attrFullRange };
}

function tokenize(text) {
  const lines = text.split(/\r?\n/);
  const sections = [];
  let current = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const hm = HEADER_RE.exec(line);
    if (hm) {
      const name = hm[1];
      const nameStart = line.indexOf(name, line.indexOf('['));
      const attrSpan = hm[2];
      const attrSpanOffset = nameStart + name.length;
      const parsed = parseAttributes(attrSpan, attrSpanOffset, i);
      current = {
        name,
        attributes: parsed.attributes,
        attrValueRange: parsed.attrValueRange,
        attrFullRange: parsed.attrFullRange,
        headerLine: i,
        headerRange: {
          start: { line: i, character: 0 },
          end: { line: i, character: line.length },
        },
        nameRange: {
          start: { line: i, character: nameStart },
          end: { line: i, character: nameStart + name.length },
        },
        bodyLines: [],
      };
      sections.push(current);
    } else if (current) {
      current.bodyLines.push({ text: line, line: i });
    }
    // Lines before the first header (rare) are ignored.
  }

  return sections;
}

module.exports = { tokenize };
```

- [ ] **Step 4: Run it to verify it passes**

Run: `node --test tests/resource-lsp/tokenizer.test.js`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add src/resource-lsp/tokenizer.js tests/resource-lsp/tokenizer.test.js
git commit -m "feat: tokenizer for godot text resource sections with ranges"
```

---

## Task 3: Document model — sections → structured document + references

**Files:**
- Create: `src/resource-lsp/document.js`
- Test: `tests/resource-lsp/document.test.js`

- [ ] **Step 1: Write the failing test**

```js
// tests/resource-lsp/document.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { tokenize } = require('../../src/resource-lsp/tokenizer.js');
const { buildDocument } = require('../../src/resource-lsp/document.js');

const SCENE = `[gd_scene load_steps=3 format=3 uid="uid://abc"]

[ext_resource type="Script" path="res://player.gd" id="1_xy"]
[sub_resource type="CircleShape2D" id="Shape_1"]

[node name="Root" type="Node2D"]
script = ExtResource("1_xy")

[node name="Body" type="StaticBody2D" parent="."]
shape = SubResource("Shape_1")
`;

const RESOURCE = `[gd_resource type="Theme" load_steps=1 format=3]

[resource]
default_font_size = 16
`;

test('classifies a scene document', () => {
  const doc = buildDocument(tokenize(SCENE));
  assert.equal(doc.kind, 'scene');
  assert.equal(doc.format, 3);
  assert.equal(doc.extResources.length, 1);
  assert.equal(doc.subResources.length, 1);
  assert.equal(doc.nodes.length, 2);
});

test('captures ext/sub resource fields', () => {
  const doc = buildDocument(tokenize(SCENE));
  assert.deepEqual(
    { id: doc.extResources[0].id, type: doc.extResources[0].type, path: doc.extResources[0].path },
    { id: '1_xy', type: 'Script', path: 'res://player.gd' },
  );
  assert.equal(doc.subResources[0].id, 'Shape_1');
});

test('collects ExtResource/SubResource references with ranges', () => {
  const doc = buildDocument(tokenize(SCENE));
  const ext = doc.references.find((r) => r.kind === 'ext');
  const sub = doc.references.find((r) => r.kind === 'sub');
  assert.equal(ext.id, '1_xy');
  assert.equal(sub.id, 'Shape_1');
  // ext reference is on the `script = ExtResource("1_xy")` line
  assert.equal(ext.range.start.line, 6);
});

test('classifies a resource document', () => {
  const doc = buildDocument(tokenize(RESOURCE));
  assert.equal(doc.kind, 'resource');
  assert.ok(doc.resourceSection);
  assert.equal(doc.nodes.length, 0);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/resource-lsp/document.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the document builder**

```js
// src/resource-lsp/document.js
'use strict';

// `d` flag (hasIndices) gives exact capture-group offsets, avoiding indexOf
// drift when an id is a substring of the keyword (e.g. id "Resource").
const REFERENCE_RE = /\b(ExtResource|SubResource)\(\s*"?([0-9A-Za-z_]+)"?\s*\)/gd;

function buildDocument(sections) {
  const doc = {
    kind: 'unknown',
    format: null,
    header: null,
    extResources: [],
    subResources: [],
    nodes: [],
    connections: [],
    editables: [],
    resourceSection: null,
    references: [],
    sections,
  };

  if (sections.length > 0) {
    const first = sections[0];
    doc.header = first;
    if (first.name === 'gd_scene') doc.kind = 'scene';
    else if (first.name === 'gd_resource') doc.kind = 'resource';
    if (first.attributes.format !== undefined) {
      const f = Number.parseInt(first.attributes.format, 10);
      doc.format = Number.isNaN(f) ? null : f;
    }
  }

  for (const s of sections) {
    switch (s.name) {
      case 'ext_resource':
        doc.extResources.push({
          id: s.attributes.id,
          type: s.attributes.type,
          path: s.attributes.path,
          uid: s.attributes.uid,
          section: s,
        });
        break;
      case 'sub_resource':
        doc.subResources.push({ id: s.attributes.id, type: s.attributes.type, section: s });
        break;
      case 'node':
        doc.nodes.push({
          name: s.attributes.name,
          type: s.attributes.type,
          parent: s.attributes.parent,
          section: s,
        });
        break;
      case 'connection':
        doc.connections.push(s);
        break;
      case 'editable':
        doc.editables.push(s);
        break;
      case 'resource':
        doc.resourceSection = s;
        break;
      default:
        break;
    }
    // Scan this section's body lines for references.
    for (const { text, line } of s.bodyLines) {
      REFERENCE_RE.lastIndex = 0;
      let m;
      while ((m = REFERENCE_RE.exec(text)) !== null) {
        const [idStart, idEnd] = m.indices[2];
        doc.references.push({
          kind: m[1] === 'ExtResource' ? 'ext' : 'sub',
          id: m[2],
          range: {
            start: { line, character: idStart },
            end: { line, character: idEnd },
          },
        });
      }
    }
  }

  return doc;
}

module.exports = { buildDocument };
```

- [ ] **Step 4: Run it to verify it passes**

Run: `node --test tests/resource-lsp/document.test.js`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/resource-lsp/document.js tests/resource-lsp/document.test.js
git commit -m "feat: build structured document model from godot resource sections"
```

---

## Task 4: Project resolution — root discovery, res:// existence, fuzzy file search

**Files:**
- Create: `src/resource-lsp/project.js`
- Test: `tests/resource-lsp/project.test.js`
- Test fixtures: `tests/resource-lsp/fixtures/proj/project.godot`, `tests/resource-lsp/fixtures/proj/player.gd`, `tests/resource-lsp/fixtures/proj/art/player.png`

- [ ] **Step 1: Create the fixture project tree**

```bash
mkdir -p tests/resource-lsp/fixtures/proj/art
printf 'config_version=5\n[application]\nconfig/name="Fixture"\n' > tests/resource-lsp/fixtures/proj/project.godot
printf 'extends Node\n' > tests/resource-lsp/fixtures/proj/player.gd
printf 'PNG\n' > tests/resource-lsp/fixtures/proj/art/player.png
```

- [ ] **Step 2: Write the failing test**

```js
// tests/resource-lsp/project.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createProject, findProjectRoot } = require('../../src/resource-lsp/project.js');

const PROJ = path.join(__dirname, 'fixtures', 'proj');

test('findProjectRoot walks up to project.godot', () => {
  const start = path.join(PROJ, 'art');
  assert.equal(findProjectRoot(start), PROJ);
});

test('findProjectRoot returns null when no project.godot above', () => {
  assert.equal(findProjectRoot('/tmp'), null);
});

test('fileExists resolves res:// against the root', () => {
  const project = createProject(PROJ);
  assert.equal(project.fileExists('res://player.gd'), true);
  assert.equal(project.fileExists('res://art/player.png'), true);
  assert.equal(project.fileExists('res://missing.png'), false);
});

test('findSimilarFiles suggests by basename similarity', () => {
  const project = createProject(PROJ);
  const hits = project.findSimilarFiles('res://art/palyer.png', 3);
  assert.ok(hits.includes('res://art/player.png'));
});

test('createProject with null root degrades gracefully', () => {
  const project = createProject(null);
  assert.equal(project.fileExists('res://anything'), false);
  assert.deepEqual(project.findSimilarFiles('res://x.png', 3), []);
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `node --test tests/resource-lsp/project.test.js`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement project.js**

```js
// src/resource-lsp/project.js
'use strict';

const fs = require('node:fs');
const path = require('node:path');

function findProjectRoot(startDir) {
  let dir = path.resolve(startDir);
  for (let i = 0; i < 24; i++) {
    if (fs.existsSync(path.join(dir, 'project.godot'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function resToAbs(root, resPath) {
  if (!root || typeof resPath !== 'string' || !resPath.startsWith('res://')) return null;
  const abs = path.resolve(root, resPath.slice('res://'.length));
  const rel = path.relative(root, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null; // escapes the project root
  return abs;
}

// Levenshtein distance, small inputs only.
function distance(a, b) {
  const m = a.length;
  const n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }
  return dp[m][n];
}

function listAllFiles(root) {
  const out = [];
  const SKIP = new Set(['.godot', '.git', '.import', 'node_modules']);
  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (SKIP.has(e.name)) continue;
        walk(path.join(dir, e.name));
      } else if (e.isFile()) {
        const rel = path.relative(root, path.join(dir, e.name)).split(path.sep).join('/');
        out.push('res://' + rel);
      }
    }
  }
  walk(root);
  return out;
}

function createProject(root) {
  let fileCache = null;
  let cacheTime = 0;
  const TTL_MS = 5000;

  function files() {
    if (!root) return [];
    const now = Date.now();
    if (!fileCache || now - cacheTime > TTL_MS) {
      fileCache = listAllFiles(root);
      cacheTime = now;
    }
    return fileCache;
  }

  return {
    root,
    fileExists(resPath) {
      const abs = resToAbs(root, resPath);
      if (!abs) return false;
      try {
        return fs.existsSync(abs);
      } catch {
        return false;
      }
    },
    findSimilarFiles(resPath, max) {
      if (!root || typeof resPath !== 'string') return [];
      const targetBase = resPath.split('/').pop().toLowerCase();
      if (!targetBase) return [];
      const threshold = Math.max(2, Math.floor(targetBase.length / 3));
      return files()
        .map((f) => ({ f, d: distance(targetBase, f.split('/').pop().toLowerCase()) }))
        .filter((x) => x.d <= threshold)
        .sort((a, b) => a.d - b.d)
        .slice(0, max)
        .map((x) => x.f);
    },
  };
}

module.exports = { createProject, findProjectRoot, resToAbs };
```

- [ ] **Step 5: Run it to verify it passes**

Run: `node --test tests/resource-lsp/project.test.js`
Expected: PASS (5 tests)

- [ ] **Step 6: Commit**

```bash
git add src/resource-lsp/project.js tests/resource-lsp/project.test.js tests/resource-lsp/fixtures/
git commit -m "feat: project root discovery + res:// resolution + fuzzy file search"
```

---

## Task 5: Validator — structural rules (no filesystem yet)

Implements every structural rule from the severity table that needs only the document (no project).

**Files:**
- Create: `src/resource-lsp/validate.js`
- Test: `tests/resource-lsp/validate-structural.test.js`

- [ ] **Step 1: Write the failing test**

```js
// tests/resource-lsp/validate-structural.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { tokenize } = require('../../src/resource-lsp/tokenizer.js');
const { buildDocument } = require('../../src/resource-lsp/document.js');
const { validate } = require('../../src/resource-lsp/validate.js');

// A project stub where every file exists, so structural tests stay isolated.
const ALL_OK_PROJECT = {
  root: '/x',
  fileExists: () => true,
  findSimilarFiles: () => [],
};

function diag(src) {
  return validate(buildDocument(tokenize(src)), ALL_OK_PROJECT);
}
function codes(src) {
  return diag(src).map((d) => d.code).sort();
}

test('flags unknown root tag', () => {
  assert.ok(codes('[banana]\n').includes('unknown-root-tag'));
});

test('flags gd_resource without type', () => {
  assert.ok(codes('[gd_resource format=3]\n\n[resource]\n').includes('resource-missing-type'));
});

test('flags ext_resource missing required attrs', () => {
  const c = codes('[gd_scene format=3]\n\n[ext_resource type="Script"]\n');
  assert.ok(c.includes('ext-missing-attr'));
});

test('flags sub_resource missing id', () => {
  const c = codes('[gd_scene format=3]\n\n[sub_resource type="CircleShape2D"]\n');
  assert.ok(c.includes('sub-missing-attr'));
});

test('flags connection missing fields', () => {
  const src = '[gd_scene format=3]\n\n[node name="A" type="Node"]\n\n[connection signal="x" from="A" to="B"]\n';
  assert.ok(codes(src).includes('connection-missing-attr'));
});

test('flags [resource] tag in a scene', () => {
  assert.ok(codes('[gd_scene format=3]\n\n[resource]\n').includes('resource-tag-in-scene'));
});

test('flags [node] tag in a resource', () => {
  assert.ok(codes('[gd_resource type="Theme" format=3]\n\n[node name="A" type="Node"]\n').includes('node-tag-in-resource'));
});

test('flags format newer than 4', () => {
  assert.ok(codes('[gd_scene format=5]\n').includes('format-too-new'));
});

test('flags invalid uid as a warning', () => {
  const d = diag('[gd_scene format=3]\n\n[ext_resource type="Script" path="res://a.gd" uid="uid://zzz9" id="1"]\n');
  const uid = d.find((x) => x.code === 'invalid-uid');
  assert.ok(uid);
  assert.equal(uid.severity, 2);
});

test('flags duplicate ext id as warning', () => {
  const src = '[gd_scene format=3]\n\n[ext_resource type="Script" path="res://a.gd" id="1"]\n[ext_resource type="Script" path="res://b.gd" id="1"]\n';
  const d = diag(src);
  const dup = d.find((x) => x.code === 'duplicate-ext-id');
  assert.ok(dup);
  assert.equal(dup.severity, 2);
});

test('clean scene yields no structural diagnostics', () => {
  const src = '[gd_scene load_steps=2 format=3 uid="uid://abc"]\n\n[ext_resource type="Script" path="res://a.gd" id="1"]\n\n[node name="Root" type="Node"]\nscript = ExtResource("1")\n';
  // load_steps=2 but only 1 ext resource -> expect a single info diagnostic, nothing else
  const d = diag(src);
  assert.deepEqual(d.map((x) => x.code), ['load-steps-mismatch']);
  assert.equal(d[0].severity, 3);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/resource-lsp/validate-structural.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement validate.js (structural portion + reference + filesystem hooks)**

```js
// src/resource-lsp/validate.js
'use strict';

const SEVERITY = { ERROR: 1, WARNING: 2, INFO: 3 };
const SOURCE = 'godot-resource';
const MAX_FORMAT = 4;
const UID_RE = /^uid:\/\/[a-y0-8]{1,13}$/;

function mk(range, severity, code, message, data) {
  return { range, severity, code, source: SOURCE, message, ...(data ? { data } : {}) };
}

function attrRange(section, key) {
  return section.attrValueRange[key] || section.headerRange;
}

function validate(doc, project) {
  const diags = [];

  // --- root tag ---
  if (doc.sections.length === 0) return diags;
  const first = doc.sections[0];
  if (first.name !== 'gd_scene' && first.name !== 'gd_resource') {
    diags.push(mk(first.nameRange, SEVERITY.ERROR, 'unknown-root-tag',
      `Unrecognized root tag '${first.name}'. Expected 'gd_scene' or 'gd_resource'.`));
  }
  if (first.name === 'gd_resource' && first.attributes.type === undefined) {
    diags.push(mk(first.headerRange, SEVERITY.ERROR, 'resource-missing-type',
      `Missing required 'type' attribute in 'gd_resource' tag.`));
  }

  // --- format version ---
  if (doc.format !== null && doc.format > MAX_FORMAT) {
    diags.push(mk(attrRange(first, 'format'), SEVERITY.ERROR, 'format-too-new',
      `format=${doc.format} is newer than this Godot version supports (max ${MAX_FORMAT}).`));
  }

  // --- per-section structural checks ---
  for (const s of doc.sections) {
    // A uid attribute can appear on the root header AND on ext_resource;
    // a malformed uid is invalid wherever it appears (Godot alphabet [a-y0-8]).
    if (s.attributes.uid !== undefined && !UID_RE.test(s.attributes.uid)) {
      diags.push(mk(attrRange(s, 'uid'), SEVERITY.WARNING, 'invalid-uid',
        `Invalid UID '${s.attributes.uid}'. Godot only generates UIDs using [a-y0-8]; this one will not resolve and Godot falls back to the path.`));
    }
    if (s.name === 'ext_resource') {
      for (const req of ['type', 'path', 'id']) {
        if (s.attributes[req] === undefined) {
          diags.push(mk(s.headerRange, SEVERITY.ERROR, 'ext-missing-attr',
            `Missing required '${req}' attribute in 'ext_resource' tag.`));
        }
      }
    } else if (s.name === 'sub_resource') {
      for (const req of ['type', 'id']) {
        if (s.attributes[req] === undefined) {
          diags.push(mk(s.headerRange, SEVERITY.ERROR, 'sub-missing-attr',
            `Missing required '${req}' attribute in 'sub_resource' tag.`));
        }
      }
    } else if (s.name === 'connection') {
      for (const req of ['signal', 'from', 'to', 'method']) {
        if (s.attributes[req] === undefined) {
          diags.push(mk(s.headerRange, SEVERITY.ERROR, 'connection-missing-attr',
            `Missing required '${req}' field in 'connection' tag.`));
        }
      }
    } else if (s.name === 'editable') {
      if (s.attributes.path === undefined) {
        diags.push(mk(s.headerRange, SEVERITY.ERROR, 'editable-missing-path',
          `Missing required 'path' field in 'editable' tag.`));
      }
    } else if (s.name === 'resource' && doc.kind === 'scene') {
      diags.push(mk(s.nameRange, SEVERITY.ERROR, 'resource-tag-in-scene',
        `Unexpected '[resource]' tag in a scene (.tscn) file.`));
    } else if (s.name === 'node' && doc.kind === 'resource') {
      diags.push(mk(s.nameRange, SEVERITY.ERROR, 'node-tag-in-resource',
        `Unexpected '[node]' tag in a resource (.tres) file.`));
    }
  }

  // --- duplicate ids ---
  duplicateIds(doc.extResources, 'duplicate-ext-id', 'ext_resource', diags);
  duplicateIds(doc.subResources, 'duplicate-sub-id', 'sub_resource', diags);

  // --- reference integrity (ids declared somewhere in the file) ---
  const extIds = new Set(doc.extResources.map((e) => e.id).filter(Boolean));
  const subIds = new Set(doc.subResources.map((sr) => sr.id).filter(Boolean));
  for (const ref of doc.references) {
    if (ref.kind === 'ext' && !extIds.has(ref.id)) {
      diags.push(mk(ref.range, SEVERITY.ERROR, 'undeclared-ext-ref',
        `ExtResource("${ref.id}") refers to an id not declared in this file.`,
        { id: ref.id, declared: [...extIds] }));
    }
    if (ref.kind === 'sub' && !subIds.has(ref.id)) {
      diags.push(mk(ref.range, SEVERITY.ERROR, 'undeclared-sub-ref',
        `SubResource("${ref.id}") refers to an id not declared in this file.`,
        { id: ref.id, declared: [...subIds] }));
    }
  }

  // --- filesystem: ext_resource path must exist (only when we know the project root) ---
  for (const ext of doc.extResources) {
    if (project.root && ext.path && ext.path.startsWith('res://') && !project.fileExists(ext.path)) {
      const suggestions = project.findSimilarFiles(ext.path, 3);
      const hint = suggestions.length ? ` Did you mean: ${suggestions.join(', ')}?` : '';
      diags.push(mk(attrRange(ext.section, 'path'), SEVERITY.ERROR, 'ext-file-missing',
        `Referenced file '${ext.path}' does not exist.${hint}`,
        { resPath: ext.path, suggestions }));
    }
  }

  // --- load_steps hint ---
  if (first.attributes.load_steps !== undefined) {
    const declared = Number.parseInt(first.attributes.load_steps, 10);
    const actual = doc.extResources.length + doc.subResources.length;
    if (!Number.isNaN(declared) && declared !== actual) {
      diags.push(mk(attrRange(first, 'load_steps'), SEVERITY.INFO, 'load-steps-mismatch',
        `load_steps=${declared} but the file declares ${actual} resources. Godot ignores this value, but keeping it correct is conventional.`,
        { actual }));
    }
  }

  return diags;
}

function duplicateIds(list, code, tagName, diags) {
  const seen = new Map();
  for (const item of list) {
    if (!item.id) continue;
    if (seen.has(item.id)) {
      diags.push(mk(item.section.attrValueRange.id || item.section.headerRange, 2, code,
        `Duplicate ${tagName} id '${item.id}'. Each id must be unique within the file.`,
        { id: item.id }));
    } else {
      seen.set(item.id, item);
    }
  }
}

module.exports = { validate, SEVERITY };
```

- [ ] **Step 4: Run it to verify it passes**

Run: `node --test tests/resource-lsp/validate-structural.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/resource-lsp/validate.js tests/resource-lsp/validate-structural.test.js
git commit -m "feat: structural validator for godot resource files"
```

---

## Task 6: Validator — filesystem + reference integrity against the real fixture project

This task adds tests that exercise the `project`-dependent rules (`ext-file-missing`, `undeclared-*-ref`) end-to-end with the real fixture from Task 4. The implementation already exists in `validate.js`; this task proves it against disk and locks the behavior.

**Files:**
- Test: `tests/resource-lsp/validate-project.test.js`

- [ ] **Step 1: Write the failing test**

```js
// tests/resource-lsp/validate-project.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { tokenize } = require('../../src/resource-lsp/tokenizer.js');
const { buildDocument } = require('../../src/resource-lsp/document.js');
const { validate } = require('../../src/resource-lsp/validate.js');
const { createProject } = require('../../src/resource-lsp/project.js');

const PROJ = path.join(__dirname, 'fixtures', 'proj');
const project = createProject(PROJ);

function codes(src) {
  return validate(buildDocument(tokenize(src)), project).map((d) => d.code);
}

test('existing ext_resource file yields no missing-file error', () => {
  const src = '[gd_scene format=3]\n\n[ext_resource type="Script" path="res://player.gd" id="1"]\n';
  assert.ok(!codes(src).includes('ext-file-missing'));
});

test('missing ext_resource file is flagged with a suggestion', () => {
  const src = '[gd_scene format=3]\n\n[ext_resource type="Texture2D" path="res://art/palyer.png" id="1"]\n';
  const d = validate(buildDocument(tokenize(src)), project);
  const miss = d.find((x) => x.code === 'ext-file-missing');
  assert.ok(miss);
  assert.equal(miss.severity, 1);
  assert.ok(miss.data.suggestions.includes('res://art/player.png'));
  assert.match(miss.message, /Did you mean/);
});

test('undeclared ExtResource reference is an error', () => {
  const src = '[gd_scene format=3]\n\n[ext_resource type="Script" path="res://player.gd" id="1"]\n\n[node name="R" type="Node"]\nscript = ExtResource("99")\n';
  const d = validate(buildDocument(tokenize(src)), project);
  const ref = d.find((x) => x.code === 'undeclared-ext-ref');
  assert.ok(ref);
  assert.deepEqual(ref.data.declared, ['1']);
});

test('declared reference passes', () => {
  const src = '[gd_scene format=3]\n\n[ext_resource type="Script" path="res://player.gd" id="1"]\n\n[node name="R" type="Node"]\nscript = ExtResource("1")\n';
  assert.ok(!codes(src).includes('undeclared-ext-ref'));
});
```

- [ ] **Step 2: Run it to verify it passes (implementation already present)**

Run: `node --test tests/resource-lsp/validate-project.test.js`
Expected: PASS. If any test fails, fix `validate.js` until green — do not weaken the test.

- [ ] **Step 3: Commit**

```bash
git add tests/resource-lsp/validate-project.test.js
git commit -m "test: lock filesystem + reference-integrity validation against fixture project"
```

---

## Task 7: Wire the validator into the server (publish diagnostics on open/change/save/close)

**Files:**
- Modify: `src/resource-lsp/server.js`
- Test: `tests/resource-lsp/server-diagnostics.test.js`

- [ ] **Step 1: Write the failing test (in-process server with fake streams)**

```js
// tests/resource-lsp/server-diagnostics.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');
const path = require('node:path');
const { startServer } = require('../../src/resource-lsp/server.js');

const PROJ = path.join(__dirname, 'fixtures', 'proj');

function frame(obj) {
  const body = JSON.stringify(obj);
  return `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
}
function collect(stream, onMsg) {
  let buf = Buffer.alloc(0);
  stream.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (true) {
      const he = buf.indexOf('\r\n\r\n');
      if (he === -1) return;
      const m = /Content-Length:\s*(\d+)/i.exec(buf.slice(0, he).toString('ascii'));
      if (!m) return;
      const len = Number.parseInt(m[1], 10);
      if (buf.length < he + 4 + len) return;
      onMsg(JSON.parse(buf.slice(he + 4, he + 4 + len).toString('utf8')));
      buf = buf.slice(he + 4 + len);
    }
  });
}

test('didOpen on a broken scene publishes diagnostics', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const messages = [];
  collect(output, (m) => messages.push(m));
  startServer(input, output);

  input.write(frame({ jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { rootUri: 'file://' + PROJ, capabilities: {} } }));
  input.write(frame({ jsonrpc: '2.0', method: 'initialized', params: {} }));

  const uri = 'file://' + path.join(PROJ, 'broken.tscn');
  const text = '[gd_scene format=3]\n\n[ext_resource type="Texture2D" path="res://art/missing.png" id="1"]\n';
  input.write(frame({ jsonrpc: '2.0', method: 'textDocument/didOpen',
    params: { textDocument: { uri, languageId: 'godot-resource', version: 1, text } } }));

  await new Promise((r) => setTimeout(r, 150));
  const pub = messages.find((m) => m.method === 'textDocument/publishDiagnostics');
  assert.ok(pub, 'should publish diagnostics');
  assert.equal(pub.params.uri, uri);
  assert.ok(pub.params.diagnostics.some((d) => d.code === 'ext-file-missing'));
});

test('didClose clears diagnostics', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const messages = [];
  collect(output, (m) => messages.push(m));
  startServer(input, output);

  input.write(frame({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { rootUri: 'file://' + PROJ, capabilities: {} } }));
  const uri = 'file://' + path.join(PROJ, 'x.tscn');
  input.write(frame({ jsonrpc: '2.0', method: 'textDocument/didOpen',
    params: { textDocument: { uri, languageId: 'godot-resource', version: 1, text: '[banana]\n' } } }));
  await new Promise((r) => setTimeout(r, 80));
  input.write(frame({ jsonrpc: '2.0', method: 'textDocument/didClose', params: { textDocument: { uri } } }));
  await new Promise((r) => setTimeout(r, 80));

  const last = messages.filter((m) => m.method === 'textDocument/publishDiagnostics').pop();
  assert.deepEqual(last.params.diagnostics, []);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/resource-lsp/server-diagnostics.test.js`
Expected: FAIL — server does not handle didOpen/validation yet.

- [ ] **Step 3: Extend server.js**

```js
// src/resource-lsp/server.js
'use strict';

const { fileURLToPath } = require('node:url');
const path = require('node:path');
const { createConnection } = require('./rpc.js');
const { tokenize } = require('./tokenizer.js');
const { buildDocument } = require('./document.js');
const { validate } = require('./validate.js');
const { createProject, findProjectRoot } = require('./project.js');

function uriToPath(uri) {
  try {
    return fileURLToPath(uri);
  } catch {
    return uri.startsWith('file://') ? uri.slice('file://'.length) : uri;
  }
}

function startServer(input, output) {
  const conn = createConnection(input, output);
  const documents = new Map(); // uri -> text
  let workspaceRoot = null;

  function projectFor(uri) {
    const fsPath = uriToPath(uri);
    const root = findProjectRoot(path.dirname(fsPath)) || workspaceRoot;
    return createProject(root);
  }

  function publish(uri) {
    const text = documents.get(uri);
    if (text === undefined) return;
    let diagnostics = [];
    try {
      diagnostics = validate(buildDocument(tokenize(text)), projectFor(uri));
    } catch (err) {
      process.stderr.write(`[godot-resource] validation error: ${err && err.stack}\n`);
    }
    conn.send({ jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: { uri, diagnostics } });
  }

  conn.onMessage((msg) => {
    switch (msg.method) {
      case 'initialize': {
        const rootUri = msg.params && msg.params.rootUri;
        if (rootUri) workspaceRoot = uriToPath(rootUri);
        conn.send({
          jsonrpc: '2.0',
          id: msg.id,
          result: { capabilities: { textDocumentSync: { openClose: true, change: 1, save: true }, codeActionProvider: true } },
        });
        return;
      }
      case 'initialized':
        return;
      case 'textDocument/didOpen': {
        const { uri, text } = msg.params.textDocument;
        documents.set(uri, text);
        publish(uri);
        return;
      }
      case 'textDocument/didChange': {
        const uri = msg.params.textDocument.uri;
        const changes = msg.params.contentChanges;
        if (changes && changes.length) documents.set(uri, changes[changes.length - 1].text); // Full sync
        publish(uri);
        return;
      }
      case 'textDocument/didSave': {
        const uri = msg.params.textDocument.uri;
        if (msg.params.text !== undefined) documents.set(uri, msg.params.text);
        publish(uri);
        return;
      }
      case 'textDocument/didClose': {
        const uri = msg.params.textDocument.uri;
        documents.delete(uri);
        conn.send({ jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: { uri, diagnostics: [] } });
        return;
      }
      case 'shutdown':
        conn.send({ jsonrpc: '2.0', id: msg.id, result: null });
        return;
      case 'exit':
        process.exit(0);
        return;
      default:
        if (msg.id !== undefined) conn.send({ jsonrpc: '2.0', id: msg.id, result: null });
    }
  });

  return { conn, documents };
}

module.exports = { startServer };
```

- [ ] **Step 4: Run it to verify it passes**

Run: `node --test tests/resource-lsp/server-diagnostics.test.js`
Expected: PASS

- [ ] **Step 5: Run the full suite**

Run: `node --test tests/resource-lsp/`
Expected: all PASS

- [ ] **Step 6: Commit**

```bash
git add src/resource-lsp/server.js tests/resource-lsp/server-diagnostics.test.js
git commit -m "feat: publish godot-resource diagnostics on open/change/save/close"
```

---

## Task 8: Fix suggestions — code actions for the fixable diagnostics

Implements `textDocument/codeAction`. Code actions return `WorkspaceEdit`s keyed by the document URI.

**Files:**
- Create: `src/resource-lsp/fixes.js`
- Modify: `src/resource-lsp/server.js` (handle `textDocument/codeAction`)
- Test: `tests/resource-lsp/fixes.test.js`

- [ ] **Step 1: Write the failing test**

```js
// tests/resource-lsp/fixes.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { tokenize } = require('../../src/resource-lsp/tokenizer.js');
const { buildDocument } = require('../../src/resource-lsp/document.js');
const { validate } = require('../../src/resource-lsp/validate.js');
const { computeCodeActions } = require('../../src/resource-lsp/fixes.js');

const PROJECT = {
  root: '/x',
  fileExists: (p) => p === 'res://art/player.png',
  findSimilarFiles: (p) => (p.includes('palyer') ? ['res://art/player.png'] : []),
};
const URI = 'file:///x/scene.tscn';

function actionsFor(src) {
  const doc = buildDocument(tokenize(src));
  const diags = validate(doc, PROJECT);
  const fullRange = { start: { line: 0, character: 0 }, end: { line: 9999, character: 0 } };
  return computeCodeActions(doc, diags, fullRange, PROJECT, URI);
}

test('missing-file diagnostic yields a "did you mean" replace edit', () => {
  const src = '[gd_scene format=3]\n\n[ext_resource type="Texture2D" path="res://art/palyer.png" id="1"]\n';
  const actions = actionsFor(src);
  const fix = actions.find((a) => a.title.includes('res://art/player.png'));
  assert.ok(fix);
  const edit = fix.edit.changes[URI][0];
  assert.equal(edit.newText, 'res://art/player.png');
  // edit range must cover the old path value
  assert.equal(edit.range.start.line, 2);
});

test('invalid-uid diagnostic yields a remove-attribute edit', () => {
  const src = '[gd_scene format=3]\n\n[ext_resource type="Script" path="res://art/player.png" uid="uid://zzz9" id="1"]\n';
  const actions = actionsFor(src);
  const fix = actions.find((a) => a.title.toLowerCase().includes('remove'));
  assert.ok(fix);
  const edit = fix.edit.changes[URI][0];
  assert.equal(edit.newText, '');
});

test('undeclared ext ref yields a nearest-id replacement', () => {
  const src = '[gd_scene format=3]\n\n[ext_resource type="Script" path="res://art/player.png" id="1_aaaa"]\n\n[node name="R" type="Node"]\nscript = ExtResource("1_aaab")\n';
  const actions = actionsFor(src);
  const fix = actions.find((a) => a.title.includes('1_aaaa'));
  assert.ok(fix);
  assert.equal(fix.edit.changes[URI][0].newText, '1_aaaa');
});

test('load-steps mismatch yields a corrective edit', () => {
  const src = '[gd_scene load_steps=9 format=3]\n\n[ext_resource type="Script" path="res://art/player.png" id="1"]\n';
  const actions = actionsFor(src);
  const fix = actions.find((a) => a.title.includes('load_steps'));
  assert.ok(fix);
  assert.equal(fix.edit.changes[URI][0].newText, '1');
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/resource-lsp/fixes.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement fixes.js**

```js
// src/resource-lsp/fixes.js
'use strict';

function distance(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return dp[m][n];
}

function rangesOverlap(a, b) {
  // line + character aware: true unless a is entirely before/after b
  const aBeforeB = a.end.line < b.start.line
    || (a.end.line === b.start.line && a.end.character < b.start.character);
  const bBeforeA = b.end.line < a.start.line
    || (b.end.line === a.start.line && b.end.character < a.start.character);
  return !(aBeforeB || bBeforeA);
}

function replaceAction(title, uri, range, newText) {
  return {
    title,
    kind: 'quickfix',
    edit: { changes: { [uri]: [{ range, newText }] } },
  };
}

// doc: GodotResourceDocument, diagnostics: Diagnostic[], selRange: Range, project, uri
function computeCodeActions(doc, diagnostics, selRange, project, uri) {
  const actions = [];

  for (const d of diagnostics) {
    if (!rangesOverlap(d.range, selRange)) continue;

    if (d.code === 'ext-file-missing' && d.data && d.data.suggestions) {
      for (const sug of d.data.suggestions) {
        actions.push(replaceAction(`Replace path with ${sug}`, uri, d.range, sug));
      }
    }

    if (d.code === 'invalid-uid') {
      // Find the ext_resource whose uid value range equals d.range; delete the whole `uid="..."`.
      // Delete EXACTLY attrFullRange.uid (no left extension): extending left can eat an
      // adjacent attribute's quote on malformed mid-edit input. A leftover double space
      // is harmless (Godot is whitespace-tolerant).
      const ext = doc.extResources.find((e) => e.section.attrValueRange.uid
        && e.section.attrValueRange.uid.start.line === d.range.start.line
        && e.section.attrValueRange.uid.start.character === d.range.start.character);
      if (ext) {
        actions.push(replaceAction('Remove invalid uid attribute', uri, ext.section.attrFullRange.uid, ''));
      }
    }

    if ((d.code === 'undeclared-ext-ref' || d.code === 'undeclared-sub-ref') && d.data) {
      const declared = d.data.declared || [];
      if (declared.length) {
        const best = declared
          .map((id) => ({ id, dist: distance(d.data.id, id) }))
          .sort((a, b) => a.dist - b.dist)[0];
        if (best) actions.push(replaceAction(`Replace with "${best.id}"`, uri, d.range, best.id));
      }
    }

    if (d.code === 'load-steps-mismatch' && d.data && typeof d.data.actual === 'number') {
      actions.push(replaceAction(`Set load_steps to ${d.data.actual}`, uri, d.range, String(d.data.actual)));
    }

    if (d.code === 'duplicate-ext-id' || d.code === 'duplicate-sub-id') {
      // Track claimed ids across the diagnostic loop so a Fix-All on N duplicates
      // proposes N distinct ids instead of all reusing the same next-free id.
      const claimed = d.code === 'duplicate-ext-id' ? claimedExtIds : claimedSubIds;
      let n = 1;
      while (claimed.has(String(n))) n++;
      claimed.add(String(n));
      actions.push(replaceAction(`Renumber id to "${n}" (body references not updated)`, uri, d.range, String(n)));
    }
  }

  return actions;
}

module.exports = { computeCodeActions };
```

- [ ] **Step 4: Run it to verify it passes**

Run: `node --test tests/resource-lsp/fixes.test.js`
Expected: PASS

- [ ] **Step 5: Wire `textDocument/codeAction` into server.js**

In `src/resource-lsp/server.js`, add the require near the others:

```js
const { computeCodeActions } = require('./fixes.js');
```

Add a case in the `switch (msg.method)` block, before `default`:

```js
      case 'textDocument/codeAction': {
        const uri = msg.params.textDocument.uri;
        const selRange = msg.params.range;
        const text = documents.get(uri);
        let actions = [];
        if (text !== undefined) {
          try {
            const doc = buildDocument(tokenize(text));
            const diags = validate(doc, projectFor(uri));
            actions = computeCodeActions(doc, diags, selRange, projectFor(uri), uri);
          } catch (err) {
            process.stderr.write(`[godot-resource] codeAction error: ${err && err.stack}\n`);
          }
        }
        conn.send({ jsonrpc: '2.0', id: msg.id, result: actions });
        return;
      }
```

- [ ] **Step 6: Write a server-level code-action test**

```js
// append to tests/resource-lsp/server-diagnostics.test.js
test('codeAction returns a fix for a missing file', async () => {
  const { PassThrough } = require('node:stream');
  const path = require('node:path');
  const input = new PassThrough();
  const output = new PassThrough();
  const messages = [];
  collect(output, (m) => messages.push(m));
  startServer(input, output);

  const PROJ = path.join(__dirname, 'fixtures', 'proj');
  input.write(frame({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { rootUri: 'file://' + PROJ, capabilities: {} } }));
  const uri = 'file://' + path.join(PROJ, 's.tscn');
  const text = '[gd_scene format=3]\n\n[ext_resource type="Texture2D" path="res://art/palyer.png" id="1"]\n';
  input.write(frame({ jsonrpc: '2.0', method: 'textDocument/didOpen', params: { textDocument: { uri, languageId: 'godot-resource', version: 1, text } } }));
  await new Promise((r) => setTimeout(r, 80));
  input.write(frame({ jsonrpc: '2.0', id: 2, method: 'textDocument/codeAction',
    params: { textDocument: { uri }, range: { start: { line: 2, character: 0 }, end: { line: 2, character: 80 } }, context: { diagnostics: [] } } }));
  await new Promise((r) => setTimeout(r, 80));

  const resp = messages.find((m) => m.id === 2);
  assert.ok(resp);
  assert.ok(resp.result.some((a) => a.title.includes('res://art/player.png')));
});
```

- [ ] **Step 7: Run the full suite**

Run: `node --test tests/resource-lsp/`
Expected: all PASS

- [ ] **Step 8: Commit**

```bash
git add src/resource-lsp/fixes.js src/resource-lsp/server.js tests/resource-lsp/fixes.test.js tests/resource-lsp/server-diagnostics.test.js
git commit -m "feat: code actions (did-you-mean, strip uid, renumber, fix load_steps)"
```

---

## Task 9: Register the LSP, update README, manual end-to-end in real Godot project

**Files:**
- Modify: `.lsp.json`
- Modify: `.claude-plugin/plugin.json` (bump version)
- Modify: `.claude-plugin/marketplace.json` (bump version)
- Modify: `README.md`

- [ ] **Step 1: Add the second server to `.lsp.json`**

Replace the contents of `.lsp.json` with:

```json
{
  "gdscript": {
    "command": "node",
    "args": ["${CLAUDE_PLUGIN_ROOT}/bin/godot-lsp-bridge.js"],
    "extensionToLanguage": {
      ".gd": "gdscript",
      ".gdshader": "gdshader",
      ".gdshaderinc": "gdshader"
    },
    "transport": "stdio",
    "startupTimeout": 45000,
    "shutdownTimeout": 5000,
    "maxRestarts": 3
  },
  "godot-resource": {
    "command": "node",
    "args": ["${CLAUDE_PLUGIN_ROOT}/bin/godot-resource-lsp.js"],
    "extensionToLanguage": {
      ".tscn": "godot-resource",
      ".tres": "godot-resource"
    },
    "transport": "stdio",
    "startupTimeout": 10000,
    "shutdownTimeout": 3000,
    "maxRestarts": 3
  }
}
```

- [ ] **Step 2: Validate the manifests**

Run: `claude plugin validate /Users/stephanmielke/git/cc-gd-lsp`
Expected: `✔ Validation passed`

- [ ] **Step 3: Manual end-to-end against a real project**

```bash
# Create a project with a deliberately broken scene
mkdir -p /tmp/gd-res-test/art
printf 'config_version=5\n[application]\nconfig/name="T"\n' > /tmp/gd-res-test/project.godot
printf 'extends Node\n' > /tmp/gd-res-test/player.gd
cat > /tmp/gd-res-test/broken.tscn <<'EOF'
[gd_scene load_steps=9 format=3 uid="uid://zzz9"]

[ext_resource type="Script" path="res://palyer.gd" id="1"]

[node name="Root" type="Node"]
script = ExtResource("2")
EOF

# Drive the LSP directly and confirm diagnostics
node - <<'EOF'
const { spawn } = require('node:child_process');
const path = '/Users/stephanmielke/git/cc-gd-lsp/bin/godot-resource-lsp.js';
const srv = spawn('node', [path], { stdio: ['pipe', 'pipe', 'inherit'] });
const frame = (o) => { const b = JSON.stringify(o); return `Content-Length: ${Buffer.byteLength(b)}\r\n\r\n${b}`; };
let buf = Buffer.alloc(0);
srv.stdout.on('data', (c) => {
  buf = Buffer.concat([buf, c]);
  while (true) {
    const he = buf.indexOf('\r\n\r\n'); if (he === -1) return;
    const m = /Content-Length:\s*(\d+)/i.exec(buf.slice(0, he)); if (!m) return;
    const len = +m[1]; if (buf.length < he + 4 + len) return;
    const msg = JSON.parse(buf.slice(he + 4, he + 4 + len)); buf = buf.slice(he + 4 + len);
    if (msg.method === 'textDocument/publishDiagnostics')
      console.log('DIAGS:', msg.params.diagnostics.map((d) => `${d.code}(${d.severity})`).join(', '));
  }
});
const fs = require('node:fs');
const uri = 'file:///tmp/gd-res-test/broken.tscn';
const text = fs.readFileSync('/tmp/gd-res-test/broken.tscn', 'utf8');
srv.stdin.write(frame({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { rootUri: 'file:///tmp/gd-res-test', capabilities: {} } }));
srv.stdin.write(frame({ jsonrpc: '2.0', method: 'textDocument/didOpen', params: { textDocument: { uri, languageId: 'godot-resource', version: 1, text } } }));
setTimeout(() => { srv.kill(); }, 600);
EOF
```

Expected output line similar to:
`DIAGS: invalid-uid(2), undeclared-ext-ref(1), ext-file-missing(1), load-steps-mismatch(3)`

If the codes do not appear, debug before continuing — do not claim success without this output.

- [ ] **Step 4: Update README.md**

Add a new section after the existing "What you get" section:

````markdown
## Resource & scene validation (.tscn / .tres)

In addition to the GDScript language server, this plugin ships a second,
zero-dependency language server that statically validates Godot text scenes
(`.tscn`) and resources (`.tres`). It needs no running Godot instance.

It reports, with fix suggestions where possible:

| Check | Severity | Fix offered |
|---|---|---|
| Referenced `ext_resource` file does not exist on disk | Error | "Did you mean res://…?" |
| `ExtResource("id")` / `SubResource("id")` id not declared in the file | Error | Nearest declared id |
| Missing required tag attributes (`path`/`type`/`id`, connection fields, …) | Error | — |
| `[resource]` in a `.tscn` / `[node]` in a `.tres` | Error | — |
| `format` newer than this Godot supports | Error | — |
| Invalid `uid://…` | Warning | Remove the uid attribute |
| Duplicate `ext_resource` / `sub_resource` id | Warning | Renumber |
| `load_steps` does not match the resource count | Info | Correct the number |

**Accuracy:** the validator mirrors the structural rules of Godot's own text
parser (`resource_format_text.cpp`), so it does not produce false positives on
valid files. Property/type-level validation (which Godot only performs at scene
instantiation) is **not** done statically — that is planned as an optional
Godot-backed deep-check in a future version. Binary `.scn`/`.res` files and
`project.godot` are out of scope.
````

- [ ] **Step 5: Bump version to 0.2.0 in `.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json`**

In both files change `"version": "0.1.0"` to `"version": "0.2.0"`.

- [ ] **Step 6: Commit**

```bash
git add .lsp.json .claude-plugin/plugin.json .claude-plugin/marketplace.json README.md
git commit -m "feat: register godot-resource LSP, document it, bump to 0.2.0"
```

---

## Task 10: Final verification + reinstall

**Files:** none (verification only)

- [ ] **Step 1: Run the entire test suite**

Run: `node --test tests/resource-lsp/`
Expected: all tests PASS, exit code 0

- [ ] **Step 2: Syntax-check both entrypoints**

Run: `node --check bin/godot-lsp-bridge.js && node --check bin/godot-resource-lsp.js && echo OK`
Expected: `OK`

- [ ] **Step 3: Validate and reinstall the plugin from the local marketplace**

```bash
claude plugin validate /Users/stephanmielke/git/cc-gd-lsp
claude plugin marketplace update cc-gd-lsp
claude plugin uninstall gdscript-lsp@cc-gd-lsp
claude plugin install gdscript-lsp@cc-gd-lsp
claude plugin details gdscript-lsp@cc-gd-lsp
```

Expected: `details` lists **2** LSP servers (`gdscript`, `godot-resource`).

- [ ] **Step 4: Confirm the installed copy matches the working tree**

```bash
INSTALLED=$(find ~/.claude/plugins/cache/cc-gd-lsp -name godot-resource-lsp.js | head -1)
diff -q "$INSTALLED" bin/godot-resource-lsp.js && echo "MATCH" || echo "DRIFT"
```

Expected: `MATCH`

- [ ] **Step 5: Clean up the temporary test project**

```bash
rm -rf /tmp/gd-res-test
```

- [ ] **Step 6: Final commit if anything changed (e.g. version-synced files)**

```bash
git status
# if clean, nothing to do; otherwise:
# git add -A && git commit -m "chore: finalize godot-resource LSP v0.2.0"
```

---

## Self-Review (completed during planning)

**Spec coverage:** static validation of `.tscn`/`.tres` (Tasks 2–7), accuracy via Godot ground-truth rules (Task 5 severity table), fix suggestions incl. "did you mean" (Task 8), LSP packaging alongside the existing bridge (Tasks 1, 9). v2 Godot deep-check is explicitly deferred (documented in Task 9 README). All covered.

**Placeholder scan:** every code step contains complete, runnable code; every run step has an exact command + expected output. No TBDs.

**Type consistency:** `Section`, `GodotResourceDocument`, `Diagnostic`, and the diagnostic `code` strings are defined once in "Data Model & Conventions" and used identically across `tokenizer.js`, `document.js`, `validate.js`, `fixes.js`, and `server.js`. `findSimilarFiles(resPath, max)`, `fileExists(resPath)`, `computeCodeActions(doc, diagnostics, selRange, project, uri)`, and `validate(doc, project)` signatures match between definitions, tests, and call sites.

**Known v1 limitations (intentional, documented):** no property/type checking; forward-reference ordering not detected (only "declared nowhere" is flagged); binary `.scn`/`.res` and `project.godot` out of scope. These are the deliberate accuracy boundaries from the research, not gaps.
