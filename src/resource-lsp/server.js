'use strict';

const { fileURLToPath } = require('node:url');
const path = require('node:path');
const { createConnection } = require('./rpc.js');
const { tokenize } = require('./tokenizer.js');
const { buildDocument } = require('./document.js');
const { validate } = require('./validate.js');
const { createProject, findProjectRoot } = require('./project.js');
const { computeCodeActions } = require('./fixes.js');

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

function startServer(input, output) {
  const conn = createConnection(input, output);
  const documents = new Map(); // uri -> { text, version }
  let workspaceRoot = null;
  let shutdownReceived = false;
  const projectCache = new Map(); // root (string|null) -> project instance

  function projectFor(uri) {
    const fsPath = uriToPath(uri);
    const root = findProjectRoot(path.dirname(fsPath)) || workspaceRoot;
    const key = root || '';
    if (!projectCache.has(key)) projectCache.set(key, createProject(root));
    return projectCache.get(key);
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
    const params = { uri, diagnostics };
    if (typeof entry.version === 'number') params.version = entry.version; // LSP: version must be an integer when present
    conn.send({ jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params });
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
          return;
        }
        case 'textDocument/didClose': {
          const uri = msg.params.textDocument.uri;
          documents.delete(uri);
          conn.send({ jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: { uri, diagnostics: [] } });
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

  return { conn, documents };
}

module.exports = { startServer };
