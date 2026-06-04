# gdscript-lsp

A Claude Code plugin that gives Claude real-time GDScript intelligence inside
your Godot project — completions, diagnostics, go-to-definition, hover docs,
references, and symbols — by bridging Claude Code's stdio LSP transport to the
TCP language server that ships inside the Godot editor.

When no Godot LSP is reachable, the plugin auto-launches Godot in headless
editor mode for your project. When you already have the editor open, it reuses
that instance.

## Status

End-to-end verified against:

- Godot 4.6.3.stable.mono on macOS (Homebrew cask `godot-mono`)
- Node 18+ runtime
- Claude Code 2.x with `/plugin install`

A clean `initialize` round-trip from Claude Code through the bridge to a fresh
headless Godot returns the full `ServerCapabilities` (completion, definition,
hover, references, document/workspace symbols, signature help, semantic
tokens, code actions) in under 3 seconds once the headless editor has finished
its first-time project scan.

## What you get

Once installed and inside a Godot project, you can ask Claude things like:

- "Where is `apply_damage` defined?" — go-to-definition / find-references
- "What does `Node._physics_process(delta)` return?" — hover docs from Godot's
  built-in class database
- "List all functions in `player.gd`" — document symbols
- "Find every place that emits `health_changed`" — workspace symbol search
- "Why does this script not compile?" — live diagnostics from Godot's parser

All of this is served by Godot's own GDScript LSP, so the answers reflect your
actual project, your autoloads, and your installed plugins — not a generic
static parser.

Supported file types: `.gd`, `.gdshader`, `.gdshaderinc`.

## Resource & scene validation (.tscn / .tres)

In addition to the GDScript language server, this plugin ships a second,
zero-dependency language server that statically validates Godot text scenes
(`.tscn`) and resources (`.tres`). It needs no running Godot instance.

It reports, with fix suggestions where possible:

| Check | Severity | Fix offered |
|---|---|---|
| Referenced `ext_resource` file does not exist on disk | Error | "Did you mean res://…?" |
| `ExtResource("id")` / `SubResource("id")` id not declared in the file | Error | Nearest declared id |
| Missing required tag attributes (`path`/`type`/`id`, connection fields, …) | Error | — |
| `[resource]` in a `.tscn` / `[node]` in a `.tres` | Error | — |
| `format` newer than this Godot supports | Error | — |
| Invalid `uid://…` | Warning | Remove the uid attribute |
| Duplicate `ext_resource` / `sub_resource` id | Warning | Renumber |
| `load_steps` does not match the resource count | Info | Correct the number |

**Accuracy:** the validator mirrors the structural rules of Godot's own text
parser (`resource_format_text.cpp`), so it does not produce false positives on
valid files. Property/type-level validation (which Godot only performs at scene
instantiation) is **not** done statically — that is planned as an optional
Godot-backed deep-check in a future version. Binary `.scn`/`.res` files and
`project.godot` are out of scope.

## Quickstart

### Install from a local clone

```bash
git clone https://github.com/bognari/cc-gd-lsp ~/git/cc-gd-lsp
claude plugin marketplace add ~/git/cc-gd-lsp
claude plugin install gdscript-lsp@cc-gd-lsp
```

### Install from GitHub (once published)

```bash
claude plugin marketplace add bognari/cc-gd-lsp
claude plugin install gdscript-lsp@cc-gd-lsp
```

### Try without installing

```bash
claude --plugin-dir /path/to/cc-gd-lsp
```

After install, open Claude Code inside a directory that contains (or is nested
below) a `project.godot`. The LSP starts on demand when you open a `.gd` or
`.gdshader*` file.

> First launch: expect 20–40 seconds while Godot does its initial project
> import. Subsequent launches are near-instant because Godot reuses the
> import cache under `.godot/`.

## Prerequisites

- **Godot Engine 4.4+** — 4.5+ recommended for the most stable headless mode.
  Both the standard and Mono builds work.
- **Node.js 18+** on `$PATH` — used to run the bridge script.
- **Linux without a display** (CI, WSL, headless servers): install `xvfb`
  (`sudo apt install xvfb`). The bridge automatically wraps Godot with
  `xvfb-run -a` when no `DISPLAY` is set.

The bridge finds Godot by probing, in order:

1. `--godot <path>` argument, if passed
2. `$GODOT_PATH` environment variable
3. `$PATH` for `godot`, `godot4`, `godot-editor`, `Godot`, `godot-mono`,
   `godot4-mono`, `Godot_mono`
4. Platform fallbacks:
   - macOS: `/Applications/Godot.app/Contents/MacOS/Godot` and
     `/Applications/Godot_mono.app/Contents/MacOS/Godot` (the Mono cask's
     app bundle is named `Godot_mono.app` but the binary inside is `Godot`)
   - Windows: `C:\Program Files\Godot\godot.exe`, the same under
     `Program Files (x86)`, plus `Godot_mono\Godot.exe`
   - Linux: `/usr/bin/godot`, `/usr/local/bin/godot`, and the `-mono` variants

If you have both standard and Mono builds and want a specific one, pin it:

```bash
export GODOT_PATH="/Applications/Godot_mono.app/Contents/MacOS/Godot"
```

## How it works

```
┌──────────────┐   stdio   ┌──────────────────────┐   TCP    ┌────────────────┐
│ Claude Code  │ ◄───────► │ godot-lsp-bridge.js  │ ◄──────► │ Godot Editor   │
│              │           │ (this plugin)        │  :6005   │ (LSP server)   │
└──────────────┘           └──────────────────────┘          └────────────────┘
```

1. Claude Code spawns the bridge as the LSP `command`, passing LSP requests
   on stdin and reading responses from stdout.
2. The bridge probes `127.0.0.1:6005`. If the port is open it just connects.
3. If not, it walks up from the working directory to find a `project.godot`,
   then spawns Godot detached as
   `godot --editor --headless --display-driver headless --audio-driver Dummy --lsp-port <port> --path <project>`.
4. It waits up to `--launch-timeout` for the port to come up, then connects.
5. Bytes flow `stdin → socket` and `socket → stdout` for the lifetime of
   the session.
6. On `SIGINT` / `SIGTERM` / `SIGHUP` the bridge cleans up the detached Godot
   process group (`taskkill /T /F` on Windows).

The bridge does not modify the LSP byte stream. Godot speaks standard LSP
framing (`Content-Length: …\r\n\r\n` + JSON body) over a raw TCP socket — no
WebSocket handshake required.

## Configuration

The defaults (`127.0.0.1:6005`, auto-discover Godot, auto-find project) work
out of the box for most setups. To override, point the `.lsp.json` `args` at
the bridge with extra flags:

```json
{
  "gdscript": {
    "command": "node",
    "args": [
      "${CLAUDE_PLUGIN_ROOT}/bin/godot-lsp-bridge.js",
      "--port", "6008",
      "--godot", "/opt/godot/godot-mono",
      "--launch-timeout", "60000"
    ],
    "extensionToLanguage": {
      ".gd": "gdscript",
      ".gdshader": "gdshader",
      ".gdshaderinc": "gdshader"
    },
    "transport": "stdio"
  }
}
```

### Bridge flags

| Flag | Default | Description |
|---|---|---|
| `--host <addr>` | `127.0.0.1` | Host to connect to |
| `--port <num>` | `6005` | TCP port for Godot's LSP |
| `--godot <path>` | `$GODOT_PATH` | Explicit Godot executable |
| `--project <dir>` | cwd | Where to start looking for `project.godot` |
| `--launch-timeout <ms>` | `30000` | Max time to wait for headless Godot |
| `--no-launch` | off | Never auto-launch Godot; only connect if running |

### Environment variables

| Variable | Effect |
|---|---|
| `GODOT_PATH` | Explicit path to the Godot executable |
| `GODOT_PROJECT` | Explicit Godot project directory |
| `CLAUDE_PROJECT_DIR` | Set by Claude Code; used as fallback project root |

### Changing Godot's LSP port

By default Godot listens on `6005`. To change it, open Godot's editor and go
to *Editor → Editor Settings → Network → Language Server → Remote Port*, then
pass the same `--port` to the bridge.

## Troubleshooting

- **`Executable not found in $PATH`** in the Claude Code Errors tab → install
  Node.js so that `node --version` works in a non-interactive shell.
- **`could not find Godot executable`** in the bridge logs → set `GODOT_PATH`
  or pass `--godot <abs-path>` in `args`. Shell aliases (e.g. zsh's
  `godot=godot-mono`) are not visible from the bridge.
- **`could not find project.godot`** → start Claude Code inside (or below) a
  Godot project, or pass `--project <abs-path>`.
- **`timeout: Godot LSP did not open 127.0.0.1:6005 within 30000ms`** → raise
  `--launch-timeout` to `60000` or higher. First-time imports of larger
  projects can exceed 30 seconds. Alternatively, open the Godot editor once
  manually and let it finish importing.
- **`socket error: ECONNREFUSED`** after launch reported success → another
  process is using port `6005` between probe and connect. Re-run, or change
  Godot's LSP port (see above).
- **Port already in use by another Godot** (multiple projects open) → only
  one Godot LSP can bind a given port; either close the other instance, or
  give each project a distinct port via Editor Settings + `--port`.
- **`No DISPLAY detected and xvfb-run not found`** on Linux → install
  `xvfb` (`sudo apt install xvfb` or your distro's equivalent).

The bridge logs to stderr with the prefix `[gdscript-lsp]`. Claude Code shows
this in *Errors* and *Logs* tabs of the `/plugin` UI.

## Uninstall

```bash
claude plugin uninstall gdscript-lsp@cc-gd-lsp
claude plugin marketplace remove cc-gd-lsp   # optional
```

## Acknowledgments

The bridge approach (stdio↔TCP proxy, headless launch flags, cross-platform
process cleanup) is adapted from
[MasuRii/opencode-godot-lsp](https://github.com/MasuRii/opencode-godot-lsp),
which is MIT-licensed. This plugin removes the `languageId` rewriter from
that bridge because Claude Code's `extensionToLanguage` mapping already sets
the language identifier correctly.

Godot's LSP/DAP behavior is documented in the
[Godot manual](https://docs.godotengine.org/en/stable/tutorials/editor/external_editor.html#lsp-dap-support).
The protocol implementation lives in
[`modules/gdscript/language_server/`](https://github.com/godotengine/godot/tree/master/modules/gdscript/language_server).

## License

MIT — see [LICENSE](./LICENSE).
