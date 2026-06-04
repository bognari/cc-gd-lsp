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
function waitFor(getList, predicate, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      if (predicate(getList())) return resolve();
      if (Date.now() - started > timeoutMs) return reject(new Error('timeout'));
      setImmediate(tick);
    };
    tick();
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

  await waitFor(() => messages, (ms) => ms.some((m) => m.method === 'textDocument/publishDiagnostics'));
  const pub = messages.find((m) => m.method === 'textDocument/publishDiagnostics');
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
  await waitFor(() => messages, (ms) => ms.some((m) => m.method === 'textDocument/publishDiagnostics'));
  input.write(frame({ jsonrpc: '2.0', method: 'textDocument/didClose', params: { textDocument: { uri } } }));
  await waitFor(() => messages, (ms) => ms.filter((m) => m.method === 'textDocument/publishDiagnostics').length >= 2);

  const last = messages.filter((m) => m.method === 'textDocument/publishDiagnostics').pop();
  assert.deepEqual(last.params.diagnostics, []);
});

test('publishDiagnostics includes the document version', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const messages = [];
  collect(output, (m) => messages.push(m));
  startServer(input, output);
  input.write(frame({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { rootUri: 'file://' + PROJ, capabilities: {} } }));
  const uri = 'file://' + path.join(PROJ, 'v.tscn');
  input.write(frame({ jsonrpc: '2.0', method: 'textDocument/didOpen', params: { textDocument: { uri, languageId: 'godot-resource', version: 7, text: '[banana]\n' } } }));
  await waitFor(() => messages, (ms) => ms.some((m) => m.method === 'textDocument/publishDiagnostics'));
  const pub = messages.find((m) => m.method === 'textDocument/publishDiagnostics');
  assert.equal(pub.params.version, 7);
});

test('didChange re-validates with the updated text', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const messages = [];
  collect(output, (m) => messages.push(m));
  startServer(input, output);

  input.write(frame({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { rootUri: 'file://' + PROJ, capabilities: {} } }));
  const uri = 'file://' + path.join(PROJ, 'y.tscn');
  // open clean
  input.write(frame({ jsonrpc: '2.0', method: 'textDocument/didOpen',
    params: { textDocument: { uri, languageId: 'godot-resource', version: 1, text: '[gd_scene format=3]\n' } } }));
  await waitFor(() => messages, (ms) => ms.some((m) => m.method === 'textDocument/publishDiagnostics'));
  // change to broken
  input.write(frame({ jsonrpc: '2.0', method: 'textDocument/didChange',
    params: { textDocument: { uri, version: 2 }, contentChanges: [{ text: '[banana]\n' }] } }));
  await waitFor(() => messages, (ms) => ms.filter((m) => m.method === 'textDocument/publishDiagnostics').length >= 2);

  const last = messages.filter((m) => m.method === 'textDocument/publishDiagnostics').pop();
  assert.ok(last.params.diagnostics.some((d) => d.code === 'unknown-root-tag'));
});

test('codeAction returns a fix for a missing file', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const messages = [];
  collect(output, (m) => messages.push(m));
  startServer(input, output);

  input.write(frame({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { rootUri: 'file://' + PROJ, capabilities: {} } }));
  const uri = 'file://' + path.join(PROJ, 'ca.tscn');
  const text = '[gd_scene format=3]\n\n[ext_resource type="Texture2D" path="res://art/palyer.png" id="1"]\n';
  input.write(frame({ jsonrpc: '2.0', method: 'textDocument/didOpen', params: { textDocument: { uri, languageId: 'godot-resource', version: 1, text } } }));
  await waitFor(() => messages, (ms) => ms.some((m) => m.method === 'textDocument/publishDiagnostics'));
  input.write(frame({ jsonrpc: '2.0', id: 2, method: 'textDocument/codeAction',
    params: { textDocument: { uri }, range: { start: { line: 2, character: 0 }, end: { line: 2, character: 80 } }, context: { diagnostics: [] } } }));
  await waitFor(() => messages, (ms) => ms.some((m) => m.id === 2));

  const resp = messages.find((m) => m.id === 2);
  assert.ok(resp.result.some((a) => a.title.includes('res://art/player.png')));
});
