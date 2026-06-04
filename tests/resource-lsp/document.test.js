const test = require('node:test');
const assert = require('node:assert/strict');
const { tokenize } = require('../../src/resource-lsp/tokenizer.js');
const { buildDocument } = require('../../src/resource-lsp/document.js');

const SCENE = `[gd_scene load_steps=3 format=3 uid="uid://abc"]

[ext_resource type="Script" path="res://player.gd" id="1_xy"]
[sub_resource type="CircleShape2D" id="Shape_1"]

[node name="Root" type="Node2D"]
script = ExtResource("1_xy")

[node name="Body" type="StaticBody2D" parent="."]
shape = SubResource("Shape_1")
`;

const RESOURCE = `[gd_resource type="Theme" load_steps=1 format=3]

[resource]
default_font_size = 16
`;

test('classifies a scene document', () => {
  const doc = buildDocument(tokenize(SCENE));
  assert.equal(doc.kind, 'scene');
  assert.equal(doc.format, 3);
  assert.equal(doc.extResources.length, 1);
  assert.equal(doc.subResources.length, 1);
  assert.equal(doc.nodes.length, 2);
});

test('captures ext/sub resource fields', () => {
  const doc = buildDocument(tokenize(SCENE));
  assert.deepEqual(
    { id: doc.extResources[0].id, type: doc.extResources[0].type, path: doc.extResources[0].path },
    { id: '1_xy', type: 'Script', path: 'res://player.gd' },
  );
  assert.equal(doc.subResources[0].id, 'Shape_1');
});

test('collects ExtResource/SubResource references with ranges', () => {
  const doc = buildDocument(tokenize(SCENE));
  const ext = doc.references.find((r) => r.kind === 'ext');
  const sub = doc.references.find((r) => r.kind === 'sub');
  assert.equal(ext.id, '1_xy');
  assert.equal(sub.id, 'Shape_1');
  assert.equal(ext.range.start.line, 6);
});

test('classifies a resource document', () => {
  const doc = buildDocument(tokenize(RESOURCE));
  assert.equal(doc.kind, 'resource');
  assert.ok(doc.resourceSection);
  assert.equal(doc.nodes.length, 0);
});
