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
