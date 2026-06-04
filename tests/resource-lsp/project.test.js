const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createProject, findProjectRoot, resToAbs } = require('../../src/resource-lsp/project.js');

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

test('resToAbs maps res:// under the root', () => {
  const abs = resToAbs(PROJ, 'res://art/player.png');
  assert.equal(abs, path.join(PROJ, 'art', 'player.png'));
});

test('resToAbs rejects paths that escape the project root', () => {
  assert.equal(resToAbs(PROJ, 'res://../../etc/passwd'), null);
  assert.equal(resToAbs(PROJ, 'res://../secret.gd'), null);
});

test('resToAbs returns null for non-res paths or null root', () => {
  assert.equal(resToAbs(PROJ, '/abs/path'), null);
  assert.equal(resToAbs(null, 'res://x'), null);
});

test('findSimilarFiles matches case-insensitively', () => {
  const project = createProject(PROJ);
  const hits = project.findSimilarFiles('res://art/PLAYER.PNG', 3);
  assert.ok(hits.includes('res://art/player.png'));
});

test('fileExists rejects path-traversal escapes', () => {
  const project = createProject(PROJ);
  assert.equal(project.fileExists('res://../../etc/passwd'), false);
});
