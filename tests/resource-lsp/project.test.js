const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createProject, findProjectRoot } = require('../../src/resource-lsp/project.js');

const PROJ = path.join(__dirname, 'fixtures', 'proj');

test('findProjectRoot walks up to project.godot', () => {
  const start = path.join(PROJ, 'art');
  assert.equal(findProjectRoot(start), PROJ);
});

test('findProjectRoot returns null when no project.godot above', () => {
  assert.equal(findProjectRoot('/tmp'), null);
});

test('fileExists resolves res:// against the root', () => {
  const project = createProject(PROJ);
  assert.equal(project.fileExists('res://player.gd'), true);
  assert.equal(project.fileExists('res://art/player.png'), true);
  assert.equal(project.fileExists('res://missing.png'), false);
});

test('findSimilarFiles suggests by basename similarity', () => {
  const project = createProject(PROJ);
  const hits = project.findSimilarFiles('res://art/palyer.png', 3);
  assert.ok(hits.includes('res://art/player.png'));
});

test('createProject with null root degrades gracefully', () => {
  const project = createProject(null);
  assert.equal(project.fileExists('res://anything'), false);
  assert.deepEqual(project.findSimilarFiles('res://x.png', 3), []);
});
