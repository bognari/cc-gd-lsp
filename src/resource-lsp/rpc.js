'use strict';

// Minimal LSP-style JSON-RPC framing over a pair of streams.

const MAX_BUFFER_SIZE = 1024 * 1024; // 1 MB

function createConnection(input, output) {
  let buffer = Buffer.alloc(0);
  let messageHandler = () => {};
  let failed = false;

  function fail(message) {
    failed = true;
    if (typeof input.destroy === 'function') {
      input.destroy(new Error(message));
    } else {
      process.exit(1);
    }
  }

  function tryParse() {
    if (failed) return;

    while (true) {
      const headerEnd = buffer.indexOf('\r\n\r\n');

      // Guard: header block exceeds max buffer without a terminator
      if (headerEnd === -1) {
        if (buffer.length > MAX_BUFFER_SIZE) {
          fail('LSP framing error: header too large');
        }
        return;
      }

      const header = buffer.slice(0, headerEnd).toString('ascii');
      const match = /Content-Length:\s*(\d+)/i.exec(header);
      if (!match) {
        // Missing Content-Length is a fatal framing error — do not silently skip
        fail('LSP framing error: missing Content-Length header');
        return;
      }

      const length = Number.parseInt(match[1], 10);

      // Guard: declared message body exceeds size limit
      if (length > MAX_BUFFER_SIZE) {
        fail('LSP framing error: message too large');
        return;
      }

      const bodyStart = headerEnd + 4;
      // Partial frame — wait for more bytes
      if (buffer.length < bodyStart + length) return;

      const body = buffer.slice(bodyStart, bodyStart + length).toString('utf8');
      buffer = buffer.slice(bodyStart + length);

      let msg;
      try {
        msg = JSON.parse(body);
      } catch {
        // Malformed JSON in one frame is non-fatal; skip this frame
        continue;
      }
      messageHandler(msg);
    }
  }

  input.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    tryParse();
  });

  function send(message) {
    const body = Buffer.from(JSON.stringify(message), 'utf8');
    const header = Buffer.from('Content-Length: ' + body.length + '\r\n\r\n', 'ascii');
    output.write(Buffer.concat([header, body]));
  }

  return {
    onMessage(fn) { messageHandler = fn; },
    send,
  };
}

module.exports = { createConnection };
