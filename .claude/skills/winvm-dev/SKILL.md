---
name: winvm-dev
description: Use when running, launching, building, testing, screenshotting or debugging winvm locally in any configuration - the `winvm` CLI against a Windows VM, the Tauri Mac app (build, open, logs, quit), UI work without a VM (Playwright WebKit renders), `pnpm check` and single-package tests, scenario tests against a real machine, worktrees or parallel agents, and "why won't it run" failures (missing runtime, QEMU/save mismatch, pnpm policy, Rust toolchain, Playwright). Not for cutting releases (use winvm-release).
---

# winvm-dev

Verified = run or read in this repo (file cited). `UNVERIFIED` = not run here; check before relying on it.
Rules of thumb: pass `-i <name>` on every instance command; never touch the person's `default` or `pi` instances; one build per checkout.

## 1. Which configuration do I need?

| Task | Needs | Go to |
|---|---|---|
| Edit core/CLI/UI code, check it | mise + `pnpm install`. No VM, no QEMU, no Rust | 2, 4 |
| Change how a screen looks | Built UI + Playwright WebKit in `/tmp/pw`. No VM | 7 |
| Run a CLI verb that needs Windows (`exec`, `put`, `save`...) | Pinned runtime (`winvm setup`) + built base image + a running instance | 5 |
| Try the Mac app | Rust (apps/viewer only), runtime, a long Cargo build; a VM only to see a live screen | 6 |
| Prove app/CLI behaviour over time on a real guest | Running scratch instance, runtime | 8 |
| Build the first Windows image | Win11 ARM64 ISO, ~20 min, ~15 GB | 2, 5 |

## 2. First-time setup from source
```sh
mise install        # bun (from .bun-version, 1.4.3) + pnpm 12.3.4 (mise.toml)
pnpm install        # per checkout; every worktree needs its own node_modules
winvm doctor        # read-only host check
winvm setup         # fetches pinned runtime + guest tools ISO + PowerShell 7
```
- `setup` = `ensureRuntime()` (QEMU, swtpm, zstd from `packages/core/runtime.json`, a `stuffbucket/winvm-runtime` release pinned by sha256, cached in `~/.local/share/winvm/runtime/<version>`) then downloads the guest tools ISO and pwsh MSI into `~/.local/state/winvm/media` (`packages/core/src/commands.ts` `setup`, `runtime.ts`). `--no-media` skips the media.
- Verified: `winvm doctor` prints `ok runtime 11.1.2-2 (QEMU 11.1.2, cache)`; its source is `override` (WINVM_RUNTIME), `app` (inside a .app) or `cache`.
- Only the ISO is manual: `--iso <path>`, `WINVM_ISO`, or an `arm64` ISO in `~/vm` / `~/isos`. Not in `~/Downloads` (docs/setup.md).

## 3. Getting `winvm` to run the right checkout
| Where | Command |
|---|---|
| Inside the repo, mise active | `winvm ...` (mise.toml puts `node_modules/.bin` on PATH) |
| No mise activation, or a worktree | `mise exec -- winvm ...` or `pnpm winvm ...` (root script `bun apps/cli/src/winvm.ts`) |
| Elsewhere | `mise exec -C <repo> -- winvm ...` (README) |

GOTCHA (observed): a shell started in the main checkout had `winvm` on PATH pointing at the MAIN checkout's `node_modules/.bin/winvm`, while `mise exec -- which winvm` inside the worktree gave the worktree's. In a worktree always use `mise exec -- winvm` or `pnpm winvm`, after `pnpm install` there. Wrong Bun prints a pin warning (`paths.ts bunVersionWarning`).

## 4. Quality gate (no VM)
```sh
mise exec -- pnpm check                          # turbo typecheck+test, then `bun test scripts`; CI runs this
mise exec -- pnpm exec turbo run typecheck test --force   # bypass turbo cache (verified: 9 tasks, ~43 s; cached ~2 s)
mise exec -- pnpm --filter @winvm/viewer test    # one package (also @winvm/core, @winvm/canvas, @winvm/terminal)
cd packages/core && mise exec -- bun test tests/paths.test.ts   # one file
cd apps/viewer && mise exec -- pnpm typecheck    # tsc + CSS tokens --check + design-token lint
cd apps/viewer && mise exec -- pnpm tokens       # regenerate CSS tokens (apps/viewer/package.json)
bun apply-pnpm-tarball-policy.mjs --check        # lockfile policy; verified "pnpm-lock.yaml: clean"
```
Covers: tsc in all packages, bun tests in core/canvas/terminal/viewer, `scripts/*.test.ts`. Never needs Rust, QEMU or Windows. Commit subjects must be Conventional Commits (`scripts/check-commit-msg.ts`; types build chore ci docs feat fix perf refactor revert style test).

## 5. CLI against a VM
State (`packages/core/src/paths.ts`, `xdg.ts`, docs/saves.md, docs/background.md):

| Path | Holds |
|---|---|
| `~/.local/state/winvm` (`WINVM_HOME`) | `images/<image>/base.qcow2` (read-only, shared), `instances/<name>/` (overlay, `qemu.log`, `serial.log`, `watch.log`, `events.jsonl`, `control.sock`, `vncpassword`), `saves/<name>/`, `media/`, `firmware/` |
| `~/.local/share/winvm` (`XDG_DATA_HOME`) | `runtime/<version>/`, `notes/<instance>/` |
| `~/.config/winvm` (`XDG_CONFIG_HOME`) | `settings.json` (shared by every instance and the app) |

Image = built once (`winvm build --iso <iso>`, ~20 min, unattended). Instance = copy-on-write overlay on an image; `start` creates it if missing.

```sh
winvm ls                                  # read-only: images, instances, disk use
winvm create -i dev-x [--image NAME]      # new instance, not started
winvm start -i dev-x                      # ~35 s to desktop (README); creates if missing
winvm status -i dev-x --json              # no -i + several instances = table
winvm exec -i dev-x -- cmd.exe /c ver     # run in guest
winvm put -i dev-x ./f.txt 'C:\f.txt'; winvm get -i dev-x 'C:\f.txt' ./out.txt
winvm screenshot -i dev-x /tmp/s.png      # headless; then Read the PNG
winvm files open -i dev-x [c]             # Finder mount at ~/winvm/<name>/{C,Home}
winvm terminal -i dev-x --connect --json  # agents: URL for a client (plain `terminal` needs a TTY)
winvm agent -i dev-x connect --json       # in-guest agent address+token
winvm mcp -i dev-x                        # guest as MCP server on stdio
winvm diagnose -i dev-x                   # first stop when a guest misbehaves
winvm stop -i dev-x ; winvm destroy -i dev-x   # destroy removes instance + saves, image untouched
```
Every verb: `winvm help`.

### Throwaway dev instance without touching a person's instances
- No `-i` and no `WINVM_INSTANCE` means instance `default` (`winvm help`). `start/stop/reset/kill/destroy` with no `-i` hit the person's machine. Export `WINVM_INSTANCE=dev-<topic>` for the shell, still pass `-i`.
- Instances are separate dirs; "one instance never touches another's" (`paths.ts`). A uniquely named instance in the REAL home is the supported way: it shares only the read-only image, `settings.json` and `~/winvm/<name>` is per-name. VNC display collisions are auto-resolved at start (`vnc.ts ensureFreeDisplay`).
- `WINVM_HOME=/tmp/x` isolates images, instances, saves, media, firmware. It does NOT isolate `~/.config/winvm`, `~/.local/share/winvm` (notes, runtime cache). It starts with no image: build one (ISO) or UNVERIFIED symlink `$WINVM_HOME/images/<image>` to the real one (overlay backing path is `basePath(image)`, absolute, `instance.ts createOverlay`; not run).
- If you set `XDG_DATA_HOME`, the runtime cache moves with it: also set `WINVM_RUNTIME=~/.local/share/winvm/runtime/<version>` (or `WINVM_RUNTIME_CACHE`) (`runtime.ts runtimeCache`).
- Avoid globals: `setup`, `prune`, `rmi`, `web --stop`, `timemachine`.
- A fresh instance is 4 CPUs / 8 GB (docs/setup.md); `winvm config -i x cpus=2 memory=4G` applies next boot.

## 6. The Mac app
```sh
# from the repo root; NOTE the path is relative to apps/viewer because of -C
mise -C apps/viewer exec -- bun scripts/build-app.ts          # no argument!
open apps/viewer/src-tauri/target/release/bundle/macos/winvm.app
```
`build-app.ts` steps (`apps/viewer/scripts/build-app.ts`): `build-ui.ts` (Bun bundle to `dist/`, index/terminal/files.html) -> `build-sidecar.ts` (`bun build --compile` CLI to `src-tauri/binaries/winvm-aarch64-apple-darwin`) -> deletes old `.app` -> `pnpm exec tauri build --bundles app` -> `stage.ts` (copies `.bun-version`, core `assets/ firmware/ web/`, and the verified pinned runtime into `Contents/Resources`; downloads runtime unless `WINVM_RUNTIME` set) -> `sign-list.ts --check` (must match `.macos-builder/config` `sign_nested`) -> checks Info.plist version and `Contents/MacOS/winvm`.
- A version argument (`build-app.ts 0.1.4`) REWRITES `tauri.conf.json`; release-only, never locally.
- Rust 1.99.0 comes only from `apps/viewer/mise.toml`. Cold Cargo build time: UNVERIFIED (not run; budget many minutes, incremental much less). Not run in worktrees concurrently with another build.
- It deletes the old `.app` first: quit a running copy from that path before rebuilding.
- Layout: shell `Contents/MacOS/winvm-viewer`; CLI sidecar `Contents/MacOS/winvm` (Tauri `externalBin`, called through `src-tauri/src/lib.rs` `winvm` command, whitelist `VERBS`); runtime `Contents/Resources/runtime` (found by `runtime.ts appRuntimeDir` from the exe path, so the app does not need the cache); data `Contents/Resources/winvm/packages/core`.
- Launch: `open -n <app>` (`-n`: another winvm.app may already be running, e.g. the main checkout's build or /Applications). Direct: `<app>/Contents/MacOS/winvm-viewer` keeps stderr in your terminal (`lib.rs` `trace` does `eprintln!`). `open` has `--env VAR=val`, `--stderr FILE`, `-n` (verified in `open` usage). Whether the sidecar inherits `WINVM_HOME` from the app: UNVERIFIED.
- Unsigned/ad-hoc local build runs: UNVERIFIED (a build at the main checkout's path was observed running). The app only works if the pinned runtime verifies (`stage.ts`).
- The app lists every instance in the state dir and acts on them: use a dev instance, don't click Stop on others.
- Quit: Cmd-Q, or `pkill -f '<abs path>/winvm.app/Contents/MacOS/winvm-viewer'` (full path; never `pkill winvm`). VMs the app started keep running: `winvm status`, then `winvm stop -i <yours>`.
- UI-only loop: `cd apps/viewer && mise exec -- bun scripts/build-ui.ts --watch` (`dev:ui`) rebuilds `dist/` on change in `ui/`. It does not update an already built `.app` (dist is embedded at `tauri build`). `tauri dev`: `tauri.conf.json` has only `build.frontendDist`, no `devUrl`/`beforeDevCommand`; nothing in the repo uses it; UNVERIFIED, do not rely on it. Use section 7.

## 7. UI work without a VM
```sh
cd apps/viewer
mise exec -- bun scripts/build-ui.ts                           # needs dist/ (verified ~170 ms)
PLAYWRIGHT_DIR=/tmp/pw node scripts/render-checkpoints.mjs /tmp/winvm-render   # verified; prints PNG paths
```
Then `Read` a PNG (e.g. `/tmp/winvm-render/light-02-overview.png`, `dark-...`): output is 2560x1640, light and dark. Every script serves `dist/` locally, injects `tests/render/fake-tauri.js` (a fake Tauri API with fake machines + checkpoints), drives WebKit, and exits 2 with a message if `PLAYWRIGHT_DIR` is unset or `dist/index.html` is missing.

| Script (in `apps/viewer/scripts/`) | Shows |
|---|---|
| `render-checkpoints.mjs [outdir]` | the Checkpoints canvas: way in/out, bar, highlights, drag, zoom, search |
| `render-checkpoint-cards.mjs [outdir]` | the card's caption plate (opening view and zoomed in), a day's date following dragged cards, the New Checkpoint placeholder; CHECKS (exit 1) the plate is inside the card's button, the date follows, the placeholder is a date and time |
| `render-overview.mjs` | the suspended/off overview: notes, backdrop with and without a picture |
| `render-machines.mjs` | the machines menu and the editable machine name in the heading |
| `render-resources.mjs [outdir]` | the details panel's Resources (CPU's two lines, the disk bar's overlay, hover/focus legends, tiny/large/no overlay, no agent), light and dark; CHECKS names, legend, 3 px minimum |
| `render-sizes.mjs [outdir] [--quick] [--sizes 820x520,...] [--dsf 1,2] [--screens overview-stowed,menu]` | the overview (suspended and off), Checkpoints and the machines menu at 640x420, 820x520, 1000x800, 1440x900, 1920x1080, device scale 1, 1.5 and 2, light and dark (120 PNGs, ~2 min; `--quick` is 3 sizes at 1x/2x). Named `<scheme>-<screen>-<w>x<h>@<dsf>x.png`. It also CHECKS (exit 1): no sideways scroll, one shared column and left edge, no needless heading wrap, 24 px under the toolbar, the toolbar fits at and above the minimum window width. Run it after any layout CSS change and Read a few PNGs at the extremes |
| `render-help.mjs [--preview <dir>] [--no-build]` | the help popovers; WITHOUT `--preview` it rewrites the committed pictures in `ui/src/features/help/img/`: run it after any change to Terminal, Files or Checkpoints, and commit the result |

- Another screen: copy that script; keep `open(scheme)` (colorScheme `light`/`dark`, `addInitScript` fake-tauri, `__fakeScreen()`), then `window.__fakeMenu("<menu id>")` or click, then `page.screenshot`. Extend `tests/render/fake-tauri.js` for new `invoke` calls.
- If `/tmp/pw` is missing (from the script header, setup not re-run here): `npm i --prefix /tmp/pw playwright && npx --prefix /tmp/pw playwright install webkit`. Present on this Mac: `/tmp/pw` with playwright and `~/Library/Caches/ms-playwright/webkit-2370`.
- Run Node, not Bun, for the render script (`node scripts/render-*.mjs`).

## 8. Scenario tests on a real machine
```sh
WINVM_RUNTIME=~/.local/share/winvm/runtime/<ver> bun scripts/scenarios/run.ts -i dev-scen [--only pause,resize] [--hold 60] [--out DIR] [--real-xdg]
```
(`scripts/scenarios/run.ts`.) Scenarios: pause, sleep, stop-start, save-load, resize, terminal-files, share (skipped if the runtime has no virtiofsd). Needs a RUNNING-capable scratch machine on a built image; refuses `default`. It pauses, sleeps, locks, stops, stows, saves, loads, resizes the machine and mounts/unmounts its Finder drives, with the app's own polling running. XDG vars go to a temp dir unless `--real-xdg`, so also pass `WINVM_RUNTIME` (cache is under XDG_DATA_HOME). Evidence + `report.json` land in `/tmp/winvm-scenarios-<time>`; exit 1 on any FAIL. Total duration: UNVERIFIED (`--hold` defaults to 60 s per hold). Run by a person-approved scratch machine only. Runtime acceptance (`scripts/accept-runtime.sh`) is release work.

## 9. Worktrees and parallel agents
- A new worktree may start from main, not your branch: `git fetch`/fast-forward to the branch you need before editing.
- Per worktree: `pnpm install`, own `apps/viewer/dist`, own `src-tauri/target`. Never run two builds in one checkout (Cargo target lock; `build-app.ts` also deletes the `.app` and rewrites `dist/`). Check `ps aux | grep -E 'cargo|tauri'` first.
- Build outputs are gitignored (`dist/`, `src-tauri/target/`, `src-tauri/binaries/`).
- VM state is global per user: agents share `~/.local/state/winvm`. Use distinctly named instances (`dev-<agent>-<topic>`), never act on someone else's running instance, check `winvm status` before `stop`.
- Don't run `git stash` in a worktree (shared stash stack).

## 10. Troubleshooting
| Symptom | Cause / fix (source) |
|---|---|
| `winvm's runtime (QEMU, swtpm, zstd) is not installed - run winvm setup` | `RuntimeMissing` (`runtime.ts`). Run `winvm setup`; or `XDG_DATA_HOME` moved the cache: set `WINVM_RUNTIME` |
| `no base image "win11-arm64"` | `winvm build --iso ...` or `adopt` (`instance.ts`). `winvm ls` shows images |
| A save will not load after a QEMU/runtime/firmware/display/hardware change | `winvm saves -i x` marks `compatible`; `load` names what changed. Rebuild saves (docs/saves.md). New QEMU = all saves refuse (docs/release-runbook.md) |
| `VNC :N is in use on this host; instance moves to :M` | Informational, auto-fixed (`vnc.ts`). Ports: VNC 5900+N, websocket 5700+N, loopback only |
| Guest up but wrong / wedged | `winvm diagnose -i x`, then `rewind`, else `kill` + `reset` (docs/windows-vm-qemu.md) |
| `build` says one is already running | `winvm kill -i build-<image>`, rebuild |
| `pnpm install` refuses the lockfile (shard hosts) | `bun apply-pnpm-tarball-policy.mjs --check`; fix per `pnpm-workspace.yaml` comment (`pnpm install --lockfile-only`) |
| `rustc`: `No version is set for shim` | Rust only exists under `apps/viewer`; use `mise -C apps/viewer exec -- ...` or cd there (verified) |
| Render: `set PLAYWRIGHT_DIR` / `no dist/index.html` | Section 7: install Playwright in `/tmp/pw`, run `build-ui.ts` |
| `sign_nested does not match the app's Mach-O files` | After a runtime pin change: `bun apps/viewer/scripts/sign-list.ts --write <app>`, commit `.macos-builder/config` (release-runbook) |
| `WINVM_CLI is not set: start winvm through apps/cli` | Run via `winvm`/`pnpm winvm`, not a core module directly (`paths.ts`) |
| Guest tools ISO does not match its pin | Update `TOOLS_SHA256` in `packages/core/src/host.ts` (docs/setup.md) |
| Typecheck passes but a test seems stale | turbo cache: add `--force` |
| Edits to `packages/core/src/qemu.ts` or `assets/` | Read docs/windows-vm-qemu.md first (README) |

More: `reference.md` (env vars, unverified list).
