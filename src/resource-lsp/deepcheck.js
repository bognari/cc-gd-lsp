'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { locateGodot } = require('./godot-locate.js');

const SOURCE = 'godot-resource (deep)';

// Godot prints e.g.:
//   ERROR: res://foo.tscn:3 - Parse Error: Can't create sub resource of type 'X'.
//   WARNING: res://foo.tscn:4 - ext_resource, invalid UID: ...
const LINE_RE = /^(ERROR|WARNING|SCRIPT ERROR):\s*(res:\/\/[^\s:]+):(\d+)\s*-\s*(.*)$/;

function classify(message) {
  if (/referenced non-existent resource|Resource file not found/i.test(message)) return 'deep-missing-dep';
  if (/Can't create sub resource|Cannot get class/i.test(message)) return 'deep-unknown-class';
  if (/script/i.test(message)) return 'deep-script-error';
  if (/Parse Error/i.test(message)) return 'deep-parse-error';
  return 'deep-generic';
}

function resToUri(resPath, root) {
  const rel = resPath.slice('res://'.length);
  return pathToFileURL(path.join(root, rel)).href;
}

function parseGodotOutput(text, root) {
  const byUri = new Map();
  const seen = new Set();
  for (const raw of text.split(/\r?\n/)) {
    const m = LINE_RE.exec(raw.trim());
    if (!m) continue;
    const [, kind, resPath, lineStr, message] = m;
    const uri = resToUri(resPath, root);
    const line = Math.max(0, Number.parseInt(lineStr, 10) - 1);
    const severity = kind === 'WARNING' ? 2 : 1;
    const dedupKey = `${uri}|${line}|${message}`;
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);
    const diag = {
      range: { start: { line, character: 0 }, end: { line, character: 200 } },
      severity,
      code: classify(message),
      source: SOURCE,
      message: message.trim(),
    };
    if (!byUri.has(uri)) byUri.set(uri, []);
    byUri.get(uri).push(diag);
  }
  return byUri;
}

// Copies deep_check.gd into the project (so res:// resolves), spawns Godot, returns the parsed map.
// Uses a leading-dot pid-suffixed name: editor-hidden, skipped by the script's own _scan, collision-safe.
function runDeepCheck(root, opts = {}) {
  return new Promise((resolve) => {
    const godot = opts.godotPath || locateGodot();
    if (!godot || !root) return resolve(new Map());

    const src = path.join(__dirname, '..', '..', 'scripts', 'deep_check.gd');
    const baseName = `.lsp_deep_check_${process.pid}.gd`;
    const dest = path.join(root, baseName);
    try {
      fs.copyFileSync(src, dest);
    } catch {
      return resolve(new Map());
    }
    const relScript = 'res://' + baseName;

    const child = spawn(godot, ['--headless', '--path', root, '--script', relScript], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let buf = '';
    const onData = (c) => { buf += c.toString('utf8'); };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);

    const timeoutMs = opts.timeoutMs || 60000;
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, timeoutMs);

    if (opts.signal) {
      opts.signal.addEventListener('abort', () => { try { child.kill('SIGKILL'); } catch {} }, { once: true });
    }

    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { fs.rmSync(dest, { force: true }); } catch {}
      resolve(parseGodotOutput(buf, root));
    };
    child.on('close', finish);
    child.on('error', finish);
  });
}

module.exports = { parseGodotOutput, runDeepCheck };
