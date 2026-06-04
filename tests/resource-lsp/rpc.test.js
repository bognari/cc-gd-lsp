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
