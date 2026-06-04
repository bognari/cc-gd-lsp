#!/usr/bin/env node
'use strict';

const { startServer } = require('../src/resource-lsp/server.js');

startServer(process.stdin, process.stdout, { argv: process.argv.slice(2) });

process.stdin.on('end', () => process.exit(0));
