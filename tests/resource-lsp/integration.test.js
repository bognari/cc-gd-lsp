const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');

const ENTRY = path.join(__dirname, '..', '..', 'bin', 'godot-resource-lsp.js');

function frame(obj) {
  const body = JSON.stringify(obj);
  return `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
}

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
