const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const { locateGodot } = require('../../src/resource-lsp/godot-locate.js');

const GODOT = locateGodot();
const PROJ = path.join(__dirname, 'fixtures', 'deepproj');
const SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'deep_check.gd');

test('deep_check.gd surfaces a bad sub_resource via Godot', { skip: GODOT ? false : 'Godot not found on this machine' }, () => {
  const dest = path.join(PROJ, 'deep_check.gd');
  fs.copyFileSync(SCRIPT, dest);
  try {
    const res = spawnSync(GODOT, ['--headless', '--path', PROJ, '--script', 'res://deep_check.gd'], {
      encoding: 'utf8', timeout: 90000,
    });
    const out = (res.stdout || '') + (res.stderr || '');
    assert.match(out, /GDRESLSP_DONE/);
    assert.match(out, /bad_subres\.tscn:3 - Parse Error: Can't create sub resource of type 'NotARealResource'/);
  } finally {
    fs.rmSync(dest, { force: true });
  }
});
