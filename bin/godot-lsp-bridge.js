#!/usr/bin/env node
/*
 * GDScript LSP bridge for Claude Code.
 *
 * Claude Code speaks LSP over stdio. Godot exposes its built-in GDScript LSP
 * over TCP (default port 6005), and the server lives inside the editor binary.
 * This script bridges the two: it connects to a running Godot LSP if one is
 * reachable, otherwise it launches Godot in headless editor mode and waits
 * for the port to come up, then pipes stdin <-> socket <-> stdout.
 *
 * Adapted from MasuRii/opencode-godot-lsp (MIT).
 */

'use strict';

const net = require('node:net');
const { spawn, spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const LOG_PREFIX = '[gdscript-lsp]';
const log = (...a) => console.error(LOG_PREFIX, ...a);

const platform = os.platform();
const isWindows = platform === 'win32';
const isLinux = platform === 'linux';

function parseArgs(argv) {
  const out = {
    host: '127.0.0.1',
    port: 6005,
    godot: process.env.GODOT_PATH || null,
    project: process.env.GODOT_PROJECT || process.env.CLAUDE_PROJECT_DIR || process.cwd(),
    launchTimeoutMs: 30000,
    noLaunch: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case '--host': out.host = next(); break;
      case '--port': out.port = Number.parseInt(next(), 10); break;
      case '--godot': out.godot = next(); break;
      case '--project': out.project = next(); break;
      case '--launch-timeout': out.launchTimeoutMs = Number.parseInt(next(), 10); break;
      case '--no-launch': out.noLaunch = true; break;
      default:
        log(`warning: ignoring unknown argument "${a}"`);
    }
  }
  return out;
}

function fileExists(p) {
  try { return fs.existsSync(p); } catch { return false; }
}

function lookupOnPath(name) {
  // Use execFile semantics (no shell) by passing program + args separately.
  const cmd = isWindows ? 'where' : 'which';
  const res = spawnSync(cmd, [name], { encoding: 'utf8', timeout: 3000 });
  if (res.status !== 0 || !res.stdout) return null;
  const first = res.stdout.trim().split(/\r?\n/)[0];
  return first || null;
}

function findGodotExecutable(explicit) {
  if (explicit && fileExists(explicit)) return explicit;

  const candidates = [];
  if (explicit) candidates.push(explicit);

  // Mono variants ship under different names than the standard build.
  // Order: prefer non-mono first if user didn't pin via $GODOT_PATH.
  const cliNames = [
    'godot', 'godot4', 'godot-editor', 'Godot',
    'godot-mono', 'godot4-mono', 'Godot_mono',
  ];
  for (const name of cliNames) {
    const found = lookupOnPath(name);
    if (found) candidates.push(found);
  }

  if (isWindows) {
    candidates.push(
      String.raw`C:\Program Files\Godot\godot.exe`,
      String.raw`C:\Program Files (x86)\Godot\godot.exe`,
      String.raw`C:\Program Files\Godot_mono\Godot.exe`,
      String.raw`C:\Program Files (x86)\Godot_mono\Godot.exe`,
    );
  } else if (platform === 'darwin') {
    // Homebrew casks land here: `godot` → Godot.app, `godot-mono` → Godot_mono.app
    const home = os.homedir();
    candidates.push(
      '/Applications/Godot.app/Contents/MacOS/Godot',
      `${home}/Applications/Godot.app/Contents/MacOS/Godot`,
      // The Mono cask app bundle is named Godot_mono.app, but the binary
      // inside is still called `Godot`.
      '/Applications/Godot_mono.app/Contents/MacOS/Godot',
      `${home}/Applications/Godot_mono.app/Contents/MacOS/Godot`,
    );
  } else if (isLinux) {
    candidates.push(
      '/usr/bin/godot', '/usr/local/bin/godot',
      '/usr/bin/godot-mono', '/usr/local/bin/godot-mono',
    );
  }

  for (const c of candidates) {
    if (c && fileExists(c)) return c;
  }
  return null;
}

function findProjectRoot(start) {
  let dir = path.resolve(start);
  for (let i = 0; i < 12; i++) {
    if (fileExists(path.join(dir, 'project.godot'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function isPortOpen(port, host, timeoutMs = 800) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => finish(true));
    sock.once('error', () => finish(false));
    sock.once('timeout', () => finish(false));
    sock.connect(port, host);
  });
}

async function waitForPort(port, host, deadline) {
  while (Date.now() < deadline) {
    if (await isPortOpen(port, host)) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

let spawnedGodot = null;

function buildGodotArgs(port, projectRoot) {
  // --editor is required: the LSP server only runs in editor mode.
  // --headless + display/audio dummies keep it invisible.
  return [
    '--editor',
    '--headless',
    '--display-driver', 'headless',
    '--audio-driver', 'Dummy',
    '--lsp-port', String(port),
    '--path', projectRoot,
  ];
}

async function launchGodot(opts) {
  const godot = findGodotExecutable(opts.godot);
  if (!godot) {
    log('could not find Godot executable. Set GODOT_PATH or pass --godot <path>.');
    return false;
  }
  const projectRoot = findProjectRoot(opts.project);
  if (!projectRoot) {
    log(`could not find project.godot from "${opts.project}". Pass --project <dir> or run inside a Godot project.`);
    return false;
  }

  const args = buildGodotArgs(opts.port, projectRoot);
  log(`launching Godot headless: ${godot} ${args.join(' ')}`);

  const spawnOpts = {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  };

  if (isLinux && !process.env.DISPLAY) {
    const xvfb = lookupOnPath('xvfb-run');
    if (xvfb) {
      log('no DISPLAY detected, wrapping with xvfb-run');
      spawnedGodot = spawn('xvfb-run', ['-a', godot, ...args], spawnOpts);
    } else {
      log('no DISPLAY and xvfb-run unavailable, attempting --headless directly');
      spawnedGodot = spawn(godot, args, spawnOpts);
    }
  } else {
    spawnedGodot = spawn(godot, args, spawnOpts);
  }
  spawnedGodot.unref();

  const deadline = Date.now() + opts.launchTimeoutMs;
  const ready = await waitForPort(opts.port, opts.host, deadline);
  if (!ready) {
    log(`timeout: Godot LSP did not open ${opts.host}:${opts.port} within ${opts.launchTimeoutMs}ms`);
    return false;
  }
  log(`Godot LSP ready on ${opts.host}:${opts.port}`);
  return true;
}

function killSpawnedGodot() {
  if (!spawnedGodot?.pid) return;
  try {
    if (isWindows) {
      spawnSync('taskkill', ['/pid', String(spawnedGodot.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      // Negative PID targets the detached process group.
      process.kill(-spawnedGodot.pid, 'SIGTERM');
    }
  } catch { /* already gone */ }
}

function attachSignalHandlers(socket) {
  const cleanup = () => {
    try { socket.end(); } catch {}
    killSpawnedGodot();
    process.exit(0);
  };
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
  process.on('SIGHUP', cleanup);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  let reachable = await isPortOpen(opts.port, opts.host);
  if (!reachable && !opts.noLaunch) {
    reachable = await launchGodot(opts);
  }
  if (!reachable) {
    log('failed to reach Godot LSP. Start the Godot editor for this project, or ensure `godot` is on PATH.');
    process.exit(1);
  }

  const socket = net.createConnection({ host: opts.host, port: opts.port });

  socket.on('connect', () => {
    log(`connected to Godot LSP at ${opts.host}:${opts.port}`);
    process.stdin.pipe(socket);
    socket.pipe(process.stdout);
  });

  socket.on('error', (err) => {
    log(`socket error: ${err.message}`);
    process.exit(1);
  });

  socket.on('close', () => process.exit(0));

  attachSignalHandlers(socket);
}

main().catch((err) => {
  log(`fatal: ${err?.stack || err}`);
  process.exit(1);
});
