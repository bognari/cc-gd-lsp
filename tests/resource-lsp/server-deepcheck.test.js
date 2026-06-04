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
function waitFor(get, pred, t = 3000) {
  return new Promise((res, rej) => { const s = Date.now(); const tick = () => { if (pred(get())) return res(); if (Date.now() - s > t) return rej(new Error('timeout')); setImmediate(tick); }; tick(); });
}

test('didSave triggers a deep-check whose diagnostics merge with static ones', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const messages = [];
  collect(output, (m) => messages.push(m));

  const uri = 'file://' + path.join(PROJ, 'z.tscn');
  const fakeDeep = async () => new Map([[uri, [{
    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
    severity: 1, code: 'deep-unknown-class', source: 'godot-resource (deep)', message: 'Cannot get class Foo',
  }]]]);

  startServer(input, output, { runDeepCheck: fakeDeep, deepDebounceMs: 10, argv: [], projectCacheMax: 8 });

  input.write(frame({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { rootUri: 'file://' + PROJ, capabilities: {} } }));
  input.write(frame({ jsonrpc: '2.0', method: 'textDocument/didOpen', params: { textDocument: { uri, languageId: 'godot-resource', version: 1, text: '[banana]\n' } } }));
  await waitFor(() => messages, (ms) => ms.some((m) => m.method === 'textDocument/publishDiagnostics'));
  input.write(frame({ jsonrpc: '2.0', method: 'textDocument/didSave', params: { textDocument: { uri } } }));

  await waitFor(() => messages, (ms) => ms.some((m) =>
    m.method === 'textDocument/publishDiagnostics' && m.params.uri === uri
    && m.params.diagnostics.some((d) => d.code === 'unknown-root-tag')
    && m.params.diagnostics.some((d) => d.code === 'deep-unknown-class')));
});

test('--no-deep-check disables the deep-check (static only)', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const messages = [];
  collect(output, (m) => messages.push(m));
  let deepCalled = false;
  const fakeDeep = async () => { deepCalled = true; return new Map(); };
  startServer(input, output, { runDeepCheck: fakeDeep, deepDebounceMs: 10, argv: ['--no-deep-check'] });
  const uri = 'file://' + path.join(PROJ, 'z2.tscn');
  input.write(frame({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { rootUri: 'file://' + PROJ, capabilities: {} } }));
  input.write(frame({ jsonrpc: '2.0', method: 'textDocument/didOpen', params: { textDocument: { uri, languageId: 'godot-resource', version: 1, text: '[banana]\n' } } }));
  input.write(frame({ jsonrpc: '2.0', method: 'textDocument/didSave', params: { textDocument: { uri } } }));
  await waitFor(() => messages, (ms) => ms.some((m) => m.method === 'textDocument/publishDiagnostics' && m.params.diagnostics.some((d) => d.code === 'unknown-root-tag')));
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(deepCalled, false, 'deep-check must not run when --no-deep-check is set');
});
