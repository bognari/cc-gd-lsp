# Resource LSP Polish Improvements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Four independent hardening/robustness improvements to the `godot-resource` LSP flagged by the v1 reviews: a non-blocking async file walk, a bounded project cache, scanning header-attribute references (a v1 false-negative gap), and not treating `ExtResource(...)` text inside quoted string values as a real reference.

**Architecture:** Four small, mutually independent changes across `project.js`, `server.js`, and `document.js`. Each is its own task with its own test and commit; they can be implemented and reviewed in any order.

**Tech Stack:** Node 18+ (zero runtime deps, `node:test`).

---

## Background

All four items were surfaced by the v1 Opus + Gemini reviews and deferred as non-blocking. None changes the public diagnostic behavior except item 3 (header-inline references), which *adds* detection that was previously a silent false-negative (never a false-positive, so it is safe). Item 4 (string-literal guard) *removes* a rare potential false-positive.

These do not depend on the deep-check plan (`2026-06-04-godot-deep-check.md`) and can land before or after it.

---

## Task 1: Async, non-blocking project file walk

`project.js:listAllFiles` uses synchronous `fs.readdirSync` recursion, which blocks the LSP event loop on the first `findSimilarFiles` call in a large project. Convert the walk to `fs.promises` and make `findSimilarFiles` async-aware via a pre-warmed cache, WITHOUT changing the synchronous `findSimilarFiles(resPath, max) -> string[]` signature that `validate.js` relies on.

**Approach:** keep `findSimilarFiles` synchronous (validate.js calls it synchronously), but populate the file index in the background. On `createProject(root)`, kick off an async walk that fills `fileCache`. Until it completes, `findSimilarFiles` returns `[]` (no suggestion yet) instead of blocking. A synchronous fallback walk is removed.

**Files:**
- Modify: `src/resource-lsp/project.js`
- Test: `tests/resource-lsp/project.test.js`

- [ ] **Step 1: Write the failing test**

```js
// append to tests/resource-lsp/project.test.js
test('findSimilarFiles works once the async index has warmed', async () => {
  const project = createProject(PROJ);
  // index warms asynchronously; poll briefly
  let hits = [];
  for (let i = 0; i < 50 && hits.length === 0; i++) {
    hits = project.findSimilarFiles('res://art/palyer.png', 3);
    if (hits.length) break;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.ok(hits.includes('res://art/player.png'));
});

test('findSimilarFiles returns [] (never throws) before the index is ready', () => {
  const project = createProject(PROJ);
  // immediately after creation the cache may be empty; must not throw and must return an array
  const hits = project.findSimilarFiles('res://art/palyer.png', 3);
  assert.ok(Array.isArray(hits));
});
```

- [ ] **Step 2: Run it to verify the async warm test fails initially**

Run: `node --test tests/resource-lsp/project.test.js`
Expected: the existing synchronous `findSimilarFiles` test still passes, but confirm the new async-warm test passes too only after the implementation change. (With the current synchronous walk it will already pass; that's fine — proceed to make the walk async and confirm it still passes.)

- [ ] **Step 3: Replace the walk in `src/resource-lsp/project.js`**

Replace `listAllFiles` (the synchronous version) and the `createProject` cache logic with an async-warmed cache:

```js
const fsp = require('node:fs/promises');

async function listAllFilesAsync(root) {
  const out = [];
  const SKIP = new Set(['.godot', '.git', '.import', 'node_modules']);
  async function walk(dir) {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (SKIP.has(e.name)) continue;
        await walk(path.join(dir, e.name));
      } else if (e.isFile()) {
        const rel = path.relative(root, path.join(dir, e.name)).split(path.sep).join('/');
        out.push('res://' + rel);
      }
    }
  }
  await walk(root);
  return out;
}
```

In `createProject(root)`, replace the time-based synchronous `files()` with a background warm:

```js
function createProject(root) {
  let fileCache = [];
  let warming = false;
  let lastWarm = 0;
  const TTL_MS = 5000;

  function warm() {
    if (!root || warming) return;
    const now = Date.now();
    if (fileCache.length && now - lastWarm < TTL_MS) return;
    warming = true;
    listAllFilesAsync(root)
      .then((files) => { fileCache = files; lastWarm = Date.now(); })
      .catch(() => {})
      .finally(() => { warming = false; });
  }

  if (root) warm(); // kick off on creation

  return {
    root,
    fileExists(resPath) {
      const abs = resToAbs(root, resPath);
      if (!abs) return false;
      try { return fs.existsSync(abs); } catch { return false; }
    },
    findSimilarFiles(resPath, max) {
      if (!root || typeof resPath !== 'string') return [];
      warm(); // refresh in the background if stale; returns immediately
      const targetBase = resPath.split('/').pop().toLowerCase();
      if (!targetBase) return [];
      const threshold = Math.max(2, Math.floor(targetBase.length / 3));
      return fileCache
        .map((f) => ({ f, d: distance(targetBase, f.split('/').pop().toLowerCase()) }))
        .filter((x) => x.d <= threshold)
        .sort((a, b) => a.d - b.d)
        .slice(0, max)
        .map((x) => x.f);
    },
  };
}
```

Keep `fs` (sync) imported for `fileExists`/`findProjectRoot`; add `fsp` for the walk. `findProjectRoot` and `resToAbs` are unchanged.

- [ ] **Step 4: Run the suite**

Run: `node --test tests/resource-lsp/*.test.js`
Expected: all PASS. The existing project tests and the new async-warm test pass. (Note: the `validate-project` test that asserts a suggestion may now race the warm — if it becomes flaky, the test should poll like the new test does. If it fails, update THAT test to poll for the warm, do not revert the async change.)

- [ ] **Step 5: Commit**

```bash
git add src/resource-lsp/project.js tests/resource-lsp/project.test.js
git commit -m "perf: warm the project file index asynchronously instead of blocking readdirSync"
```

> **Note for the implementer:** if `tests/resource-lsp/validate-project.test.js`'s "missing ext_resource file is flagged with a suggestion" test becomes flaky because the index hasn't warmed synchronously, convert that one assertion to poll (same pattern as Task 1 Step 1) and include it in this commit. The suggestion is a "did you mean" hint; the `ext-file-missing` ERROR itself does not depend on the index and stays synchronous.

---

## Task 2: Bound the per-root project cache

`server.js` keeps `projectCache: Map<root, project>` that grows unbounded across a long multi-root session. Cap it with simple LRU eviction.

**Files:**
- Modify: `src/resource-lsp/server.js`
- Test: `tests/resource-lsp/server-diagnostics.test.js`

- [ ] **Step 1: Write the failing test**

```js
// append to tests/resource-lsp/server-diagnostics.test.js
const { startServer } = require('../../src/resource-lsp/server.js');
test('projectFor evicts the least-recently-used root beyond the cap', () => {
  // White-box: call the exported helper if present. We test via the returned handle.
  const { PassThrough } = require('node:stream');
  const input = new PassThrough();
  const output = new PassThrough();
  const handle = startServer(input, output, { projectCacheMax: 2 });
  assert.ok(handle.__projectCacheSize);
  handle.__touchProject('/a');
  handle.__touchProject('/b');
  handle.__touchProject('/c'); // should evict /a
  assert.equal(handle.__projectCacheSize(), 2);
  assert.equal(handle.__hasProject('/a'), false);
  assert.equal(handle.__hasProject('/c'), true);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/resource-lsp/server-diagnostics.test.js`
Expected: FAIL — the test helpers and the cap don't exist.

- [ ] **Step 3: Implement LRU in `src/resource-lsp/server.js`**

Add a cap option and LRU touch logic. Replace the `projectFor` definition with:

```js
  const projectCacheMax = options.projectCacheMax ?? 8;
  const projectCache = new Map(); // insertion order = LRU order

  function touchProject(root) {
    const key = root || '';
    if (projectCache.has(key)) {
      const v = projectCache.get(key);
      projectCache.delete(key);
      projectCache.set(key, v); // move to most-recent
      return v;
    }
    const proj = createProject(root);
    projectCache.set(key, proj);
    while (projectCache.size > projectCacheMax) {
      const oldest = projectCache.keys().next().value;
      projectCache.delete(oldest);
    }
    return proj;
  }

  function projectFor(uri) {
    const fsPath = uriToPath(uri);
    const root = findProjectRoot(path.dirname(fsPath)) || workspaceRoot;
    return touchProject(root);
  }
```

At the end of `startServer`, extend the returned handle with the test hooks:
```js
  return {
    conn,
    documents,
    __projectCacheSize: () => projectCache.size,
    __touchProject: (root) => touchProject(root),
    __hasProject: (root) => projectCache.has(root || ''),
  };
```
(If `startServer` already returns an object — from the deep-check plan — merge these keys into it. If the deep-check plan has not been implemented, the prior return was `{ conn, documents }`; add the three hooks.)

- [ ] **Step 4: Run the suite**

Run: `node --test tests/resource-lsp/*.test.js`
Expected: all PASS, including the new eviction test.

- [ ] **Step 5: Commit**

```bash
git add src/resource-lsp/server.js tests/resource-lsp/server-diagnostics.test.js
git commit -m "perf: cap the per-root project cache with LRU eviction"
```

---

## Task 3: Scan header-attribute references (Godot 3 style)

In Godot-3-style scenes, a reference can appear in a section header attribute, e.g. `[node name="Root" type="Node2D" script=ExtResource("1")]` (or `instance=ExtResource(...)`). The v1 scanner only scans body lines, so such references are silently missed (a false-negative: a broken ref there is not flagged). Add header-attribute scanning. This never introduces a false-positive.

**Files:**
- Modify: `src/resource-lsp/document.js`
- Test: `tests/resource-lsp/document.test.js`

- [ ] **Step 1: Write the failing test**

```js
// append to tests/resource-lsp/document.test.js
test('collects references that appear in a header attribute value', () => {
  const src = '[gd_scene format=3]\n\n[ext_resource type="Script" path="res://a.gd" id="1"]\n\n[node name="Root" type="Node" script=ExtResource("1")]\n';
  const doc = buildDocument(tokenize(src));
  const ref = doc.references.find((r) => r.kind === 'ext' && r.id === '1');
  assert.ok(ref, 'header-attribute ExtResource("1") should be collected');
  // its range should be on the node header line (index 4)
  assert.equal(ref.range.start.line, 4);
});

test('a broken header-attribute reference is therefore flagged by validate', () => {
  const { validate } = require('../../src/resource-lsp/validate.js');
  const src = '[gd_scene format=3]\n\n[node name="Root" type="Node" script=ExtResource("99")]\n';
  const project = { root: '/x', fileExists: () => true, findSimilarFiles: () => [] };
  const d = validate(buildDocument(tokenize(src)), project);
  assert.ok(d.some((x) => x.code === 'undeclared-ext-ref'));
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/resource-lsp/document.test.js`
Expected: FAIL — header-attribute references are not collected.

- [ ] **Step 3: Modify `src/resource-lsp/document.js`**

The tokenizer already stores the raw header line via `headerRange` but the reference scanner only iterates `bodyLines`. Add a scan of the header line text too. Inside `buildDocument`, the per-section loop currently scans `s.bodyLines`. Add header scanning. The header line's text is reconstructable from the section, but the cleanest is to scan each attribute VALUE that contains a reference. Add, right where references are collected for body lines:

```js
    // Scan header attribute values for references (Godot-3-style inline refs).
    for (const key of Object.keys(s.attributes)) {
      const val = s.attributes[key];
      if (typeof val !== 'string' || val.indexOf('Resource(') === -1) continue;
      REFERENCE_RE.lastIndex = 0;
      let hm;
      while ((hm = REFERENCE_RE.exec(val)) !== null) {
        // Map the id position within the attribute value back to the source line/character.
        const vr = s.attrValueRange[key];
        const idOffsetInVal = hm.indices[2][0];
        doc.references.push({
          kind: hm[1] === 'ExtResource' ? 'ext' : 'sub',
          id: hm[2],
          range: {
            start: { line: vr.start.line, character: vr.start.character + idOffsetInVal },
            end: { line: vr.start.line, character: vr.start.character + idOffsetInVal + hm[2].length },
          },
        });
      }
    }
```

Note: `REFERENCE_RE` must already have the `d` (hasIndices) flag from v1 (it does: `/\b(ExtResource|SubResource)\(\s*"?([0-9A-Za-z_]+)"?\s*\)/gd`). The attribute value for `script=ExtResource("1")` is parsed by the tokenizer as the unquoted token `ExtResource("1")`, and `attrValueRange[key]` points at it — so adding `idOffsetInVal` maps correctly to the source. Verify with the test's `ref.range.start.line === 4` assertion.

- [ ] **Step 4: Run the suite**

Run: `node --test tests/resource-lsp/*.test.js`
Expected: all PASS, including the two new tests. Confirm no v1 test regressed (especially the existing reference-range tests).

- [ ] **Step 5: Commit**

```bash
git add src/resource-lsp/document.js tests/resource-lsp/document.test.js
git commit -m "feat: also collect ExtResource/SubResource references from header attributes"
```

---

## Task 4: Do not treat `ExtResource(...)` inside a quoted string value as a reference

A property whose VALUE is a string literal containing the text `ExtResource("x")`, e.g. `tooltip = "see ExtResource(\"x\")"`, is not a real reference — it is literal text. The v1 body-line scanner would match it and (if `x` is undeclared) emit a false-positive `undeclared-ext-ref`. Add a guard: skip a body-line match that sits inside a quoted string.

**Files:**
- Modify: `src/resource-lsp/document.js`
- Test: `tests/resource-lsp/document.test.js`

- [ ] **Step 1: Write the failing test**

```js
// append to tests/resource-lsp/document.test.js
test('ExtResource text inside a quoted string value is NOT a reference', () => {
  const src = '[gd_scene format=3]\n\n[node name="R" type="Label"]\ntext = "see ExtResource(\\"99\\") in the docs"\n';
  const doc = buildDocument(tokenize(src));
  assert.equal(doc.references.length, 0);
});

test('a real unquoted ExtResource value is still a reference', () => {
  const src = '[gd_scene format=3]\n\n[ext_resource type="Script" path="res://a.gd" id="1"]\n\n[node name="R" type="Node"]\nscript = ExtResource("1")\n';
  const doc = buildDocument(tokenize(src));
  assert.equal(doc.references.length, 1);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test tests/resource-lsp/document.test.js`
Expected: FAIL — the quoted-string match is currently collected, so `references.length === 1` not 0.

- [ ] **Step 3: Add the in-string guard in `src/resource-lsp/document.js`**

In the body-line reference scan, before pushing a match, check whether the match start is inside a quoted string by counting unescaped double-quotes on the line before the match index. An odd count means the match is inside a string → skip it. Add a helper and the guard:

```js
function isInsideQuotedString(text, index) {
  let inString = false;
  for (let i = 0; i < index; i++) {
    const ch = text[i];
    if (ch === '\\') { i++; continue; } // skip escaped char
    if (ch === '"') inString = !inString;
  }
  return inString;
}
```

In the body-line scan loop, guard the push:
```js
      REFERENCE_RE.lastIndex = 0;
      let m;
      while ((m = REFERENCE_RE.exec(text)) !== null) {
        if (isInsideQuotedString(text, m.index)) continue; // literal text, not a reference
        const [idStart, idEnd] = m.indices[2];
        doc.references.push({
          kind: m[1] === 'ExtResource' ? 'ext' : 'sub',
          id: m[2],
          range: { start: { line, character: idStart }, end: { line, character: idEnd } },
        });
      }
```

(The header-attribute scan from Task 3 operates on already-parsed unquoted attribute values, so it does not need this guard.)

- [ ] **Step 4: Run the suite**

Run: `node --test tests/resource-lsp/*.test.js`
Expected: all PASS, including the two new tests, and the existing reference tests (the `;`-comment-skip test and the keyword-substring test from v1) still pass.

- [ ] **Step 5: Commit**

```bash
git add src/resource-lsp/document.js tests/resource-lsp/document.test.js
git commit -m "fix: ignore ExtResource/SubResource text inside quoted string values"
```

---

## Self-Review (completed during planning)

**Spec coverage:** all four selected improvements have a task — async walk (Task 1), project-cache eviction (Task 2), header-attribute references (Task 3), string-literal guard (Task 4). Covered.

**Placeholder scan:** every code step has complete code; every run step has a command + expected output. No TBDs.

**Type consistency:** `findSimilarFiles(resPath, max) -> string[]` stays synchronous and identical in signature (Task 1 keeps the contract `validate.js` depends on — only the cache fill becomes async). `buildDocument(sections) -> GodotResourceDocument` and the `references[]` shape are unchanged (Tasks 3+4 add/skip entries using the existing `{kind,id,range}` shape and the `d`-flag `REFERENCE_RE`). The Task 2 LRU `touchProject` returns the same project object shape `projectFor` always returned.

**Interaction note:** Tasks 3 and 4 both touch the reference scan in `document.js` but are independent (Task 3 adds header scanning; Task 4 guards body scanning). If both are implemented, apply Task 4's `isInsideQuotedString` guard only to the BODY-line loop, not the header-attribute loop. Task 2's return-handle change must merge with the deep-check plan's handle if that plan landed first (don't clobber its keys).
