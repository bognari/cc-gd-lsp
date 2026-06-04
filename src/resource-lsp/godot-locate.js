'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const platform = os.platform();
const isWindows = platform === 'win32';

function fileExists(p) {
  try { return fs.existsSync(p); } catch { return false; }
}

function lookupOnPath(name) {
  const cmd = isWindows ? 'where' : 'which';
  const res = spawnSync(cmd, [name], { encoding: 'utf8', timeout: 3000 });
  if (res.status !== 0 || !res.stdout) return null;
  const first = res.stdout.trim().split(/\r?\n/)[0];
  return first || null;
}

function locateGodot(explicit) {
  if (explicit && fileExists(explicit)) return explicit;
  const fromEnv = process.env.GODOT_PATH;
  if (fromEnv && fileExists(fromEnv)) return fromEnv;

  const candidates = [];
  for (const name of ['godot', 'godot4', 'godot-editor', 'Godot', 'godot-mono', 'godot4-mono', 'Godot_mono']) {
    const found = lookupOnPath(name);
    if (found) candidates.push(found);
  }
  if (isWindows) {
    candidates.push(
      String.raw`C:\Program Files\Godot\godot.exe`,
      String.raw`C:\Program Files\Godot_mono\Godot.exe`,
    );
  } else if (platform === 'darwin') {
    const home = os.homedir();
    candidates.push(
      '/Applications/Godot.app/Contents/MacOS/Godot',
      `${home}/Applications/Godot.app/Contents/MacOS/Godot`,
      '/Applications/Godot_mono.app/Contents/MacOS/Godot',
      `${home}/Applications/Godot_mono.app/Contents/MacOS/Godot`,
    );
  } else {
    candidates.push('/usr/bin/godot', '/usr/local/bin/godot', '/usr/bin/godot-mono', '/usr/local/bin/godot-mono');
  }
  for (const c of candidates) if (c && fileExists(c)) return c;
  return null;
}

module.exports = { locateGodot };
