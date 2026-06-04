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

// Fix 2: strip ANSI escape codes before parsing (CI/FORCE_COLOR/ConPTY can emit them)
const ANSI_RE = /\x1b\[[0-9;]*m/g;

// Fix 1: per-call monotonic counter so concurrent runDeepCheck calls never share a temp filename
let runCounter = 0;

// Fix 3: classify uses the error KIND for SCRIPT ERROR first, then message content
function classify(message, kind) {
  if (kind === 'SCRIPT ERROR') return 'deep-script-error';
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
    // Fix 2: strip ANSI before matching so ^-anchored LINE_RE works in CI
    const m = LINE_RE.exec(raw.trim().replace(ANSI_RE, ''));
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
      // Fix 3: pass kind so SCRIPT ERROR is handled by kind, not message content
      code: classify(message, kind),
      source: SOURCE,
      message: message.trim(),
    };
    if (!byUri.has(uri)) byUri.set(uri, []);
    byUri.get(uri).push(diag);
  }
  return byUri;
}

// Copies deep_check.gd into the project (so res:// resolves), spawns Godot, returns the parsed map.
// Uses a leading-dot pid+counter-suffixed name: editor-hidden, skipped by the script's own _scan, collision-safe.
function runDeepCheck(root, opts = {}) {
  return new Promise((resolve) => {
    const godot = opts.godotPath || locateGodot();
    if (!godot || !root) {
      // Fix 6: observable failure path — caller can distinguish "clean scan" from "did not run"
      process.stderr.write('[godot-resource] deep-check skipped: godot not found or no project root\n');
      return resolve(new Map());
    }

    const src = path.join(__dirname, '..', '..', 'scripts', 'deep_check.gd');
    // Fix 1: append per-call monotonic counter to avoid temp-file collision on concurrent calls
    const baseName = `.lsp_deep_check_${process.pid}_${++runCounter}.gd`;
    const dest = path.join(root, baseName);
    try {
      fs.copyFileSync(src, dest);
    } catch {
      // Fix 6: surface staging failure so caller knows this path was hit
      process.stderr.write('[godot-resource] deep-check: failed to stage tool-script (scripts/deep_check.gd missing?)\n');
      return resolve(new Map());
    }
    const relScript = 'res://' + baseName;

    const child = spawn(godot, ['--headless', '--path', root, '--script', relScript], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // Fix 5: bounded output buffer — kill and stop accumulating past 10 MB
    const MAX_BUF = 10 * 1024 * 1024; // 10 MB
    let buf = '';
    const onData = (c) => {
      if (buf.length >= MAX_BUF) return;
      buf += c.toString('utf8');
      if (buf.length >= MAX_BUF) { try { child.kill('SIGKILL'); } catch {} }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);

    // Fix 4: use != null so timeoutMs: 0 is honoured (falsy trap avoided)
    const timeoutMs = opts.timeoutMs != null ? opts.timeoutMs : 60000;
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, timeoutMs);

    // Fix 7: keep a reference to the abort handler so it can be removed in finish()
    let abortHandler = null;
    if (opts.signal) {
      abortHandler = () => { try { child.kill('SIGKILL'); } catch {} };
      opts.signal.addEventListener('abort', abortHandler, { once: true });
    }

    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Fix 7: remove the abort listener to prevent a leak on a long-lived signal
      if (opts.signal && abortHandler) opts.signal.removeEventListener('abort', abortHandler);
      try { fs.rmSync(dest, { force: true }); } catch {}
      resolve(parseGodotOutput(buf, root));
    };
    child.on('close', finish);
    child.on('error', (err) => {
      process.stderr.write(`[godot-resource] deep-check: child process error: ${err.message}\n`);
      finish();
    });
  });
}

module.exports = { parseGodotOutput, runDeepCheck };
