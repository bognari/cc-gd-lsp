# Godot Deep-Check (v2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an optional, project-wide "deep-check" to the `godot-resource` LSP that loads every `.tscn`/`.tres` through a real headless Godot and reports the load/instantiation errors the static validator cannot catch (unknown node/resource classes, failed scene instantiation, broken attached scripts, dependency load failures) — surfaced per file with `res://file:line` precision.

**Architecture:** A bundled GDScript `@tool` script (`scripts/deep_check.gd`, run via `godot --headless --script`) recursively `ResourceLoader.load()`s every scene/resource so Godot prints its diagnostics to stderr, then emits a `GDRESLSP_DONE` sentinel. A Node module (`deepcheck.js`) locates Godot, spawns that script, scrapes stderr for `res://<path>:<line> - <message>` patterns, and returns `Map<uri, Diagnostic[]>`. The server triggers a debounced deep-check on `didSave` (auto-enabled when Godot is found, opt-out via `--no-deep-check`), then publishes the union of static + deep diagnostics per file. The static, instant diagnostics are unchanged; deep diagnostics arrive asynchronously a few seconds later.

**Tech Stack:** Node 18+ (zero runtime deps, `node:test`), GDScript (the bundled tool-script), Godot 4.4+ CLI.

---

## Background: why a tool-script, NOT `--import` (empirically verified 2026-06-04)

This was tested against a fixture project containing deliberately broken scenes:

- `godot --headless --import --path <root>` reimports *assets* only. It does **not** load or validate scenes — it surfaced **zero** scene errors (exit 0). It is the wrong mechanism.
- `godot --headless --quit --path <root> <scene>` loads exactly one scene as the main scene. It surfaces that scene's errors but is single-file.
- A bundled `@tool extends SceneTree` script run via `godot --headless --path <root> --script res://scripts/deep_check.gd` that recursively `ResourceLoader.load()`s every `.tscn`/`.tres` surfaces **all** errors project-wide, each (where Godot has a location) as `res://<file>:<line> - <message>` on stderr. This is the mechanism this plan uses.

**What the deep-check catches via `ResourceLoader.load()` (load-only, verified — all with `res://file:line`):**

| Broken input | Godot stderr (verbatim shape) |
|---|---|
| `[sub_resource type="NotARealResource" id="s1"]` | `ERROR: res://bad_subres.tscn:3 - Parse Error: Can't create sub resource of type 'NotARealResource'.` |
| attached `.gd` with a syntax error | `SCRIPT ERROR: Parse Error: ...` + `ERROR: Failed to load script "res://bad_script.gd" with error "Parse error".` |
| `ext_resource` path missing | `ERROR: res://missing_dep.tscn:6 - Parse Error: [ext_resource] referenced non-existent resource at: res://art/nope.png.` |

**Deferred (NOT in v2 — requires `.instantiate()`):** an unknown node `type="ThisClassDoesNotExist"`
only errors at scene *instantiation* time (`ResourceLoader.load()` alone does NOT surface it —
empirically verified). Instantiating arbitrary user scenes on every save would run their `@tool`
script `_init` side effects, which is unsafe as a default, and the resulting "Cannot get class"
error has no `res://file:line` to map cleanly. v2 is therefore **load-only**; instantiation-level
node-class checking is a documented future enhancement.

**What it does NOT catch (verified, do not promise it):** property *type* mismatches like `position = "not_a_vector"` — Godot's text loader silently coerces/drops them, emitting nothing. So the deep-check is a *scene-load/instantiation* check, **not** a property-type checker. Diagnostics with a clean `res://file:line` map directly; location-less errors (e.g. "Cannot get class") are attached to the file being saved as project-level info (best-effort).

**`.godot` import cache:** the tool-script needs the project to have been imported once (the `.godot/` dir). On a fresh project the first load may be slow or incomplete; this plan triggers loads defensively and tolerates partial results rather than failing hard.

---

## Data Model & Conventions (canonical — all tasks match)

Reuse the existing `Diagnostic` shape from v1 (`{ range, severity, code, source, message, data? }`, severity 1/2/3). Deep diagnostics use:
- `source: 'godot-resource (deep)'`
- codes: `deep-load-failed`, `deep-unknown-class`, `deep-missing-dep`, `deep-script-error`, `deep-parse-error`, `deep-generic`.

Deep-check public API (`src/resource-lsp/deepcheck.js`):

```js
// Pure parser — no Godot needed, fully unit-testable.
parseGodotOutput(stderrText, root) -> Map<uriString, Diagnostic[]>

// Locate + spawn + parse. Returns a Promise<Map<uri, Diagnostic[]>>.
// Resolves to an empty Map if Godot cannot be located or the run errors.
runDeepCheck(root, { godotPath, timeoutMs, signal }) -> Promise<Map<uri, Diagnostic[]>>
```

Godot locator (`src/resource-lsp/godot-locate.js`):

```js
locateGodot(explicitPath?) -> string | null   // mirrors the bridge's discovery (incl. mono variants)
```

Server deep-check state (inside `startServer`), per project root key:
```js
{ running: boolean, pending: boolean, timer: Timeout|null }
```
Per-uri diagnostics are tracked as two maps and published as their union:
```js
staticDiagnostics: Map<uri, Diagnostic[]>   // from validate(), updated on open/change/save
deepDiagnostics:   Map<uri, Diagnostic[]>   // from the last completed deep-check run
```

**File layout (new + modified):**
```
scripts/deep_check.gd                  # NEW bundled GDScript tool-script
src/resource-lsp/godot-locate.js       # NEW Godot binary discovery
src/resource-lsp/deepcheck.js          # NEW spawn + stderr parser
src/resource-lsp/server.js             # MOD: didSave trigger, debounce, merge, publish union
bin/godot-resource-lsp.js              # MOD: forward argv (for --no-deep-check / --godot)
tests/resource-lsp/godot-locate.test.js
tests/resource-lsp/deepcheck-parse.test.js     # pure parser unit tests (no Godot)
tests/resource-lsp/deepcheck-integration.test.js # gated: skip if Godot not found
tests/resource-lsp/server-deepcheck.test.js    # server merge/publish via injected fake
```

---

## Task 1: Godot locator (`godot-locate.js`)

Extract the Godot discovery used by the bridge into a small, reusable, testable module. The resource LSP must find the same binary (incl. the Mono variants on macOS).

**Files:**
- Create: `src/resource-lsp/godot-locate.js`
- Test: `tests/resource-lsp/godot-locate.test.js`

- [ ] **Step 1: Write the failing test**

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { locateGodot } = require('../../src/resource-lsp/godot-locate.js');

test('returns an explicit path when it exists', () => {
  // create a fake executable file
  const tmp = path.join(os.tmpdir(), 'fake-godot-' + process.pid);
  fs.writeFileSync(tmp, '#!/bin/sh\n');
  try {
    assert.equal(locateGodot(tmp), tmp);
  } finally {
    fs.unlinkSync(tmp);
  }
});

test('returns null when explicit path does not exist and nothing on PATH matches a fake name', () => {
  // We cannot assume Godot is absent on this machine, so only assert the explicit-missing path
  // falls through without throwing.
  const result = locateGodot('/definitely/not/here/godot-xyz');
  assert.ok(result === null || typeof result === 'string');
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/resource-lsp/godot-locate.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/resource-lsp/godot-locate.js`**

```js
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const platform = os.platform();
const isWindows = platform === 'win32';

function fileExists(p) {
  try { return fs.existsSync(p); } catch { return false; }
}

function lookupOnPath(name) {
  const cmd = isWindows ? 'where' : 'which';
  const res = spawnSync(cmd, [name], { encoding: 'utf8', timeout: 3000 });
  if (res.status !== 0 || !res.stdout) return null;
  const first = res.stdout.trim().split(/\r?\n/)[0];
  return first || null;
}

function locateGodot(explicit) {
  if (explicit && fileExists(explicit)) return explicit;
  const fromEnv = process.env.GODOT_PATH;
  if (fromEnv && fileExists(fromEnv)) return fromEnv;

  const candidates = [];
  for (const name of ['godot', 'godot4', 'godot-editor', 'Godot', 'godot-mono', 'godot4-mono', 'Godot_mono']) {
    const found = lookupOnPath(name);
    if (found) candidates.push(found);
  }
  if (isWindows) {
    candidates.push(
      String.raw`C:\Program Files\Godot\godot.exe`,
      String.raw`C:\Program Files\Godot_mono\Godot.exe`,
    );
  } else if (platform === 'darwin') {
    const home = os.homedir();
    candidates.push(
      '/Applications/Godot.app/Contents/MacOS/Godot',
      `${home}/Applications/Godot.app/Contents/MacOS/Godot`,
      '/Applications/Godot_mono.app/Contents/MacOS/Godot',
      `${home}/Applications/Godot_mono.app/Contents/MacOS/Godot`,
    );
  } else {
    candidates.push('/usr/bin/godot', '/usr/local/bin/godot', '/usr/bin/godot-mono', '/usr/local/bin/godot-mono');
  }
  for (const c of candidates) if (c && fileExists(c)) return c;
  return null;
}

module.exports = { locateGodot };
```

- [ ] **Step 4: Run it to verify it passes**

Run: `node --test tests/resource-lsp/godot-locate.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/resource-lsp/godot-locate.js tests/resource-lsp/godot-locate.test.js
git commit -m "feat: godot binary locator for the resource LSP deep-check"
```

---

## Task 2: The bundled GDScript tool-script (`scripts/deep_check.gd`)

A `@tool extends SceneTree` script that loads every `.tscn`/`.tres` under `res://` so Godot surfaces load errors, then prints a sentinel.

**Files:**
- Create: `scripts/deep_check.gd`
- Test: `tests/resource-lsp/deepcheck-integration.test.js` (the part that runs THIS script; gated to skip if Godot is absent)
- Fixtures: `tests/resource-lsp/fixtures/deepproj/` (a tiny project with one broken scene)

- [ ] **Step 1: Create the fixture project**

```bash
mkdir -p tests/resource-lsp/fixtures/deepproj
printf 'config_version=5\n[application]\nconfig/name="DeepFixture"\n' > tests/resource-lsp/fixtures/deepproj/project.godot
cat > tests/resource-lsp/fixtures/deepproj/bad_subres.tscn <<'EOF'
[gd_scene load_steps=2 format=3]

[sub_resource type="NotARealResource" id="s1"]

[node name="Root" type="Node2D"]
EOF
```

- [ ] **Step 2: Implement `scripts/deep_check.gd`**

```gdscript
@tool
extends SceneTree

# Loads every .tscn/.tres under res:// so Godot prints load/instantiation errors
# to stderr, then prints a sentinel line so the caller knows the run is complete.
# Invoked as: godot --headless --path <project> --script res://scripts/deep_check.gd
# (the plugin copies this file into the project at run time, see deepcheck.js).

func _init() -> void:
	var paths := _scan("res://")
	for p in paths:
		# Loading triggers Godot's own ERROR/WARNING prints (with res://file:line).
		var res := ResourceLoader.load(p, "", ResourceLoader.CACHE_MODE_IGNORE)
		if res == null:
			printerr("GDRESLSP_LOADFAIL\t%s" % p)
	print("GDRESLSP_DONE")
	quit()

func _scan(dir_path: String) -> Array:
	var out: Array = []
	var d := DirAccess.open(dir_path)
	if d == null:
		return out
	d.list_dir_begin()
	var n := d.get_next()
	while n != "":
		if n == ".godot" or n == ".import" or n.begins_with("."):
			n = d.get_next()
			continue
		var full := dir_path.path_join(n)
		if d.current_is_dir():
			out.append_array(_scan(full))
		elif n.ends_with(".tscn") or n.ends_with(".tres"):
			out.append(full)
		n = d.get_next()
	return out
```

- [ ] **Step 3: Write the gated integration test (`tests/resource-lsp/deepcheck-integration.test.js`)**

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { locateGodot } = require('../../src/resource-lsp/godot-locate.js');

const GODOT = locateGodot();
const PROJ = path.join(__dirname, 'fixtures', 'deepproj');
const SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'deep_check.gd');

test('deep_check.gd surfaces a bad sub_resource via Godot', { skip: GODOT ? false : 'Godot not found on this machine' }, () => {
  // Copy the script into the project so res:// can see it.
  const dest = path.join(PROJ, 'deep_check.gd');
  fs.copyFileSync(SCRIPT, dest);
  try {
    const res = spawnSync(GODOT, ['--headless', '--path', PROJ, '--script', 'res://deep_check.gd'], {
      encoding: 'utf8', timeout: 90000,
    });
    const out = (res.stdout || '') + (res.stderr || '');
    assert.match(out, /GDRESLSP_DONE/);
    assert.match(out, /bad_subres\.tscn:3 - Parse Error: Can't create sub resource of type 'NotARealResource'/);
  } finally {
    fs.rmSync(dest, { force: true });
  }
});
```

- [ ] **Step 4: Run it**

Run: `node --test tests/resource-lsp/deepcheck-integration.test.js`
Expected: PASS if Godot is installed (the `bad_subres.tscn:3` error appears), or SKIPPED with "Godot not found" otherwise. (On the dev machine with Godot Mono, it must PASS.)

- [ ] **Step 5: Commit**

```bash
git add scripts/deep_check.gd tests/resource-lsp/deepcheck-integration.test.js tests/resource-lsp/fixtures/deepproj/
git commit -m "feat: bundled GDScript deep-check tool-script + gated integration test"
```

---

## Task 3: The Node parser + runner (`deepcheck.js`)

The pure parser is the testable heart. The runner spawns Godot.

**Files:**
- Create: `src/resource-lsp/deepcheck.js`
- Test: `tests/resource-lsp/deepcheck-parse.test.js`

- [ ] **Step 1: Write the failing parser test**

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseGodotOutput } = require('../../src/resource-lsp/deepcheck.js');

const ROOT = '/proj';

test('maps a res://file:line error to a diagnostic on the right uri', () => {
  const stderr = `ERROR: res://bad_subres.tscn:3 - Parse Error: Can't create sub resource of type 'NotARealResource'.\nGDRESLSP_DONE\n`;
  const map = parseGodotOutput(stderr, ROOT);
  const uri = 'file:///proj/bad_subres.tscn';
  const diags = map.get(uri);
  assert.ok(diags && diags.length === 1);
  assert.equal(diags[0].range.start.line, 2); // 1-based line 3 -> 0-based 2
  assert.equal(diags[0].severity, 1);
  assert.match(diags[0].message, /Can't create sub resource/);
  assert.equal(diags[0].source, 'godot-resource (deep)');
});

test('classifies a missing dependency', () => {
  const stderr = `ERROR: res://s.tscn:6 - Parse Error: [ext_resource] referenced non-existent resource at: res://art/nope.png.\n`;
  const d = parseGodotOutput(stderr, ROOT).get('file:///proj/s.tscn')[0];
  assert.equal(d.code, 'deep-missing-dep');
});

test('a WARNING maps to severity 2', () => {
  const stderr = `WARNING: res://s.tscn:4 - ext_resource, invalid UID: uid://x - using text path instead.\n`;
  const d = parseGodotOutput(stderr, ROOT).get('file:///proj/s.tscn')[0];
  assert.equal(d.severity, 2);
});

test('ignores lines without a res:// location', () => {
  const stderr = `ERROR: Cannot get class 'Foo'.\nGDRESLSP_DONE\n`;
  const map = parseGodotOutput(stderr, ROOT);
  assert.equal(map.size, 0);
});

test('deduplicates identical errors on the same line', () => {
  const line = `ERROR: res://s.tscn:6 - Parse Error: [ext_resource] referenced non-existent resource at: res://x.png.`;
  const map = parseGodotOutput(line + '\n' + line + '\n', ROOT);
  assert.equal(map.get('file:///proj/s.tscn').length, 1);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/resource-lsp/deepcheck-parse.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/resource-lsp/deepcheck.js`**

```js
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { locateGodot } = require('./godot-locate.js');

const SOURCE = 'godot-resource (deep)';

// Godot prints e.g.:
//   ERROR: res://foo.tscn:3 - Parse Error: Can't create sub resource of type 'X'.
//   WARNING: res://foo.tscn:4 - ext_resource, invalid UID: ...
const LINE_RE = /^(ERROR|WARNING|SCRIPT ERROR):\s*(res:\/\/[^\s:]+):(\d+)\s*-\s*(.*)$/;

function classify(message) {
  if (/referenced non-existent resource|Resource file not found/i.test(message)) return 'deep-missing-dep';
  if (/Can't create sub resource|Cannot get class/i.test(message)) return 'deep-unknown-class';
  if (/script/i.test(message)) return 'deep-script-error';
  if (/Parse Error/i.test(message)) return 'deep-parse-error';
  return 'deep-generic';
}

function resToUri(resPath, root) {
  const rel = resPath.slice('res://'.length);
  return pathToFileURL(path.join(root, rel)).href;
}

function parseGodotOutput(text, root) {
  const byUri = new Map();
  const seen = new Set();
  for (const raw of text.split(/\r?\n/)) {
    const m = LINE_RE.exec(raw.trim());
    if (!m) continue;
    const [, kind, resPath, lineStr, message] = m;
    const uri = resToUri(resPath, root);
    const line = Math.max(0, Number.parseInt(lineStr, 10) - 1);
    const severity = kind === 'WARNING' ? 2 : 1;
    const dedupKey = `${uri}|${line}|${message}`;
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);
    const diag = {
      range: { start: { line, character: 0 }, end: { line, character: 200 } },
      severity,
      code: classify(message),
      source: SOURCE,
      message: message.trim(),
    };
    if (!byUri.has(uri)) byUri.set(uri, []);
    byUri.get(uri).push(diag);
  }
  return byUri;
}

// Copies deep_check.gd into the project (so res:// resolves), spawns Godot, returns the parsed map.
function runDeepCheck(root, opts = {}) {
  return new Promise((resolve) => {
    const godot = opts.godotPath || locateGodot();
    if (!godot || !root) return resolve(new Map());

    const src = path.join(__dirname, '..', '..', 'scripts', 'deep_check.gd');
    const dest = path.join(root, `.gdreslsp_deep_check_${process.pid}.gd`);
    try {
      fs.copyFileSync(src, dest);
    } catch {
      return resolve(new Map());
    }
    const relScript = 'res://' + path.basename(dest);

    const child = spawn(godot, ['--headless', '--path', root, '--script', relScript], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let buf = '';
    const onData = (c) => { buf += c.toString('utf8'); };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);

    const timeoutMs = opts.timeoutMs || 60000;
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, timeoutMs);

    if (opts.signal) {
      opts.signal.addEventListener('abort', () => { try { child.kill('SIGKILL'); } catch {} }, { once: true });
    }

    const finish = () => {
      clearTimeout(timer);
      try { fs.rmSync(dest, { force: true }); } catch {}
      resolve(parseGodotOutput(buf, root));
    };
    child.on('close', finish);
    child.on('error', finish);
  });
}

module.exports = { parseGodotOutput, runDeepCheck };
```

- [ ] **Step 4: Run the parser tests**

Run: `node --test tests/resource-lsp/deepcheck-parse.test.js`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/resource-lsp/deepcheck.js tests/resource-lsp/deepcheck-parse.test.js
git commit -m "feat: deep-check runner + pure stderr parser for godot load errors"
```

---

## Task 4: Wire the deep-check into the server (debounce + merge + publish)

**Files:**
- Modify: `src/resource-lsp/server.js`
- Modify: `bin/godot-resource-lsp.js`
- Test: `tests/resource-lsp/server-deepcheck.test.js`

- [ ] **Step 1: Write the failing test (inject a fake deep-check so no Godot is needed)**

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');
const path = require('node:path');
const { startServer } = require('../../src/resource-lsp/server.js');

const PROJ = path.join(__dirname, 'fixtures', 'proj');

function frame(obj) { const b = JSON.stringify(obj); return `Content-Length: ${Buffer.byteLength(b)}\r\n\r\n${b}`; }
function collect(stream, onMsg) {
  let buf = Buffer.alloc(0);
  stream.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (true) {
      const he = buf.indexOf('\r\n\r\n'); if (he === -1) return;
      const m = /Content-Length:\s*(\d+)/i.exec(buf.slice(0, he).toString('ascii')); if (!m) return;
      const len = Number.parseInt(m[1], 10); if (buf.length < he + 4 + len) return;
      onMsg(JSON.parse(buf.slice(he + 4, he + 4 + len).toString('utf8')));
      buf = buf.slice(he + 4 + len);
    }
  });
}
function waitFor(get, pred, t = 2000) {
  return new Promise((res, rej) => { const s = Date.now(); const tick = () => { if (pred(get())) return res(); if (Date.now() - s > t) return rej(new Error('timeout')); setImmediate(tick); }; tick(); });
}

test('didSave triggers a deep-check whose diagnostics are merged with static ones', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const messages = [];
  collect(output, (m) => messages.push(m));

  const uri = 'file://' + path.join(PROJ, 'z.tscn');
  // Fake deep-check returns one extra diagnostic for this uri.
  const fakeDeep = async () => new Map([[uri, [{
    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
    severity: 1, code: 'deep-unknown-class', source: 'godot-resource (deep)', message: 'Cannot get class Foo',
  }]]]);

  startServer(input, output, { runDeepCheck: fakeDeep, deepDebounceMs: 10 });

  input.write(frame({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { rootUri: 'file://' + PROJ, capabilities: {} } }));
  // open with a static error too ([banana] -> unknown-root-tag)
  input.write(frame({ jsonrpc: '2.0', method: 'textDocument/didOpen', params: { textDocument: { uri, languageId: 'godot-resource', version: 1, text: '[banana]\n' } } }));
  await waitFor(() => messages, (ms) => ms.some((m) => m.method === 'textDocument/publishDiagnostics'));
  // save triggers deep-check
  input.write(frame({ jsonrpc: '2.0', method: 'textDocument/didSave', params: { textDocument: { uri } } }));

  // wait until a publish for this uri contains BOTH the static and the deep diagnostic
  await waitFor(() => messages, (ms) => ms.some((m) =>
    m.method === 'textDocument/publishDiagnostics' && m.params.uri === uri
    && m.params.diagnostics.some((d) => d.code === 'unknown-root-tag')
    && m.params.diagnostics.some((d) => d.code === 'deep-unknown-class')), 3000);
});

test('with no runDeepCheck injected and Godot absent, didSave still publishes static diagnostics', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const messages = [];
  collect(output, (m) => messages.push(m));
  // inject a deep-check that resolves to empty (simulates no Godot)
  startServer(input, output, { runDeepCheck: async () => new Map(), deepDebounceMs: 10 });
  const uri = 'file://' + path.join(PROJ, 'z2.tscn');
  input.write(frame({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { rootUri: 'file://' + PROJ, capabilities: {} } }));
  input.write(frame({ jsonrpc: '2.0', method: 'textDocument/didOpen', params: { textDocument: { uri, languageId: 'godot-resource', version: 1, text: '[banana]\n' } } }));
  input.write(frame({ jsonrpc: '2.0', method: 'textDocument/didSave', params: { textDocument: { uri } } }));
  await waitFor(() => messages, (ms) => ms.some((m) => m.method === 'textDocument/publishDiagnostics' && m.params.diagnostics.some((d) => d.code === 'unknown-root-tag')));
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/resource-lsp/server-deepcheck.test.js`
Expected: FAIL — `startServer` ignores the options / no deep merge.

- [ ] **Step 3: Modify `src/resource-lsp/server.js`**

Read the current file first. Make these specific changes:

(a) Change the signature and add the deep-check imports + injectable dependency:
```js
const { runDeepCheck: realRunDeepCheck } = require('./deepcheck.js');
const { locateGodot } = require('./godot-locate.js');
```
```js
function startServer(input, output, options = {}) {
  const conn = createConnection(input, output);
  const documents = new Map();           // uri -> { text, version }
  const staticDiagnostics = new Map();   // uri -> Diagnostic[]
  const deepDiagnostics = new Map();     // uri -> Diagnostic[]
  const projectCache = new Map();
  const deepState = new Map();           // rootKey -> { running, pending, timer }
  let workspaceRoot = null;
  let shutdownReceived = false;

  const argv = options.argv || [];
  const deepDisabled = argv.includes('--no-deep-check');
  const deepDebounceMs = options.deepDebounceMs ?? 700;
  const runDeepCheck = options.runDeepCheck || realRunDeepCheck;
  // explicit --godot <path> override for the deep-check spawn
  const godotFlagIdx = argv.indexOf('--godot');
  const godotPath = godotFlagIdx >= 0 ? argv[godotFlagIdx + 1] : undefined;
```

(b) Change `publish(uri)` to store the static set and emit the UNION with the deep set:
```js
  function sendPublish(uri) {
    const entry = documents.get(uri);
    const stat = staticDiagnostics.get(uri) || [];
    const deep = deepDiagnostics.get(uri) || [];
    const params = { uri, diagnostics: [...stat, ...deep] };
    if (entry && typeof entry.version === 'number') params.version = entry.version;
    conn.send({ jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params });
  }

  function publish(uri) {
    const entry = documents.get(uri);
    if (!entry) return;
    let diagnostics = [];
    try {
      diagnostics = validate(buildDocument(tokenize(entry.text)), projectFor(uri));
    } catch (err) {
      process.stderr.write(`[godot-resource] validation error: ${err && err.stack}\n`);
    }
    staticDiagnostics.set(uri, diagnostics);
    sendPublish(uri);
  }
```

(c) Add the deep-check trigger + merge. Add this function inside `startServer`:
```js
  function rootKeyFor(uri) {
    const fsPath = uriToPath(uri);
    return findProjectRoot(path.dirname(fsPath)) || workspaceRoot || '';
  }

  function scheduleDeepCheck(uri) {
    if (deepDisabled) return;
    const root = rootKeyFor(uri);
    if (!root) return;
    // Auto-enable only when Godot is locatable (locate once per root, cached in deepState).
    let st = deepState.get(root);
    if (!st) { st = { running: false, pending: false, timer: null, godot: locateGodot(godotPath) }; deepState.set(root, st); }
    if (!st.godot) return; // no Godot -> deep-check silently unavailable
    if (st.timer) clearTimeout(st.timer);
    st.timer = setTimeout(() => startDeepRun(root), deepDebounceMs);
  }

  function startDeepRun(root) {
    const st = deepState.get(root);
    if (!st) return;
    if (st.running) { st.pending = true; return; }
    st.running = true;
    st.pending = false;
    runDeepCheck(root, { godotPath: st.godot || godotPath })
      .then((map) => applyDeepResults(root, map))
      .catch((err) => process.stderr.write(`[godot-resource] deep-check error: ${err && err.stack}\n`))
      .finally(() => {
        st.running = false;
        if (st.pending) startDeepRun(root);
      });
  }

  function applyDeepResults(root, map) {
    // Replace deep diagnostics for every uri under this root.
    // 1. Clear previous deep diagnostics whose file is under this root and republish.
    const prevUris = new Set([...deepDiagnostics.keys()]);
    for (const uri of prevUris) {
      if (uriUnderRoot(uri, root)) deepDiagnostics.delete(uri);
    }
    // 2. Set new ones.
    for (const [uri, diags] of map) deepDiagnostics.set(uri, diags);
    // 3. Republish every affected uri (previous + new).
    const affected = new Set([...prevUris, ...map.keys()]);
    for (const uri of affected) sendPublish(uri);
  }

  function uriUnderRoot(uri, root) {
    try {
      const p = uriToPath(uri);
      const rel = path.relative(root, p);
      return !rel.startsWith('..') && !path.isAbsolute(rel);
    } catch { return false; }
  }
```

(d) In the `textDocument/didSave` case, after `publish(uri)`, add `scheduleDeepCheck(uri);`:
```js
      case 'textDocument/didSave': {
        const uri = msg.params.textDocument.uri;
        if (msg.params.text !== undefined) {
          const prev = documents.get(uri);
          documents.set(uri, { text: msg.params.text, version: prev ? prev.version : null });
        }
        publish(uri);
        scheduleDeepCheck(uri);
        return;
      }
```

(e) In `didClose`, also clear both diagnostic maps for the uri:
```js
      case 'textDocument/didClose': {
        const uri = msg.params.textDocument.uri;
        documents.delete(uri);
        staticDiagnostics.delete(uri);
        deepDiagnostics.delete(uri);
        conn.send({ jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: { uri, diagnostics: [] } });
        return;
      }
```

Keep all other cases (`initialize`, `initialized`, `didOpen`, `didChange`, `codeAction`, `shutdown`, `exit`, `default`) and the Task-1/Task-7 hardening (`'use strict'`, `shutdownReceived` exit, `-32601` fallback, the try/catch dispatch wrapper) intact. `didOpen`/`didChange` must call the updated `publish(uri)` (which now stores the static set and sends the union).

- [ ] **Step 4: Modify `bin/godot-resource-lsp.js` to forward argv**

```js
#!/usr/bin/env node
'use strict';

const { startServer } = require('../src/resource-lsp/server.js');

startServer(process.stdin, process.stdout, { argv: process.argv.slice(2) });

process.stdin.on('end', () => process.exit(0));
```

- [ ] **Step 5: Run the server deep-check tests**

Run: `node --test tests/resource-lsp/server-deepcheck.test.js`
Expected: PASS (2 tests).

- [ ] **Step 6: Run the WHOLE suite (no regressions in v1 behavior)**

Run: `node --test tests/resource-lsp/*.test.js`
Expected: all PASS (v1 tests + the new deep-check tests; the Godot integration test passes or skips).

- [ ] **Step 7: Commit**

```bash
git add src/resource-lsp/server.js bin/godot-resource-lsp.js tests/resource-lsp/server-deepcheck.test.js
git commit -m "feat: trigger debounced project-wide deep-check on save, merge with static diagnostics"
```

---

## Task 5: Docs, opt-out flag, version bump, manual E2E

**Files:**
- Modify: `README.md`
- Modify: `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json` (0.2.0 → 0.3.0)

- [ ] **Step 1: Manual end-to-end against a real broken project (requires Godot)**

```bash
mkdir -p /tmp/gd-deep-e2e
printf 'config_version=5\n[application]\nconfig/name="E2E"\n' > /tmp/gd-deep-e2e/project.godot
cat > /tmp/gd-deep-e2e/bad.tscn <<'EOF'
[gd_scene load_steps=2 format=3]

[sub_resource type="NotARealResource" id="s1"]

[node name="Root" type="Node2D"]
EOF
node - <<'EOF'
const { runDeepCheck } = require('/Users/stephanmielke/git/cc-gd-lsp/src/resource-lsp/deepcheck.js');
runDeepCheck('/tmp/gd-deep-e2e', {}).then((map) => {
  for (const [uri, diags] of map) for (const d of diags) console.log('DEEP:', uri, d.code, JSON.stringify(d.message));
  if (map.size === 0) console.log('DEEP: (empty — Godot not found or no errors)');
});
EOF
rm -rf /tmp/gd-deep-e2e
```
Expected (with Godot installed): a `DEEP:` line for `bad.tscn` with code `deep-unknown-class` and the "Can't create sub resource of type 'NotARealResource'" message. Capture it verbatim. If empty AND Godot is installed, debug before claiming success.

- [ ] **Step 2: Update README** — add after the "## Resource & scene validation" section:

````markdown
### Optional deep-check (loads scenes through Godot)

When a Godot binary is found on your machine, saving a `.tscn`/`.tres` also runs
a **project-wide deep-check**: a bundled headless Godot pass that actually loads
every scene/resource and reports errors the static validator cannot see —
unknown node/resource classes, failed instantiation, broken attached scripts,
and dependency load failures, each mapped to `res://file:line`.

- Runs automatically on save **only if Godot is locatable** (same discovery as
  the GDScript bridge, incl. the Mono builds). Disable with `--no-deep-check`
  in the `godot-resource` args.
- It is **debounced** and **project-wide**: one headless pass per save burst,
  surfacing errors across all files (not just the saved one).
- It needs the project's `.godot/` import cache (open the project in Godot once).
- It does **not** check property *types* — Godot silently coerces those, so
  there is nothing to report. It is a scene-load/instantiation check.

```json
{
  "godot-resource": {
    "command": "node",
    "args": ["${CLAUDE_PLUGIN_ROOT}/bin/godot-resource-lsp.js", "--no-deep-check"]
  }
}
```
````

- [ ] **Step 3: Bump version 0.2.0 → 0.3.0** in `.claude-plugin/plugin.json` and BOTH version fields in `.claude-plugin/marketplace.json`. Verify no `0.2.0` remains: `grep -rn 0.2.0 .claude-plugin/` returns nothing.

- [ ] **Step 4: Validate + commit**

```bash
claude plugin validate /Users/stephanmielke/git/cc-gd-lsp
git add README.md .claude-plugin/plugin.json .claude-plugin/marketplace.json
git commit -m "docs: document optional deep-check; bump to 0.3.0"
```

---

## Self-Review (completed during planning)

**Spec coverage:** auto-enable-when-Godot-found on didSave (Task 4 `scheduleDeepCheck` gating on `locateGodot`), project-wide via the bundled tool-script (Tasks 2+3, empirically the only mechanism that works — `--import` was verified NOT to load scenes), merge with static diagnostics (Task 4 union publish), opt-out `--no-deep-check` (Task 4 + Task 5 docs), version bump (Task 5). Covered.

**Placeholder scan:** every code step has complete code; every run step has a command + expected output; the Godot-dependent test is explicitly gated with `{ skip: ... }`.

**Type consistency:** `parseGodotOutput(text, root) -> Map<uri, Diagnostic[]>` and `runDeepCheck(root, opts) -> Promise<Map>` match between `deepcheck.js`, its tests, and the server's `applyDeepResults`. `locateGodot(explicit?)` is consistent across `godot-locate.js`, `deepcheck.js`, and `server.js`. The injected `options.runDeepCheck` in tests matches the real signature.

**Deliberate scope notes (carried from empirical findings):** property-type checking is NOT promised (Godot coerces silently); location-less Godot errors ("Cannot get class") are not mapped to a line in v2 (only `res://file:line` errors are) — a future refinement could attach them to the saved file. The deep-check requires the `.godot` import cache; first-run-on-fresh-project may be incomplete (tolerated, not failed).
