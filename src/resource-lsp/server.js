'use strict';

const { createConnection } = require('./rpc.js');

function startServer(input, output) {
  const conn = createConnection(input, output);

  conn.onMessage((msg) => {
    if (msg.method === 'initialize') {
      conn.send({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          capabilities: {
            textDocumentSync: { openClose: true, change: 1, save: true },
            codeActionProvider: true,
          },
        },
      });
      return;
    }
    if (msg.method === 'initialized') return;
    if (msg.method === 'shutdown') {
      conn.send({ jsonrpc: '2.0', id: msg.id, result: null });
      return;
    }
    if (msg.method === 'exit') {
      process.exit(0);
    }
    if (msg.id !== undefined) {
      conn.send({ jsonrpc: '2.0', id: msg.id, result: null });
    }
  });

  return conn;
}

module.exports = { startServer };
