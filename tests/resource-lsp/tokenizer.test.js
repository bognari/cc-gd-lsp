const test = require('node:test');
const assert = require('node:assert/strict');
const { tokenize } = require('../../src/resource-lsp/tokenizer.js');

const SAMPLE = `[gd_scene load_steps=2 format=3 uid="uid://abc"]

[ext_resource type="Script" path="res://player.gd" id="1_xy"]

[node name="Root" type="Node2D"]
script = ExtResource("1_xy")
`;

test('extracts section names in order', () => {
  const sections = tokenize(SAMPLE);
  assert.deepEqual(sections.map((s) => s.name), ['gd_scene', 'ext_resource', 'node']);
});

test('parses attributes with quoted and unquoted values', () => {
  const [scene, ext] = tokenize(SAMPLE);
  assert.equal(scene.attributes.load_steps, '2');
  assert.equal(scene.attributes.format, '3');
  assert.equal(scene.attributes.uid, 'uid://abc');
  assert.equal(ext.attributes.type, 'Script');
  assert.equal(ext.attributes.path, 'res://player.gd');
  assert.equal(ext.attributes.id, '1_xy');
});

test('records header line numbers (0-based)', () => {
  const sections = tokenize(SAMPLE);
  assert.equal(sections[0].headerLine, 0);
  assert.equal(sections[1].headerLine, 2);
  assert.equal(sections[2].headerLine, 4);
});

test('captures body lines under a section', () => {
  const node = tokenize(SAMPLE)[2];
  assert.deepEqual(node.bodyLines.map((l) => l.text), ['script = ExtResource("1_xy")', '']);
  assert.equal(node.bodyLines[0].line, 5);
});

test('value range points at the attribute value text', () => {
  const ext = tokenize(SAMPLE)[1];
  const r = ext.attrValueRange.path;
  assert.equal(r.start.line, 2);
  const headerText = '[ext_resource type="Script" path="res://player.gd" id="1_xy"]';
  assert.equal(headerText.slice(r.start.character, r.end.character), 'res://player.gd');
});
