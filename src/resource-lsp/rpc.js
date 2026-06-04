'use strict';

// Minimal LSP-style JSON-RPC framing over a pair of streams.
function createConnection(input, output) {
  let buffer = Buffer.alloc(0);
  let messageHandler = () => {};

  function tryParse() {
    while (true) {
      const headerEnd = buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) return;

      const header = buffer.slice(0, headerEnd).toString('ascii');
      const match = /Content-Length:\s*(\d+)/i.exec(header);
      if (!match) {
        buffer = buffer.slice(headerEnd + 4);
        continue;
      }
      const length = Number.parseInt(match[1], 10);
      const bodyStart = headerEnd + 4;
      if (buffer.length < bodyStart + length) return;

      const body = buffer.slice(bodyStart, bodyStart + length).toString('utf8');
      buffer = buffer.slice(bodyStart + length);

      let msg;
      try {
        msg = JSON.parse(body);
      } catch {
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
    output.write(`Content-Length: ${body.length}\r\n\r\n`);
    output.write(body);
  }

  return {
    onMessage(fn) { messageHandler = fn; },
    send,
  };
}

module.exports = { createConnection };
