const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { locateGodot } = require('../../src/resource-lsp/godot-locate.js');

test('returns an explicit path when it exists', () => {
  const tmp = path.join(os.tmpdir(), 'fake-godot-' + process.pid);
  fs.writeFileSync(tmp, '#!/bin/sh\n');
  try {
    assert.equal(locateGodot(tmp), tmp);
  } finally {
    fs.unlinkSync(tmp);
  }
});

test('returns null or a string when explicit path is missing (never throws)', () => {
  const result = locateGodot('/definitely/not/here/godot-xyz');
  assert.ok(result === null || typeof result === 'string');
});
