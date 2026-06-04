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
  let shutdownReceived = false;

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
  });

  return { conn, documents };
}

module.exports = { startServer };
