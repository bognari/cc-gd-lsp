'use strict';

const fs = require('node:fs');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const platform = os.platform();
const isWindows = platform === 'win32';

function fileExists(p) {
  try { return fs.existsSync(p); } catch { return false; }
}

function lookupOnPath(name) {
  const cmd = isWindows ? 'where' : 'which';
  const res = spawnSync(cmd, [name], { encoding: 'utf8', timeout: 1500 });
  if (res.status !== 0 || !res.stdout) return null;
  const first = res.stdout.trim().split(/\r?\n/)[0];
  return first || null;
}

function platformFallbacks() {
  if (isWindows) {
    return [
      String.raw`C:\Program Files\Godot\godot.exe`,
      String.raw`C:\Program Files (x86)\Godot\godot.exe`,
      String.raw`C:\Program Files\Godot_mono\Godot.exe`,
      String.raw`C:\Program Files (x86)\Godot_mono\Godot.exe`,
    ];
  }
  if (platform === 'darwin') {
    const home = os.homedir();
    return [
      '/Applications/Godot.app/Contents/MacOS/Godot',
      `${home}/Applications/Godot.app/Contents/MacOS/Godot`,
      '/Applications/Godot_mono.app/Contents/MacOS/Godot',
      `${home}/Applications/Godot_mono.app/Contents/MacOS/Godot`,
    ];
  }
  return ['/usr/bin/godot', '/usr/local/bin/godot', '/usr/bin/godot-mono', '/usr/local/bin/godot-mono'];
}

function locateGodot(explicit) {
  if (explicit && fileExists(explicit)) return explicit;
  const fromEnv = process.env.GODOT_PATH;
  if (fromEnv && fileExists(fromEnv)) return fromEnv;

  // Short-circuit: return on the first name found on PATH (avoids running all
  // 7 `which`/`where` probes when an earlier name already resolves).
  for (const name of ['godot', 'godot4', 'godot-editor', 'Godot', 'godot-mono', 'godot4-mono', 'Godot_mono']) {
    const found = lookupOnPath(name);
    if (found) return found;
  }
  for (const c of platformFallbacks()) {
    if (fileExists(c)) return c;
  }
  return null;
}

module.exports = { locateGodot };
