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

test('references inside a comment line are ignored', () => {
  const src = '[gd_scene format=3]\n\n[node name="R" type="Node"]\n; script = ExtResource("99")\n';
  const doc = buildDocument(tokenize(src));
  assert.equal(doc.references.length, 0);
});

test('reference ranges have correct character offsets, even for keyword-substring ids', () => {
  const src = '[gd_scene format=3]\n\n[ext_resource type="X" path="res://a.gd" id="Resource"]\n\n[node name="R" type="Node"]\nscript = ExtResource("Resource")\n';
  const doc = buildDocument(tokenize(src));
  const ref = doc.references.find((r) => r.kind === 'ext');
  assert.equal(ref.id, 'Resource');
  // The body line is: script = ExtResource("Resource")
  // index of the id text inside the quotes:
  const line = 'script = ExtResource("Resource")';
  const expectedStart = line.indexOf('Resource', line.indexOf('('));
  assert.equal(ref.range.start.line, 5);
  assert.equal(ref.range.start.character, expectedStart);
  assert.equal(ref.range.end.character, expectedStart + 'Resource'.length);
  // And the slice of the source line at that range is exactly the id:
  assert.equal(line.slice(ref.range.start.character, ref.range.end.character), 'Resource');
});

test('collects references that appear in a header attribute value', () => {
  const src = '[gd_scene format=3]\n\n[ext_resource type="Script" path="res://a.gd" id="1"]\n\n[node name="Root" type="Node" script=ExtResource("1")]\n';
  const doc = buildDocument(tokenize(src));
  const ref = doc.references.find((r) => r.kind === 'ext' && r.id === '1');
  assert.ok(ref, 'header-attribute ExtResource("1") should be collected');
  assert.equal(ref.range.start.line, 4);
  const headerLine = '[node name="Root" type="Node" script=ExtResource("1")]';
  const expectedChar = headerLine.indexOf('"1"') + 1; // position of the id digit inside the quotes
  assert.equal(ref.range.start.character, expectedChar);
  assert.equal(ref.range.end.character, expectedChar + 1);
  assert.equal(headerLine.slice(ref.range.start.character, ref.range.end.character), '1');
});

test('a broken header-attribute reference is therefore flagged by validate', () => {
  const { validate } = require('../../src/resource-lsp/validate.js');
  const src = '[gd_scene format=3]\n\n[node name="Root" type="Node" script=ExtResource("99")]\n';
  const project = { root: '/x', fileExists: () => true, findSimilarFiles: () => [] };
  const d = validate(buildDocument(tokenize(src)), project);
  assert.ok(d.some((x) => x.code === 'undeclared-ext-ref'));
});

test('ext_resource path containing "ExtResource(" is NOT treated as a reference', () => {
  const src = '[gd_scene format=3]\n\n[ext_resource type="Script" path="res://ExtResource(1).gd" id="1"]\n';
  const doc = buildDocument(tokenize(src));
  // the only thing here is the declaration itself; no inline reference should be collected
  assert.equal(doc.references.length, 0);
});

test('ExtResource text inside a quoted string value is NOT a reference', () => {
  // NOTE: the escaped-quote form ExtResource(\"99\") is rejected by REFERENCE_RE itself
  // (the id is not directly after the optional quote), so this asserts a non-regression
  // rather than exercising isInsideQuotedString — the bare-id test below exercises the guard.
  const src = '[gd_scene format=3]\n\n[node name="R" type="Label"]\ntext = "see ExtResource(\\"99\\") in the docs"\n';
  const doc = buildDocument(tokenize(src));
  assert.equal(doc.references.length, 0);
});

test('a real unquoted ExtResource value is still a reference', () => {
  const src = '[gd_scene format=3]\n\n[ext_resource type="Script" path="res://a.gd" id="1"]\n\n[node name="R" type="Node"]\nscript = ExtResource("1")\n';
  const doc = buildDocument(tokenize(src));
  assert.equal(doc.references.length, 1);
});

test('a bare-id ExtResource(...) inside a quoted string is suppressed by the guard', () => {
  // ExtResource(99) here DOES match REFERENCE_RE (bare id), so this exercises isInsideQuotedString
  const src = '[gd_scene format=3]\n\n[node name="R" type="Label"]\ntext = "label ExtResource(99) here"\n';
  const doc = buildDocument(tokenize(src));
  assert.equal(doc.references.length, 0);
});

test('the same bare-id SubResource(...) NOT inside a string is still collected', () => {
  const src = '[gd_scene format=3]\n\n[node name="R" type="Node"]\nshape = SubResource(99)\n';
  const doc = buildDocument(tokenize(src));
  assert.equal(doc.references.length, 1);
  assert.equal(doc.references[0].id, '99');
});

test('a quoted header string containing ExtResource text is NOT a reference', () => {
  const src = '[gd_scene format=3]\n\n[node name="R" type="Node" hint="see ExtResource(1) here"]\n';
  const doc = buildDocument(tokenize(src));
  assert.equal(doc.references.length, 0);
});
