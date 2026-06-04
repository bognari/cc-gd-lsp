const test = require('node:test');
const assert = require('node:assert/strict');
const { tokenize } = require('../../src/resource-lsp/tokenizer.js');
const { buildDocument } = require('../../src/resource-lsp/document.js');
const { validate } = require('../../src/resource-lsp/validate.js');
const { computeCodeActions } = require('../../src/resource-lsp/fixes.js');

const PROJECT = {
  root: '/x',
  fileExists: (p) => p === 'res://art/player.png',
  findSimilarFiles: (p) => (p.includes('palyer') ? ['res://art/player.png'] : []),
};
const URI = 'file:///x/scene.tscn';

function actionsFor(src) {
  const doc = buildDocument(tokenize(src));
  const diags = validate(doc, PROJECT);
  const fullRange = { start: { line: 0, character: 0 }, end: { line: 9999, character: 0 } };
  return computeCodeActions(doc, diags, fullRange, PROJECT, URI);
}

test('missing-file diagnostic yields a "did you mean" replace edit', () => {
  const src = '[gd_scene format=3]\n\n[ext_resource type="Texture2D" path="res://art/palyer.png" id="1"]\n';
  const actions = actionsFor(src);
  const fix = actions.find((a) => a.title.includes('res://art/player.png'));
  assert.ok(fix);
  const edit = fix.edit.changes[URI][0];
  assert.equal(edit.newText, 'res://art/player.png');
  assert.equal(edit.range.start.line, 2);
});

test('invalid-uid diagnostic yields a remove-attribute edit', () => {
  const src = '[gd_scene format=3]\n\n[ext_resource type="Script" path="res://art/player.png" uid="uid://zzz9" id="1"]\n';
  const actions = actionsFor(src);
  const fix = actions.find((a) => a.title.toLowerCase().includes('remove'));
  assert.ok(fix);
  const edit = fix.edit.changes[URI][0];
  assert.equal(edit.newText, '');
});

test('undeclared ext ref yields a nearest-id replacement', () => {
  const src = '[gd_scene format=3]\n\n[ext_resource type="Script" path="res://art/player.png" id="1_aaaa"]\n\n[node name="R" type="Node"]\nscript = ExtResource("1_aaab")\n';
  const actions = actionsFor(src);
  const fix = actions.find((a) => a.title.includes('1_aaaa'));
  assert.ok(fix);
  assert.equal(fix.edit.changes[URI][0].newText, '1_aaaa');
});

test('load-steps mismatch yields a corrective edit', () => {
  const src = '[gd_scene load_steps=9 format=3]\n\n[ext_resource type="Script" path="res://art/player.png" id="1"]\n';
  const actions = actionsFor(src);
  const fix = actions.find((a) => a.title.includes('load_steps'));
  assert.ok(fix);
  assert.equal(fix.edit.changes[URI][0].newText, '1');
});

test('Fix-All on 3 duplicate ids proposes three distinct new ids', () => {
  const src = '[gd_scene format=3]\n\n[ext_resource type="X" path="res://art/player.png" id="1"]\n[ext_resource type="X" path="res://art/player.png" id="1"]\n[ext_resource type="X" path="res://art/player.png" id="1"]\n';
  const actions = actionsFor(src).filter((a) => a.title.startsWith('Renumber id'));
  const newIds = actions.map((a) => a.edit.changes[URI][0].newText);
  assert.equal(newIds.length, 2); // 2nd and 3rd are duplicates
  assert.equal(new Set(newIds).size, newIds.length); // all distinct
});

test('invalid-uid removal deletes exactly the uid attribute range (no left extension)', () => {
  const src = '[gd_scene format=3]\n\n[ext_resource type="Script" path="res://art/player.png" uid="uid://zzz9" id="1"]\n';
  const doc = buildDocument(tokenize(src));
  const diags = validate(doc, PROJECT);
  const fullRange = { start: { line: 0, character: 0 }, end: { line: 9999, character: 0 } };
  const actions = computeCodeActions(doc, diags, fullRange, PROJECT, URI);
  const fix = actions.find((a) => a.title.toLowerCase().includes('remove'));
  assert.ok(fix);
  const ext = doc.extResources[0];
  const edit = fix.edit.changes[URI][0];
  // the delete range equals attrFullRange.uid exactly
  assert.deepEqual(edit.range, ext.section.attrFullRange.uid);
  assert.equal(edit.newText, '');
});
