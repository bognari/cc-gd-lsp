const test = require('node:test');
const assert = require('node:assert/strict');
const { parseGodotOutput } = require('../../src/resource-lsp/deepcheck.js');

const ROOT = '/proj';

test('maps a res://file:line error to a diagnostic on the right uri', () => {
  const stderr = `ERROR: res://bad_subres.tscn:3 - Parse Error: Can't create sub resource of type 'NotARealResource'.\nGDRESLSP_DONE\n`;
  const map = parseGodotOutput(stderr, ROOT);
  const uri = 'file:///proj/bad_subres.tscn';
  const diags = map.get(uri);
  assert.ok(diags && diags.length === 1);
  assert.equal(diags[0].range.start.line, 2); // 1-based line 3 -> 0-based 2
  assert.equal(diags[0].severity, 1);
  assert.match(diags[0].message, /Can't create sub resource/);
  assert.equal(diags[0].source, 'godot-resource (deep)');
});

test('classifies a missing dependency', () => {
  const stderr = `ERROR: res://s.tscn:6 - Parse Error: [ext_resource] referenced non-existent resource at: res://art/nope.png.\n`;
  const d = parseGodotOutput(stderr, ROOT).get('file:///proj/s.tscn')[0];
  assert.equal(d.code, 'deep-missing-dep');
});

test('a WARNING maps to severity 2', () => {
  const stderr = `WARNING: res://s.tscn:4 - ext_resource, invalid UID: uid://x - using text path instead.\n`;
  const d = parseGodotOutput(stderr, ROOT).get('file:///proj/s.tscn')[0];
  assert.equal(d.severity, 2);
});

test('ignores lines without a res:// location', () => {
  const stderr = `ERROR: Cannot get class 'Foo'.\nGDRESLSP_DONE\n`;
  const map = parseGodotOutput(stderr, ROOT);
  assert.equal(map.size, 0);
});

test('deduplicates identical errors on the same line', () => {
  const line = `ERROR: res://s.tscn:6 - Parse Error: [ext_resource] referenced non-existent resource at: res://x.png.`;
  const map = parseGodotOutput(line + '\n' + line + '\n', ROOT);
  assert.equal(map.get('file:///proj/s.tscn').length, 1);
});
