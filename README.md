# Barang — lightweight desktop code editor + Kilo Code agents

Sublime-grade speed, Cursor-grade brains, zero cloud accounts. A **native
desktop app** (Electron + Monaco) with the **Kilo Code CLI bundled inside the
installer** — it works out of the box: no install steps, no API keys, no login.
The agent runs on Kilo Code's **free models** (`kilo/auto` → `kilo/kilo-auto/free`
by default), whose credentials live entirely inside your `kilo` CLI.

> **Why Kilo Code?** Kilo Code is an open-source, OpenCode-compatible agent CLI.
> Its `kilo serve` speaks the same local HTTP API (sessions, `/event` SSE,
> agents, permissions) as OpenCode, so Barang drives it exactly the same way —
> but with Kilo's free model tiers (`kilo-auto/free`) and no paid-only gating.

## Requirements

- **Node.js 20+** (dev / `npm start` only — the packaged app needs nothing)
- **Nothing else.** The Kilo Code CLI ships in `vendor/` (fetched at build
  time) and installs with the app. If you prefer your own, Barang still
  detects a system install as fallback.

## Run

```sh
npm run setup   # one time: install root + web deps
npm start       # launch the desktop app
npm run dev     # app + Vite hot-reload for UI iteration
```

On first launch Barang opens your **Documents** folder — use
**File → Open Folder** (or `Ctrl+O`) to point it at any project. The agent
server restarts on the new root automatically (choice is remembered).

Double-clickable build (includes Kilo Code — no separate install needed):

```sh
npm run dist:portable   # → release/Barang-<version>-win.exe (portable, no install)
npm run dist            # → release/win-unpacked/ (folder build)
```

`npm run fetch:kilo` pins the CLI (`scripts/fetch-kilo.js`,
default 7.8.27, override with `--version` / `BARANG_KILO_VERSION`).
`vendor/` is git-ignored and refreshed on every `dist` build.

> First launch of the unsigned `.exe` may pause on Windows SmartScreen —
> choose “More info → Run anyway”. Signing is the follow-up when you want to
> distribute it.

## How it works

```
Renderer (sandboxed, no Node) ──IPC──▶  Shell main (Node/Electron)
  Monaco editor    →  fs:*        →  root-confined workspace ops
  Agent panel      →  oc:call     →  direct fetch to owned `kilo serve`
                    ←  kilo:event ←  main pumps upstream /event SSE + forwards
  Menu / Open Folder → app:*      →  dialog, root switch (server restart)
```

- **No HTTP bridge, no ports to manage.** Main owns `kilo serve` (random
  loopback port) and kills its whole tree on quit — no orphaned servers
  squatting ports.
- **Direct binary spawn.** Main resolves the real `kilo.exe` (npm global
  bin, PATH, `~/.kilo/bin`, or `vendor/`) and spawns it shell-free; the npm
  shim is only a fallback. Server auth (`KILO_SERVER_*` env) is injected in
  main; the renderer never sees credentials.
- **Live agent updates.** Main holds one upstream `/event` stream
  (auto-reconnect with backoff) and forwards frames to the UI, which
  re-fetches the active session debounced. The server is the source of truth.
- **Agent edits appear automatically.** Clean tabs reload from disk on focus
  and after runs; dirty tabs keep your edits and show a toast.
- **Hardened renderer.** `sandbox:true`, `contextIsolation`, no
  `nodeIntegration`; preload exposes a minimal typed API. External links open
  in your real browser.

## Keybindings

`Ctrl+P` quick open · `Ctrl+Shift+P` commands (`>`) · `Ctrl+Shift+F` search
in files (`#`) · `Ctrl+O` open folder · `Enter` send / `Shift+Enter` newline ·
`Ctrl+S` save · ``Ctrl+` `` agent panel · `@` attach file · `Esc` close palette

## Project layout

```
electron/main/index.js        app lifecycle, menu, IPC, headless smokes
electron/main/kilo.js         find/spawn/wait-ready/auth/tree-kill for `kilo serve`
electron/main/kiloClient.js   direct kilo calls + /event pump w/ reconnect
electron/main/files.js        root-confined fs ops (tree/read/atomic-write/find/search/mkdir)
electron/main/git.js          git subprocess (no shell) for Source Control
electron/main/relay.js        `kilo run` CLI Relay (allowlisted, shell-free)
electron/preload.cjs          contextBridge API
web/src/main.ts               app shell + layout + keybindings
web/src/lib/transport.ts      typed window.barang access (desktop-only, fail-fast)
web/src/lib/agent.ts          sessions, model/agent pickers, event bus, approvals
web/src/ui/                   explorer · editor (lazy Monaco) · chat · palette · statusbar
scripts/fetch-kilo.js         vendors the Kilo Code CLI into vendor/
scripts/dev-electron.js       dev runner (Vite + Electron)
```

## Lightweight story

- Shell first paint ≈ **30KB JS** (no framework; Monaco lazy chunk; workers
  via Vite `?worker`).
- One window, one main process, one `kilo serve` you were going to run anyway.
- Perf choices: lazy depth-1 tree, debounced fuzzy find, 1MB read cap +
  binary sniff, ripgrep fast-path with built-in fallback, atomic writes,
  GET-only cold-boot retries (POSTs fail fast, never duplicate).

## Verify (headless, no display needed)

```sh
npm run smoke      # backend: kilo spawn, fs roundtrip, agents, session lifecycle
npm run smoke:ui   # render: hidden window paints shell, zero console errors
```

Both exit non-zero on failure. (Boot-stage log: `%TEMP%\barang-boot.log`.)

## Troubleshooting

- **Install banner** → `npm install -g @kilocode/cli`, restart terminal, restart Barang.
- **Agent errors in chat** → shown inline; resend usually suffices after a cold boot.
- **Port already in use** → a pre-Barang `kilo serve` orphaned:
  `Get-NetTCPConnection -LocalPort <n>` → `taskkill /F /T /PID <pid>`.
- **Model shows “auto”** → pick any `provider/model`; the list comes from your
  Kilo login (`/config/providers`). `kilo/kilo-auto/free` is the default free tier.

## Roadmap

- Session diff view (`/session/:id/diff`) with per-file accept/reject
- Split editors, multi-root, git status, token/cost meter
- App icon + code signing for clean SmartScreen