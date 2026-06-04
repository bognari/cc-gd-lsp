const test = require('node:test');
const assert = require('node:assert/strict');
const { tokenize } = require('../../src/resource-lsp/tokenizer.js');
const { buildDocument } = require('../../src/resource-lsp/document.js');
const { validate } = require('../../src/resource-lsp/validate.js');

const ALL_OK_PROJECT = {
  root: '/x',
  fileExists: () => true,
  findSimilarFiles: () => [],
};

function diag(src) {
  return validate(buildDocument(tokenize(src)), ALL_OK_PROJECT);
}
function codes(src) {
  return diag(src).map((d) => d.code).sort();
}

test('flags unknown root tag', () => {
  assert.ok(codes('[banana]\n').includes('unknown-root-tag'));
});

test('flags gd_resource without type', () => {
  assert.ok(codes('[gd_resource format=3]\n\n[resource]\n').includes('resource-missing-type'));
});

test('flags ext_resource missing required attrs', () => {
  const c = codes('[gd_scene format=3]\n\n[ext_resource type="Script"]\n');
  assert.ok(c.includes('ext-missing-attr'));
});

test('flags sub_resource missing id', () => {
  const c = codes('[gd_scene format=3]\n\n[sub_resource type="CircleShape2D"]\n');
  assert.ok(c.includes('sub-missing-attr'));
});

test('flags connection missing fields', () => {
  const src = '[gd_scene format=3]\n\n[node name="A" type="Node"]\n\n[connection signal="x" from="A" to="B"]\n';
  assert.ok(codes(src).includes('connection-missing-attr'));
});

test('flags [resource] tag in a scene', () => {
  assert.ok(codes('[gd_scene format=3]\n\n[resource]\n').includes('resource-tag-in-scene'));
});

test('flags [node] tag in a resource', () => {
  assert.ok(codes('[gd_resource type="Theme" format=3]\n\n[node name="A" type="Node"]\n').includes('node-tag-in-resource'));
});

test('flags format newer than 4', () => {
  assert.ok(codes('[gd_scene format=5]\n').includes('format-too-new'));
});

test('flags invalid uid as a warning', () => {
  const d = diag('[gd_scene format=3]\n\n[ext_resource type="Script" path="res://a.gd" uid="uid://zzz9" id="1"]\n');
  const uid = d.find((x) => x.code === 'invalid-uid');
  assert.ok(uid);
  assert.equal(uid.severity, 2);
});

test('flags duplicate ext id as warning', () => {
  const src = '[gd_scene format=3]\n\n[ext_resource type="Script" path="res://a.gd" id="1"]\n[ext_resource type="Script" path="res://b.gd" id="1"]\n';
  const d = diag(src);
  const dup = d.find((x) => x.code === 'duplicate-ext-id');
  assert.ok(dup);
  assert.equal(dup.severity, 2);
});

test('clean scene yields only the load_steps info diagnostic', () => {
  const src = '[gd_scene load_steps=2 format=3 uid="uid://abc"]\n\n[ext_resource type="Script" path="res://a.gd" id="1"]\n\n[node name="Root" type="Node"]\nscript = ExtResource("1")\n';
  const d = diag(src);
  assert.deepEqual(d.map((x) => x.code), ['load-steps-mismatch']);
  assert.equal(d[0].severity, 3);
});

test('a valid Godot UID is NOT flagged', () => {
  // uid://d4n4ub6itg400 is the documented max-length real Godot uid (13 chars, [a-y0-8])
  const d = diag('[gd_scene format=3 uid="uid://d4n4ub6itg400"]\n\n[ext_resource type="Script" path="res://a.gd" uid="uid://cabc12def" id="1"]\n');
  assert.ok(!d.some((x) => x.code === 'invalid-uid'));
});

test('uid containing 9 or z IS flagged (Godot never generates those)', () => {
  const d = diag('[gd_scene format=3]\n\n[ext_resource type="Script" path="res://a.gd" uid="uid://abc9z" id="1"]\n');
  assert.ok(d.some((x) => x.code === 'invalid-uid' && x.severity === 2));
});

test('flags an invalid uid on the root scene header', () => {
  const d = diag('[gd_scene format=3 uid="uid://zzz9"]\n');
  const uid = d.find((x) => x.code === 'invalid-uid');
  assert.ok(uid);
  assert.equal(uid.severity, 2);
});

test('ext-file-missing is suppressed when there is no project root', () => {
  const noRoot = { root: null, fileExists: () => false, findSimilarFiles: () => [] };
  const d = validate(buildDocument(tokenize('[gd_scene format=3]\n\n[ext_resource type="Texture2D" path="res://x.png" id="1"]\n')), noRoot);
  assert.ok(!d.some((x) => x.code === 'ext-file-missing'));
});
