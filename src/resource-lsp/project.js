'use strict';

const fs = require('node:fs');
const path = require('node:path');

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

// Levenshtein distance, small inputs only.
function distance(a, b) {
  const m = a.length;
  const n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }
  return dp[m][n];
}

function listAllFiles(root) {
  const out = [];
  const SKIP = new Set(['.godot', '.git', '.import', 'node_modules']);
  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (SKIP.has(e.name)) continue;
        walk(path.join(dir, e.name));
      } else if (e.isFile()) {
        const rel = path.relative(root, path.join(dir, e.name)).split(path.sep).join('/');
        out.push('res://' + rel);
      }
    }
  }
  walk(root);
  return out;
}

function createProject(root) {
  let fileCache = null;
  let cacheTime = 0;
  const TTL_MS = 5000;

  function files() {
    if (!root) return [];
    const now = Date.now();
    if (!fileCache || now - cacheTime > TTL_MS) {
      fileCache = listAllFiles(root);
      cacheTime = now;
    }
    return fileCache;
  }

  return {
    root,
    fileExists(resPath) {
      const abs = resToAbs(root, resPath);
      if (!abs) return false;
      try {
        return fs.existsSync(abs);
      } catch {
        return false;
      }
    },
    findSimilarFiles(resPath, max) {
      if (!root || typeof resPath !== 'string') return [];
      const targetBase = resPath.split('/').pop().toLowerCase();
      if (!targetBase) return [];
      const threshold = Math.max(2, Math.floor(targetBase.length / 3));
      return files()
        .map((f) => ({ f, d: distance(targetBase, f.split('/').pop().toLowerCase()) }))
        .filter((x) => x.d <= threshold)
        .sort((a, b) => a.d - b.d)
        .slice(0, max)
        .map((x) => x.f);
    },
  };
}

module.exports = { createProject, findProjectRoot, resToAbs };
