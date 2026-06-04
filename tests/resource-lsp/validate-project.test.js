const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { tokenize } = require('../../src/resource-lsp/tokenizer.js');
const { buildDocument } = require('../../src/resource-lsp/document.js');
const { validate } = require('../../src/resource-lsp/validate.js');
const { createProject } = require('../../src/resource-lsp/project.js');

const PROJ = path.join(__dirname, 'fixtures', 'proj');
const project = createProject(PROJ);

function codes(src) {
  return validate(buildDocument(tokenize(src)), project).map((d) => d.code);
}

test('existing ext_resource file yields no missing-file error', () => {
  const src = '[gd_scene format=3]\n\n[ext_resource type="Script" path="res://player.gd" id="1"]\n';
  assert.ok(!codes(src).includes('ext-file-missing'));
});

test('missing ext_resource file is flagged with a suggestion', async () => {
  const src = '[gd_scene format=3]\n\n[ext_resource type="Texture2D" path="res://art/palyer.png" id="1"]\n';
  let miss;
  for (let i = 0; i < 50; i++) {
    const d = validate(buildDocument(tokenize(src)), project);
    miss = d.find((x) => x.code === 'ext-file-missing');
    if (miss && miss.data.suggestions.length) break;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.ok(miss);
  assert.equal(miss.severity, 1);
  assert.ok(miss.data.suggestions.includes('res://art/player.png'));
  assert.match(miss.message, /Did you mean/);
});

test('undeclared ExtResource reference is an error', () => {
  const src = '[gd_scene format=3]\n\n[ext_resource type="Script" path="res://player.gd" id="1"]\n\n[node name="R" type="Node"]\nscript = ExtResource("99")\n';
  const d = validate(buildDocument(tokenize(src)), project);
  const ref = d.find((x) => x.code === 'undeclared-ext-ref');
  assert.ok(ref);
  assert.deepEqual(ref.data.declared, ['1']);
});

test('declared reference passes', () => {
  const src = '[gd_scene format=3]\n\n[ext_resource type="Script" path="res://player.gd" id="1"]\n\n[node name="R" type="Node"]\nscript = ExtResource("1")\n';
  assert.ok(!codes(src).includes('undeclared-ext-ref'));
});
