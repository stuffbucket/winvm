# Development

The repository's executable front door is **mise**. **pnpm** owns workspace dependencies and package scripts; **Bun** runs the source CLI, tests, and bundling scripts; **Turborepo** coordinates workspace checks. Skills supply judgment and verification, not another command dispatcher:

- [winvm-mise](../.claude/skills/winvm-mise/SKILL.md): discover tasks, select the development operation, apply safety rules, and verify the result.
- [winvm-release](../.claude/skills/winvm-release/SKILL.md): release-specific operations and approval boundaries.

Shared recipes and environment details are consolidated here; prefer `winvm-mise` for development guidance. Commands are grounded in repository configuration and source; historical passing runs do not establish that the current checkout passes. Unsupported or unverified acceptance cases are identified below.

## Core command contract

Run these from the repository root. No shell activation is required; mise supplies pinned tools. Inspect tasks with `mise tasks ls` and `mise tasks info <name>`.

| Command | Meaning and side effects |
|---|---|
| `mise run setup` | Install workspace dependencies through pnpm. Mise supplies missing pinned tools first. Tool installation can invoke the existing host/runtime hook; no Windows image or guest is created. |
| `mise run dev` | Launch the **existing local native app**. Does not build, refresh embedded UI, or install it. Run `build` first when current source must be included. |
| `mise run build` | Build and stage the complete local native `.app`. Replaces the previous local bundle; does not launch, install, or publish. |
| `mise run test` | Run workspace tests; no Windows VM required. |
| `mise run check` | Run the existing CI quality gate: workspace typechecks/tests and root script tests. No automatic fixes, real-VM tests, or release operations. |
| `mise run doctor` | Run the source CLI's read-only host diagnostic. Mise may first install missing tools. |

Specialized tasks: `typecheck`, `check:force`, `ui:build`, `ui:watch`, and `tokens:generate`. `ui:watch` only rebuilds files; it is deliberately not named `dev`. `tokens:generate` writes generated CSS and is not part of check-only operation.

The existing `pnpm run build` delegates to workspace `build` scripts through Turbo. It is **not** the native app-packaging command. The repo-root `mise run build` intentionally selects the complete native viewer recipe.

## Toolchain and setup

- Bun's single version pin is `.bun-version` (currently 1.4.3); mise and CI read it.
- pnpm is pinned by `mise.toml` and `package.json#packageManager` (currently 12.3.4). Install workspace dependencies with pnpm, not `bun install`.
- Rust is scoped to `apps/viewer/mise.toml` (currently 1.99.0). The native build task uses `mise -C apps/viewer exec` rather than assuming that a changed working directory loads child tool configuration.
- `mise.lock` locks runtime-tool artifacts. QEMU/swtpm/zstd/virtiofsd come from the separately pinned `packages/core/runtime.json`, not a Homebrew QEMU.
- Each checkout/worktree needs its own `pnpm install` and build outputs. CI uses `pnpm install --frozen-lockfile`.

Equivalent explicit setup:

```sh
mise install
mise exec -- pnpm install
mise exec -- pnpm run winvm doctor
```

**Installation side effect:** root mise's existing `postinstall` hook runs `bun scripts/check-host.ts || true`. That script can download and verify the pinned runtime through `ensureRuntime`; its ignored exit status is not proof the host is ready. Run `doctor` to inspect readiness. The hook is not Windows provisioning.

Guest prerequisites are separate. `winvm setup` downloads the runtime, guest tools ISO, and PowerShell MSI; `--no-media` skips media. Only the Windows ISO is manual: `--iso <path>`, `WINVM_ISO`, or an ARM64 ISO under `~/vm` / `~/isos` (not an implicit Downloads scan). See [Setting up](setup.md). Do not run setup/provisioning just to perform source checks.

## Safety and checkout scope

- Pass `-i <authorized-name>` on every instance command. Never operate the person's `default` or `pi` instances. Do not create/start a scratch Windows instance without authorization.
- Preserve unrelated changes; never stash. Do not commit or push without a request.
- A worktree can start from `main` rather than the active feature branch: inspect its HEAD and status before editing. Do not blindly merge patches using a stale base.
- One build per checkout. Cargo targets, sidecars, UI `dist`, and the native bundle are shared outputs. Serialize builds and render jobs that write them.
- Read [Windows VM/QEMU design](windows-vm-qemu.md) before editing `qemu.ts` or provisioning assets. Hardware arguments participate in saved-state compatibility; do not change them underneath old saves.
- Stop only processes this operation started or an exact local build the user authorized quitting. Never use an unqualified `pkill winvm`.
- Never retry a denied action via another tool or agent.
- Native fixture-backed windows must be visibly labeled as tests in both title and UI **before showing**, explained, isolated, and closed after verification. Prefer headless fixture renders for layout. Screenshot pixels are raster; text, icons, and decorative SVG wallpaper remain DOM/vector content.

## Running the correct CLI checkout

| Context | Invocation |
|---|---|
| Repository root, independent of shell activation | `mise exec -- pnpm run winvm <command>` |
| Inside repo, mise active | `winvm <command>` (root mise adds `node_modules/.bin` to PATH) |
| Worktree | Install its dependencies, then use its `mise exec -- winvm` or `pnpm run winvm`; do not trust an inherited PATH pointing at another checkout |
| Outside checkout | `mise exec -C <repo> -- winvm <command>` |

Run the public CLI, not a core module directly. `WINVM_CLI` is set by the CLI; do not set it to bypass the entrypoint. `winvm help` lists commands. A wrong Bun version produces a pin warning.

## Quality gates (no Windows or Rust compilation)

```sh
mise run check
mise run check:force                         # bypass Turbo cache, still test root scripts
mise run test
mise run typecheck
mise exec -- pnpm --filter @winvm/viewer run test
mise exec -- pnpm --filter @winvm/core run test
```

For one file, enter its package and run `mise exec -- bun test <test-path>`. Viewer typechecking also checks CSS token generation and design-token usage. Regeneration is explicit: `mise run tokens:generate`.

Lockfile policy check: `mise exec -- bun apply-pnpm-tarball-policy.mjs --check`. The policy and its upstream provenance are recorded in `pnpm-workspace.yaml`; do not rewrite shard URLs by hand.

Always check exit status. Report the actual failing command and errors; focused success does not mean the full gate passed. Do not remove tests or regenerate tracked assets to conceal failures. Generated build caches are normal, but check-only operations should not edit tracked source.

## Native Mac app

Prerequisites: Apple Silicon macOS 15+, installed workspace dependencies, viewer-scoped Rust, and the pinned runtime. Inspect running Cargo/Tauri/viewer processes and the exact previous local bundle before building.

```sh
mise run build
mise run dev
```

The build delegates to the existing viewer package script:

```sh
mise -C apps/viewer exec -- pnpm run app
```

`apps/viewer/scripts/build-app.ts` runs UI bundling, CLI sidecar compilation, deletes the old local `.app`, runs Tauri bundling, stages the pinned runtime and core resources, checks the nested-signing list, and checks the bundle version and sidecar. Output:

```text
apps/viewer/src-tauri/target/release/bundle/macos/winvm.app
```

**Before replacement:** inspect the bundle and whether that exact copy is running. Confirm replacement/quit when not already authorized. Quit only that local copy. Never overwrite `/Applications/winvm.app` implicitly.

**No version argument locally.** `build-app.ts <version>` rewrites `tauri.conf.json` and belongs to the release flow. Do not bypass runtime, bundle-version, or signing-list failures.

The native launcher is `Contents/MacOS/winvm-viewer`; the CLI sidecar is `Contents/MacOS/winvm`. Core resources live under `Contents/Resources/winvm/packages/core`, and the staged runtime under `Contents/Resources/runtime`. The app can find its bundled runtime without the user's runtime cache.

`dev` uses `open -n` with the local bundle path so it does not select an installed copy. It does not rebuild or update the bundle's embedded UI. For stderr, the exact bundle's `Contents/MacOS/winvm-viewer` can be launched directly. Do not assume state-isolation environment variables reach a sidecar without verifying them.

After launching, interact with the actual UI and inspect a screenshot when verifying appearance. Do not start a VM simply to get a live screen. Report whether the artifact predates source changes. Close temporary review windows; the app quitting does not imply its VMs stopped.

A turnkey live native development-server workflow is not provided. Ad-hoc `tauri dev` server/config overrides are not the standard recipe here. Preexisting native-fullscreen acceptance, real devices/clipboard flows, and self-update behavior require their own explicit verification; successful fixture checks or a build do not establish them.

## UI work without a VM

```sh
mise run ui:build
mise run ui:watch                         # only watch/rebuild dist, no viewer launch
```

The render scripts require Node and Playwright WebKit. Use **Node, not Bun**, for their `.mjs` entrypoints; Bun still builds the UI. Playwright is currently external to the workspace and addressed by `PLAYWRIGHT_DIR`; this is not a portable dependency bootstrap yet.

Existing setup recipe from the render headers (install only when authorized and needed):

```sh
npm i --prefix /tmp/pw playwright
npx --prefix /tmp/pw playwright install webkit
```

From `apps/viewer`, with mise active or the needed tools available:

```sh
PLAYWRIGHT_DIR=/tmp/pw node scripts/render-checkpoints.mjs /tmp/winvm-render
```

Scripts serve local `dist`, inject `tests/render/fake-tauri.js`, drive WebKit, and write images. This is fixture coverage, not a live Windows guest or native-window acceptance. Read representative PNGs at light/dark and size extremes.

| Script under `apps/viewer/scripts/` | Coverage |
|---|---|
| `render-checkpoints.mjs [outdir]` | Canvas entry/exit, selection, dragging, zoom, search, input shielding |
| `render-snapshot-design.mjs [outdir]` | Card design, crop anchoring, wallpaper fallback, focus and settled sharpness |
| `render-screen-input.mjs [outdir]` | Input forwarding and held-screen fixture states |
| `render-checkpoint-cards.mjs [outdir]` | Caption structure, date placement, placeholder text |
| `render-overview.mjs` | Off/suspended overview and backdrop |
| `render-machines.mjs` | Machine menu and editable heading |
| `render-resources.mjs [outdir]` | CPU/disk layout and legends across data variants |
| `render-settings.mjs [outdir]` | Settings fixture states and policy controls |
| `render-sizes.mjs [outdir] [--quick]` | Responsive overview, Checkpoints, and menus; use `--sizes`, `--dsf`, `--screens` to narrow |
| `render-help.mjs [--out <dir>] [--preview <dir>] [--no-build]` | Help pictures and popovers; default output rewrites tracked JPEGs |

For check-only help rendering, supply a separate `--out` directory. For intentional image regeneration, inspect old targets first, regenerate, rebuild the UI, inspect results, and report tracked changes. `--preview` also rebuilds shared `dist`; serialize it with other jobs.

## Authorized real-guest operations

A Windows image is built once; instances use separate copy-on-write overlays backed by the read-only base. State is per-instance, but settings, runtime cache, and some host resources are shared. The following are examples only, not permission to execute:

```sh
winvm create -i dev-topic
winvm start -i dev-topic
winvm status -i dev-topic --json
winvm exec -i dev-topic -- cmd.exe /c ver
winvm put -i dev-topic ./f.txt 'C:\f.txt'
winvm get -i dev-topic 'C:\f.txt' ./out.txt
winvm screenshot -i dev-topic /tmp/s.png
winvm files open -i dev-topic c
winvm terminal -i dev-topic --connect --json
winvm agent -i dev-topic connect --json
winvm mcp -i dev-topic
winvm diagnose -i dev-topic
```

`stop`/`destroy` and save/restore operations are separate mutations requiring authorization. Never use the omitted-instance default. Do not use global `prune`, `rmi`, `web --stop`, or Time Machine operations as cleanup for one test.

An isolated `WINVM_HOME` has no base image. A symlink to a real image has not been established as a supported acceptance recipe; do not invent one. Setting `WINVM_HOME` alone does **not** isolate settings and notes: set `XDG_CONFIG_HOME` and `XDG_DATA_HOME` as needed. Moving `XDG_DATA_HOME` also moves the runtime cache; use an explicitly verified `WINVM_RUNTIME` path if needed.

Real-guest scenario entrypoint, only for an authorized scratch instance:

```sh
WINVM_RUNTIME=<verified-runtime-path> bun scripts/scenarios/run.ts -i dev-scen --only pause,resize --hold 60 --out <dir>
```

The harness exercises guest state, saves/restores, resize, terminal/files, and sharing where supported. It refuses `default`, isolates XDG paths by default (`--real-xdg` opts out), writes screenshots/report evidence, and exits nonzero for failures. It must not run under the normal `check` task. Runtime acceptance is release work.

## Paths and environment

| Path | Contents |
|---|---|
| `~/.local/state/winvm` / `WINVM_HOME` | Images, instance overlays/logs/sockets, saves, media, firmware |
| `~/.local/share/winvm` / `XDG_DATA_HOME` | Runtime cache and per-instance notes |
| `~/.config/winvm` / `XDG_CONFIG_HOME` | Shared `settings.json` |
| `~/winvm/<instance>` | Finder mounts for guest drives/home |

| Variable | Meaning |
|---|---|
| `WINVM_INSTANCE` | Default instance selection; still pass explicit `-i` |
| `WINVM_IMAGE` | Image selection |
| `WINVM_ISO` | Explicit Windows ISO |
| `WINVM_RUNTIME` | Explicit unpacked runtime directory |
| `WINVM_RUNTIME_CACHE` | Runtime cache override |
| `WINVM_PACKAGE_DIR` | Core assets/firmware/web location |
| `WINVM_QEMU_DATA` | UEFI firmware search path |
| `WINVM_WEB_PORT` | Browser-view port |
| `PLAYWRIGHT_DIR` | External directory with Playwright installed |
| `CHECKPOINT_PICTURES` | Real PNG inputs for render scripts supporting that mode |

Configuration overrides live in shared settings. CPU/RAM changes apply on the next cold boot, not to restored saved hardware. Sleep locks Windows and pauses QEMU; pause freezes without locking; stow saves and exits. See the VM design document before changing these behaviors.

## Troubleshooting pointers

- `No version is set for shim` for Rust: enter the viewer's mise scope; use the root `build` task.
- Missing runtime/base image: inspect `doctor` / `ls`; source checks need no guest. Provision only when requested.
- Save refuses after runtime/firmware/hardware changes: respect compatibility checks; do not bypass hashes.
- Render says `PLAYWRIGHT_DIR` or `dist/index.html` is missing: use the UI/Playwright recipe, not a real VM.
- `sign_nested` mismatch: inspect `winvm-release` and the signing policy; do not weaken the check.
- A focused check passes but full CI fails: run the actual full gate and report both; use `check:force` to remove Turbo cache uncertainty.
- Conventional Commit subjects are checked by `scripts/check-commit-msg.ts`; valid types include build, chore, ci, docs, feat, fix, perf, refactor, revert, style, and test. Do not commit unless asked.
