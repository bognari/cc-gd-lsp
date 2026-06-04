#!/usr/bin/env node
'use strict';

// Godot .tscn/.tres validation language server for Claude Code.
// Zero dependencies; speaks LSP JSON-RPC over stdio.
const { startServer } = require('../src/resource-lsp/server.js');

startServer(process.stdin, process.stdout);

process.stdin.on('end', () => process.exit(0));
