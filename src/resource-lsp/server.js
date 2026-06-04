'use strict';

const { fileURLToPath } = require('node:url');
const path = require('node:path');
const { createConnection } = require('./rpc.js');
const { tokenize } = require('./tokenizer.js');
const { buildDocument } = require('./document.js');
const { validate } = require('./validate.js');
const { createProject, findProjectRoot } = require('./project.js');
const { computeCodeActions } = require('./fixes.js');
const { runDeepCheck: realRunDeepCheck } = require('./deepcheck.js');
const { locateGodot } = require('./godot-locate.js');

function uriToPath(uri) {
  try {
    return fileURLToPath(uri);
  } catch {
    if (typeof uri !== 'string') return uri;
    let p = uri.replace(/^file:\/\//, '');
    try { p = decodeURIComponent(p); } catch { /* leave as-is */ }
    // Windows drive: "/C:/x" -> "C:/x"
    if (/^\/[A-Za-z]:\//.test(p)) p = p.slice(1);
    return p;
  }
}

function startServer(input, output, options = {}) {
  const conn = createConnection(input, output);
  const documents = new Map(); // uri -> { text, version }
  let workspaceRoot = null;
  let shutdownReceived = false;
  const projectCacheMax = Math.max(1, options.projectCacheMax ?? 8);
  const projectCache = new Map(); // insertion order doubles as LRU order
  const staticDiagnostics = new Map();  // uri -> Diagnostic[]
  const deepDiagnostics = new Map();    // uri -> Diagnostic[]
  const deepState = new Map();          // rootKey -> { running, pending, timer, godot }

  const argv = options.argv || [];
  const deepDisabled = argv.includes('--no-deep-check');
  const deepDebounceMs = options.deepDebounceMs ?? 700;
  const runDeepCheck = options.runDeepCheck || realRunDeepCheck;
  const godotFlagIdx = argv.indexOf('--godot');
  const godotPath = godotFlagIdx >= 0 ? argv[godotFlagIdx + 1] : undefined;

  function touchProject(root) {
    const key = root || '';
    if (projectCache.has(key)) {
      const v = projectCache.get(key);
      projectCache.delete(key);
      projectCache.set(key, v); // move to most-recent (re-insert at end)
      return v;
    }
    const proj = createProject(root);
    projectCache.set(key, proj);
    while (projectCache.size > projectCacheMax) {
      const oldest = projectCache.keys().next().value; // first key = least-recently-used
      projectCache.delete(oldest);
    }
    return proj;
  }

  function projectFor(uri) {
    const fsPath = uriToPath(uri);
    const root = findProjectRoot(path.dirname(fsPath)) || workspaceRoot;
    return touchProject(root);
  }

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

  function rootKeyFor(uri) {
    const fsPath = uriToPath(uri);
    return findProjectRoot(path.dirname(fsPath)) || workspaceRoot || '';
  }

  function uriUnderRoot(uri, root) {
    try {
      const p = uriToPath(uri);
      const rel = path.relative(root, p);
      return !rel.startsWith('..') && !path.isAbsolute(rel);
    } catch { return false; }
  }

  function scheduleDeepCheck(uri) {
    if (deepDisabled) return;
    const root = rootKeyFor(uri);
    if (!root) return;
    let st = deepState.get(root);
    if (!st) { st = { running: false, pending: false, timer: null, godot: undefined }; deepState.set(root, st); }
    if (st.godot === null) return; // previously determined Godot is absent -> skip cheaply
    if (st.timer) clearTimeout(st.timer);
    st.timer = setTimeout(() => startDeepRun(root), deepDebounceMs);
  }

  function startDeepRun(root) {
    if (shutdownReceived) return;
    const st = deepState.get(root);
    if (!st) return;
    if (st.timer) { clearTimeout(st.timer); st.timer = null; }
    if (st.godot === undefined) st.godot = locateGodot(godotPath) || null; // lazy locate off the message-handler path
    if (!st.godot) return; // no Godot available -> deep-check silently unavailable
    if (st.running) { st.pending = true; return; }
    st.running = true;
    st.pending = false;
    const controller = new AbortController();
    st.controller = controller;
    runDeepCheck(root, { godotPath: st.godot, signal: controller.signal })
      .then((map) => applyDeepResults(root, map))
      .catch((err) => process.stderr.write(`[godot-resource] deep-check error: ${err && err.stack}\n`))
      .finally(() => {
        st.running = false;
        st.controller = null;
        if (st.pending) startDeepRun(root);
      });
  }

  function applyDeepResults(root, map) {
    if (shutdownReceived) return;
    const prevUris = new Set([...deepDiagnostics.keys()].filter((u) => uriUnderRoot(u, root)));
    for (const uri of prevUris) deepDiagnostics.delete(uri);
    for (const [uri, diags] of map) deepDiagnostics.set(uri, diags);
    const affected = new Set([...prevUris, ...map.keys()]);
    for (const uri of affected) sendPublish(uri);
  }

  conn.onMessage((msg) => {
    try {
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
          const { uri, text, version } = msg.params.textDocument;
          documents.set(uri, { text, version });
          publish(uri);
          return;
        }
        case 'textDocument/didChange': {
          const uri = msg.params.textDocument.uri;
          const changes = msg.params.contentChanges;
          if (changes && changes.length) {
            documents.set(uri, { text: changes[changes.length - 1].text, version: msg.params.textDocument.version }); // Full sync
          }
          publish(uri);
          return;
        }
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
        case 'textDocument/didClose': {
          const uri = msg.params.textDocument.uri;
          documents.delete(uri);
          staticDiagnostics.delete(uri);
          sendPublish(uri); // union = remaining deep diags (project-wide) or []
          return;
        }
        case 'textDocument/codeAction': {
          const uri = msg.params.textDocument.uri;
          const selRange = msg.params.range;
          const entry = documents.get(uri);
          let actions = [];
          if (entry !== undefined) {
            try {
              const doc = buildDocument(tokenize(entry.text));
              const proj = projectFor(uri);
              const diags = validate(doc, proj);
              actions = computeCodeActions(doc, diags, selRange, proj, uri);
            } catch (err) {
              process.stderr.write(`[godot-resource] codeAction error: ${err && err.stack}\n`);
            }
          }
          conn.send({ jsonrpc: '2.0', id: msg.id, result: actions });
          return;
        }
        case 'shutdown':
          shutdownReceived = true;
          for (const st of deepState.values()) {
            if (st.timer) { clearTimeout(st.timer); st.timer = null; }
            if (st.controller) { try { st.controller.abort(); } catch {} }
          }
          conn.send({ jsonrpc: '2.0', id: msg.id, result: null });
          return;
        case 'exit':
          process.exit(shutdownReceived ? 0 : 1);
          return;
        default:
          if (msg.id !== undefined) {
            conn.send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } });
          }
      }
    } catch (err) {
      process.stderr.write(`[godot-resource] handler error: ${err && err.stack}\n`);
      if (msg && msg.id !== undefined) {
        conn.send({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: 'Internal error' } });
      }
    }
  });

  return {
    conn,
    documents,
    __projectCacheSize: () => projectCache.size,
    __touchProject: (root) => touchProject(root),
    __hasProject: (root) => projectCache.has(root || ''),
  };
}

module.exports = { startServer };
