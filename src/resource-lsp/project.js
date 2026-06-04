'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { distance } = require('./util.js');

function findProjectRoot(startDir) {
  let dir = path.resolve(startDir);
  for (let i = 0; i < 24; i++) {
    if (fs.existsSync(path.join(dir, 'project.godot'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function resToAbs(root, resPath) {
  if (!root || typeof resPath !== 'string' || !resPath.startsWith('res://')) return null;
  const abs = path.resolve(root, resPath.slice('res://'.length));
  const rel = path.relative(root, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null; // escapes the project root
  return abs;
}


async function listAllFilesAsync(root) {
  const out = [];
  const SKIP = new Set(['.godot', '.git', '.import', 'node_modules']);
  async function walk(dir) {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (SKIP.has(e.name)) continue;
        await walk(path.join(dir, e.name));
      } else if (e.isFile()) {
        const rel = path.relative(root, path.join(dir, e.name)).split(path.sep).join('/');
        out.push('res://' + rel);
      }
    }
  }
  await walk(root);
  return out;
}

function createProject(root) {
  let fileCache = [];
  let warming = false;
  let lastWarm = 0;
  const TTL_MS = 5000;

  function warm() {
    if (!root || warming) return;
    const now = Date.now();
    if (lastWarm > 0 && now - lastWarm < TTL_MS) return; // TTL applies after any completed walk, even an empty one
    warming = true;
    listAllFilesAsync(root)
      .then((files) => { fileCache = files; lastWarm = Date.now(); })
      .catch(() => {})
      .finally(() => { warming = false; });
  }

  if (root) warm();

  return {
    root,
    fileExists(resPath) {
      const abs = resToAbs(root, resPath);
      if (!abs) return false;
      try { return fs.existsSync(abs); } catch { return false; }
    },
    findSimilarFiles(resPath, max) {
      if (!root || typeof resPath !== 'string') return [];
      warm();
      const targetBase = resPath.split('/').pop().toLowerCase();
      if (!targetBase) return [];
      const threshold = Math.max(2, Math.floor(targetBase.length / 3));
      return fileCache
        .map((f) => ({ f, d: distance(targetBase, f.split('/').pop().toLowerCase()) }))
        .filter((x) => x.d <= threshold)
        .sort((a, b) => a.d - b.d)
        .slice(0, max)
        .map((x) => x.f);
    },
  };
}

module.exports = { createProject, findProjectRoot, resToAbs };
