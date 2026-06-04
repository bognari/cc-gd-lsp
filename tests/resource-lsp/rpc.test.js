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

test('reassembles a frame split across two writes', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const conn = createConnection(input, output);
  const received = [];
  conn.onMessage((m) => received.push(m));

  const body = JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'split' });
  const framed = `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
  const cut = framed.length - 5;
  input.write(framed.slice(0, cut));
  await new Promise((r) => setImmediate(r));
  assert.equal(received.length, 0);
  input.write(framed.slice(cut));
  await new Promise((r) => setImmediate(r));
  assert.equal(received.length, 1);
  assert.equal(received[0].id, 7);
});

test('missing Content-Length header causes input stream to be destroyed', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const conn = createConnection(input, output);
  const received = [];
  conn.onMessage((m) => received.push(m));

  let destroyed = false;
  input.on('error', () => { destroyed = true; });
  input.on('close', () => { destroyed = true; });

  // Write a frame with no Content-Length header
  input.write('X-Custom-Header: 5\r\n\r\nhello');
  await new Promise((r) => setImmediate(r));

  assert.ok(destroyed, 'input stream should be destroyed on missing Content-Length');

  // A subsequent valid frame should NOT be delivered after fatal error
  const validBody = JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'after-error' });
  input.write(`Content-Length: ${Buffer.byteLength(validBody)}\r\n\r\n${validBody}`);
  await new Promise((r) => setImmediate(r));
  assert.equal(received.length, 0, 'no messages should arrive after fatal framing error');
});
