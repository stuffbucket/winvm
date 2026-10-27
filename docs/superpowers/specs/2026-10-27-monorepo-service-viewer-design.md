# winvm as a Turborepo monorepo, with a control service and a native viewer

Date: 2026-10-27. Status: design, for review before planning.

## Why

winvm is used four ways, and one more that matters most:

1. **Watching a boot** to see where it hangs.
2. **Watching end-to-end tests** run (`winvm run`, the cage check).
3. **Driving tests with computer use** (`winvm cua`).
4. **A standalone VM for manual testing**, using snapshots to skip setup.
5. **Headless, in CI/CD**, where none of the above has a window.

Today's browser viewer (`winvm web`, `web/index.html` + `app.js` + `app.css`)
shows everything at once at one weight: a one-off "time machine not excluded"
note sits beside the guest's state, actions are a wall of equal buttons, and
nothing comes from a design system. The cage check opened it in a Microsoft
Edge app window with a throwaway profile so it could close it afterwards,
which works but is heavy.

The same work exposed a structural problem. QEMU's monitor (QMP) and the
guest agent channel (qemu-ga) each accept **one client at a time**, and every
winvm process (each CLI call, each status poll, the web page) connects to them
independently. qemu-ga calls that time out leave state behind in the guest
(winvm#5 fixed one such case: a leaked file handle that made every retried
agent install fail). Several clients contending for single-client channels is
how that happens.

So: reorganise winvm now, while little depends on it, into a core that owns
the VM channels, a CLI and a native viewer that are both clients of it, and a
design system for the viewer.

## Goals

- **Headless first.** Everything works with no window. Nothing in the CLI, the
  core or a CI job needs Rust, Tauri, a browser or a display to build, install
  or run.
- **One owner per instance for QMP and qemu-ga.** No two winvm processes ever
  talk to an instance's single-client channels at once.
- **An event stream** per instance: boot phases, test steps, computer-use
  actions, snapshots, state changes. The viewer draws its timeline from it,
  and a headless run writes it to its log, so CI gets the same "where did it
  stop" evidence a watched run shows.
- **A native viewer** (Tauri) whose window winvm and the cage check can open
  and close cleanly.
- **A viewer UI that discloses progressively**, built from Base UI primitives
  wrapped in design-system components with design tokens.
- **A proper repository layout**: pnpm workspaces, Turborepo, versions pinned
  through mise.

## Non-goals

- Replacing macOS Screen Sharing. Plain VNC stays, and has better clipboard
  and file integration; the viewer complements it.
- Reuse or alignment of the design system with monimal. A copy in its own
  package is enough for now.
- A viewer for Windows or Linux hosts. winvm is macOS on Apple Silicon.
- Multi-user or remote access beyond the single-user local token model winvm
  already has.
- Playwright for driving guests: computer use stays on winvm's own QMP,
  UI Automation and DevTools routes. (Playwright *is* used to check the
  viewer's own layout; see Testing.)

## Anti-goals (failure even if it works)

- The viewer containing logic. Every button is an API call a script could
  make; every panel shows data a script could read.
- CI needing anything the viewer needs.
- A headless run producing less evidence than a watched one.
- Anything persistent drawn over the guest's screen.
- Compatibility shims for the old layout. winvm is not used heavily yet;
  consumers (the cage check, docs) are updated in the same change instead.

## Constraints

- Host: macOS 26+, Apple Silicon. Runtime: Bun. Toolchain: mise pins Bun and
  pnpm (already the case); pnpm is the package manager; Turborepo runs tasks.
- **Disk use stays small** (user's requirement). pnpm's content-addressed
  store, not per-project copies; Playwright installs WebKit only; the Rust
  toolchain and Cargo's `target/` exist only where the viewer is built, and
  `target/` is cleaned rather than left to grow; build outputs, screenshots
  and test artefacts are bounded or temporary. Nothing here copies a base
  image (APFS clones only).
- **References:** maximal (`~/github/stuffbucket/maximal`) for Tauri, the Bun
  sidecar, UI and design patterns; monimal (`~/github/stuffbucket/monimal`)
  for the Turborepo/pnpm/mise layout only, since its desktop app is Electron.
  The design system comes from monimal (below). Where either repo has already
  settled a pattern, follow it unless this design says otherwise.
- The lockfile is regenerated against the public npm registry. Today's
  `pnpm-lock.yaml` resolves to a private feed some machines cannot reach.
- File moves keep history (`git mv`), done as one change at a quiet moment:
  winvm `main` is under active development (pool, computer use).
- QMP and qemu-ga are single-client. A qemu-ga call abandoned on the host can
  still run in the guest (see `qga.ts` comments and winvm#5).
- The guest screen is 4:3 today (800x600 firmware framebuffer; larger with
  `winvm display`). Viewer windows are wider than tall in every scenario.
- winvm reads files next to its own source at runtime (vendored firmware,
  `assets/`, and `guestagent.ts`, which it copies into the guest). A compiled
  sidecar binary must carry them.

## Decided

By the user:

- **A Turborepo monorepo** (pnpm workspaces, Turborepo tasks) with two apps and a core package: the existing winvm logic
  becomes a package; the CLI is one app; the viewer is the other. The core is
  the viewer's **sidecar** when the viewer is used.
- **Tauri** for the viewer window, not a browser with a profile.
- **mise and pnpm**, with Turborepo.
- **Design system:** copy `packages/maximal-design-system` from
  `~/github/stuffbucket/monimal` into its own package here, unchanged, and
  wire it up around it.
- **UI built properly:** React, a conventional folder structure, Base UI
  primitives, style-wrapped components, design tokens, progressive disclosure.
- **A clear bar across the top**, modelled on Screen Sharing's control
  cluster: grouped icon controls in the title bar. It borrows the pattern and
  feel, not the pixels.
- **Simple snapshot management** in that bar. A snapshot is a save of the
  whole VM state (RAM and disk), so you can rewind to an earlier point, or
  jump forward to a later one, for example after more software was installed.
  These are winvm's file saves (`save`/`load`). Restoring an earlier one
  keeps the later ones, so jumping forward again always works. They appear in
  the order taken, with names; the toolbar takes one and restores from a
  list; the panel adds rename (new) and delete. Autosaves, stow saves and
  golden saves appear under "show all"; golden and baseline saves can't be
  deleted from the viewer, since CI depends on them. On images that can't
  take saves (no virtio boot) the controls are disabled with that reason.
- **Playwright may be used to check the viewer's layout** (computed styles
  and screenshots in WebKit, the engine Tauri uses on macOS), against a mock
  service; test DOMs compute no layout, which is how maximal shipped layout
  regressions past green tests.
- **Explicit layers**, so it is always clear what floats and what pushes the
  screen.
- **Keep VNC / Screen Sharing** available alongside the viewer.
- **No shims**; organise properly now.

My calls (proposals the user has seen and not objected to; the builder may
revisit with reason):

- **A control service per running instance** (the user left how it works to
  this design) that alone holds the instance's QMP and qemu-ga connections and
  offers an HTTP API (actions, status, event stream) on a Unix socket,
  `control.sock` in the instance directory (mode 0600). File permissions are
  its access control, as in bladerunner's `internal/control`, so it has no
  port and no token.
  `winvm start` launches it detached beside QEMU, and it stops when QEMU
  does. The idle watcher (`watch.ts`) becomes part of it, so there is still
  one helper process per instance. Commands keep their logic in core and pass
  their QMP and qemu-ga calls through the service, one at a time; status is
  answered from the service's last-known state while a long save holds QMP.
  Commands that run with no instance running (`build`, `ls`, `destroy`) don't
  need it.
- **Event stream**: newline-delimited JSON over HTTP (server-sent events or
  streamed JSON lines, builder's choice), also appended to
  `<instance>/events.jsonl` for the life of the instance and copied into any
  run's log directory by its runner. Indicative kinds: `state`,
  `boot.phase` (firmware, boot loader, Windows starting, logon, agent up),
  `job.step`, `cua.action`, `snapshot`, `warning`.
- **The service also serves the built viewer bundle**, so the same React UI
  opens in the Tauri window locally or in any browser pointed at a CI
  machine's service through a tunnel.
- **Layers**, back to front: **0 Screen** (the guest, scaled to fit what is
  left; never covered by docked layers); **1 Docked** (the toolbar always;
  the side panel when open; both take space and push the screen; the panel
  uses the spare width a wide window has beside a 4:3 screen first, and
  squeezes the screen only when the window is too narrow); **2 Floating**
  (menus, confirmations, toasts; short-lived, never holding state you need to
  read later).
- **Toolbar groups**, left to right: instance picker and its state in words
  ("Booting · Windows starting", "Running", "Paused"); power (start, pause or
  resume, reboot, stop); snapshots (take one, restore from a menu); view (fit
  or 1:1); open in Screen Sharing (for clipboard and file work); show or hide
  the panel.
- **Panel sections**, collapsed except the one that matters now: Progress
  (boot phases, or the running job's steps), Snapshots (list, rename,
  delete), Agent and computer use, Details (hardware, disk, paths, warnings
  such as Time Machine).
- **The design-system package is copied unchanged** (user's decision): its
  files come over from `monimal/packages/maximal-design-system` as they are,
  with the monimal commit recorded, so later monimal changes can be synced by
  copying again. Wiring that winvm needs lives outside the package: workspace
  and Turborepo configuration, and whatever stands in for the monimal-only
  workspace packages its scripts and dev dependencies name
  (`@maximal/eslint-config`, `@maximal/maximal-storybook`,
  `@maximal/maximal-design-system-tools`), or task filters so those scripts
  don't run here. Edits inside the package are a last resort, and each one is
  listed in a note next to it.

## Shape

```
winvm/
  mise.toml  pnpm-workspace.yaml  turbo.json  package.json
  packages/
    core/            today's winvm logic (qemu, qga, agent, saves, golden,
                     cua, jobs runner, status) + the control service
    design-system/   copied unchanged from monimal (see above)
  apps/
    cli/             the `winvm` command; thin over core
    viewer/          React UI (src/) + Tauri shell (src-tauri/); starts the
                     core service as its sidecar when there isn't one
  docs/
```

- `packages/core` exposes a library API (what `agent.ts`, `qga.ts`, `saves.ts`
  etc. export today) and the service.
- `apps/cli` keeps today's command names and flags, except how a guest is
  seen (next section). `winvm web` (the old browser page) goes.
- `apps/viewer` builds only on demand. Turborepo tasks are arranged so
  `pnpm turbo run test --filter=!viewer` (or an equivalent CI task) never
  touches Rust or Tauri.
- The compiled sidecar (`bun build --compile`) embeds firmware, `assets/` and
  `guestagent.ts`.

## Getting started, and seeing a guest

Bringing everything up is one short, documented sequence (README and
`winvm --help` both show it), not something to work out:

```sh
mise install            # Bun 1.4.3 and pnpm, pinned in mise.toml
pnpm install
pnpm build              # core, CLI and the viewer UI; no Rust
winvm start             # boot the default instance, headless
winvm open              # see it: the viewer window
pnpm viewer:build       # once, to build the native app (needs Rust; mise pins it)
```

`winvm open` is the one verb for seeing a guest:

- `winvm open [-i name]` opens the viewer window for the instance, or focuses
  it if open. If the native app isn't built yet, it opens the same UI in the
  default browser instead and prints the one command that builds the app; it
  never fails just because the app is missing.
- `winvm open --vnc` opens macOS Screen Sharing, as `open` does today.
- `winvm open --web` opens the browser view on purpose (or prints its URL
  with `--print`, for a tunnel).
- `winvm open --close` closes a viewer window the CLI opened.
- `winvm start --open` boots and opens in one step.
- Opening the app from Finder or the Dock shows the home's instances, with
  their states, and opens any of them. **The viewer can start a stopped
  instance** (toolbar Start, or from that list): it does exactly what
  `winvm start` does, booting QEMU and the instance's detached service, so
  the VM keeps running when the window closes. Building a base image
  (`winvm build`, ~20 minutes from an ISO) stays a CLI job.

Several instances run at once, as they do today (`winvm test --pool N` runs
jobs side by side): each instance has its own QEMU, sockets, TPM state, VNC
display and, with this design, its own service on its own socket. The viewer is
one app (single-instance) with a window per instance. Instances in other homes
(the cage check's) work the same way, and VNC displays no longer clash across
homes (winvm#2). Several CLI processes may act on one instance at once; its
service puts their QMP and qemu-ga calls in order.

## How the cage check changes afterwards

`CAGE_SHOW=1` runs `winvm open` and closes the window at exit (no Edge, no
profile). `CAGE_SHOW=screen` runs `winvm open --vnc`. The check gains the run's
`events.jsonl` in its log directory.

## Testing expectations

- Today's 198 tests move with the code and keep passing.
- The service gets contract tests that need no VM (the agent tests already
  run the real agent on the host; QMP and qemu-ga have fake-socket tests).
- A test proving two clients can no longer reach an instance's qemu-ga at
  once.
- Viewer components get component tests; the design system keeps its own.
- The viewer's layout is checked in a real browser: Playwright with WebKit
  only, against a mock service serving the built `viewer-ui` with validated
  fixtures (maximal's `scripts/ui-harness.ts` and
  `.claude/skills/ui-layout-verification/` are the model): computed styles
  for the layers (screen never covered by docked layers, panel in the spare
  width) plus screenshots, at a wide and a narrow window size.
- A live check on a real guest before calling it done: boot, watch the boot
  phases arrive as events, take and restore a snapshot from the toolbar,
  open in Screen Sharing, close the window from the CLI.

## Lessons carried over from maximal's Tauri app

maximal shipped a Tauri app with a compiled Bun sidecar. What it learned, and
what that changes here (sources are maximal paths or commits):

- **A VM outlives its window.** maximal kills its sidecar with the app
  (SIGTERM, then SIGKILL; a parent-PID watchdog in the sidecar), because
  Tauri's `CommandChild::kill()` is SIGKILL only and dropping it kills
  nothing (`shell/src-tauri/src/lib.rs`, Tauri #3564). winvm inverts this:
  per-instance services are started **detached** (own session) by core, with
  no parent-PID watchdog; quitting the viewer never stops a service or a VM.
  Only the viewer's own folder-level sidecar dies with the app, by exact PID
  (a delayed kill once took out a restarted sidecar, `lib.rs:1111`).
- **The UI is bundled in the app, not loaded from the service.** Pages Tauri
  loads from `http://127.0.0.1:port` count as remote, so IPC and window
  dragging need a remote capability naming the URL
  (`shell/src-tauri/capabilities/loopback.json`, 5868794b), and per-instance
  ports make that awkward. So `apps/viewer` bundles `viewer-ui`. A webview
  cannot open a Unix socket, so the viewer reaches each instance's
  `control.sock` through its sidecar, the one loopback HTTP server (CORS
  allowing the app's origin). For browsers, `winvm web` serves the same bundle
  and forwards to the control sockets the same way. `viewer-ui` never touches `window.__TAURI__`
  (maximal ADR-0018); window chrome is the shell's job.
- **Bun's `node:http` on 1.3.x does not notice a client dropping a streaming
  response** (no `close`, no write error; seen on 1.3.14), so long-lived
  streams leak (`docs/bun-version-policy.md`, 202857bc). The event stream
  uses `Bun.serve` with `request.signal`, plus heartbeats and an idle
  timeout, and a test that a killed subscriber is cleaned up. **winvm moves to
  Bun 1.4.3** (user's decision), the version maximal's broker already runs
  (`packages/mcp-broker/mise.toml`), where `node:http` was rewritten; never a
  floating `latest` (09b478b1). `.bun-version` is the one pin; mise and CI both read it.
  The move is its own step, with the full test suite and a live guest run
  before anything else changes, since Bun 1.3.14's `fetch` and `Bun.serve`
  behaviour is what winvm's agent client was measured against (winvm#3).
- **An app opened from Finder or `open` gets launchd's minimal PATH**
  (`docs/architecture.md:166`). The sidecar resolves `qemu-system-aarch64`,
  `qemu-img`, `swtpm` and `zstd` to absolute paths and receives `WINVM_HOME`
  explicitly.
- **Compiled binaries:** maximal's `scripts/build-sidecar.ts` (target triple
  from `rustc -vV` with a `process.arch` fallback, so no Rust needed; version
  and SHA stamped with `--define`; stale `.bun-build` temp files removed) is
  the model. Files embedded with `import … with { type: "file" }` live at
  `$bunfs` paths only Bun can read, so firmware handed to QEMU is extracted to
  a real path keyed by content hash (winvm already expands firmware into
  `WINVM_HOME`); `import.meta.dir`-relative reads must go. Core builds and
  tests with `viewer-ui` unbuilt (maximal's self-healing empty embed stub,
  baff99e2).
- **Tokens and requests** (the sidecar and `winvm web`, the only loopback
  servers; instance services have none): the token is generated from the OS
  random source and passed in the environment, never argv or disk
  (`lib.rs:546-575`);
  EventSource and WebSocket carry it as `?key=` on those paths only (maximal
  ADR-0019); mutating routes check an Origin allowlist (a missing Origin, as
  from the CLI, passes) because loopback alone does not stop a malicious page
  in the user's browser (ADR-0021). The UI uses discovered ports, never
  literals.
- **One app, many windows:** `tauri-plugin-single-instance` hands a second
  launch's arguments to the running app, which is how `winvm open -i x` and
  `--close` reach it.
- **Stale builds ship:** a persistent `target/` once shipped a build six
  versions old (2b36018e). The viewer and service exchange version and build
  SHA and say so on mismatch.
- **WKWebView caches aggressively** (served stale JS after `no-store`,
  8dacdc0f): hashed asset names and a `no-store` index page.
- **Windows open hidden and show on first paint** (6fdb0fcb). The title bar
  is `TitleBarStyle::Overlay` with a hidden title, `data-tauri-drag-region`
  on the toolbar, and left padding for the traffic lights (bf58792e); no
  heading in the content repeating the window title
  (`docs/design/failure-modes.md`).
- **A dead service can't serve its own error page:** the app ships a small
  local "service unreachable" screen with Retry (ADR-0018).
- **Settings** (viewer preferences, kept in `WINVM_HOME`, since webview
  storage is per origin): atomic writes (`O_EXCL` 0600, fsync, rename), zod
  validation that keeps unknown keys, a `schemaVersion` with one gated
  migration (d3401d4d, 2862b3c2).
- **Design rules** (`docs/design/`): tokens only, no raw px or hex; fill
  colours never used as text; `:focus-visible`; reduced motion respected;
  fonts self-hosted. These apply to `viewer-ui`; the copied design system is
  left as it is.
- **Tests:** no `mock.module` (it leaks across files even when restored);
  injectable dependencies or the real module instead
  (`docs/architecture.md:64-95`). The test preload points `WINVM_HOME`, HOME
  and temp at a sandbox, so no test can touch a real instance. Tests that only
  grep source text don't count.
- **CI:** pull requests run on Ubuntu or macOS without Rust; Tauri builds only
  in release workflows. CI does compile the sidecar (`bun build --compile`) to
  catch compile breaks early. A check rejects private registry hosts in the
  lockfile (`scripts/strip-lockfile-hosts.ts`), and whether `bun build
  --compile` needs pnpm's `node-linker=hoisted` (as maximal's did, ecc2ba9e)
  is checked early.
- **Release signing:** Bun binaries under the hardened runtime need
  `allow-jit`, `allow-unsigned-executable-memory` and
  `disable-library-validation` (the builder's `bun-runtime` entitlements);
  the sidecar is signed first, never `--deep`. The builder now notarizes and
  staples both the app and the `.dmg` (macos-builder#25; maximal's older
  "dmg only", 6e861b97, is superseded). See *Build, CI and release*.

## Build, CI and release

The viewer ships as a **signed, notarized `.dmg`** (user's decision), the way
maximal ships today (its v0.4.46 and v0.4.47 releases went through this
path). The workspace build follows monimal; the release follows maximal.

**Workspace build (from monimal).** Root `package.json` scripts are thin
`turbo run` calls (`build`, `typecheck`, `lint`, `test`, `check:affected`
with `--affected`); each package declares plain `build`, `typecheck`,
`lint` and `test` scripts. `turbo.json` follows monimal's: `build` depends on
`^build` and outputs `dist/**`; `globalDependencies` include `mise.toml`,
`mise.lock`, `.bun-version` and `pnpm-workspace.yaml`; inputs exclude
`.claude`, `.github` and `docs`; the sidecar build is `cache: false` with its
env listed; packaged app output is never cached (it once made a 3.68 GB
cache in monimal, #86). **Pins:** `.bun-version` (1.4.3) is the one Bun pin,
read by mise (`idiomatic_version_file_enable_tools`) and by CI
(`setup-bun` with `bun-version-file`); pnpm is pinned in `packageManager` and
`mise.toml`; `mise.lock` (`lockfile = true`) pins tool artifacts by checksum.
monimal's `verify-workspace.mjs` is the model for a "the installed tree
matches the pins" check, rewritten for winvm (it imports monimal-only
helpers).

**Pull-request CI (`.github/workflows/ci.yml`, from monimal's).** One Ubuntu
job, `permissions: contents: read`, `shell: bash -eo pipefail`: the
Conventional Commit subject check (maximal's `scripts/check-commit-msg.ts`),
install, lint, typecheck, test and build, excluding `apps/viewer`; compile
the sidecar (`bun build --compile`) to catch compile breaks; actionlint and
shellcheck on workflow and release scripts, with the release scripts
self-tested on every PR (monimal burned two release candidates on untested
release shell). pnpm store and `.turbo/cache` cached as monimal does, with a
separate key per line of runs. The macOS-only tests that need QEMU stay out
of hosted CI.

**Release (from maximal's).**

- `release-please.yml` with `release-please-config.json` and
  `.release-please-manifest.json`: on push to `main` it maintains the release
  PR; when that merges it pushes the tag and starts `release.yml` itself
  (tags pushed with `GITHUB_TOKEN` trigger nothing; grant `actions: write`),
  and moves the `autorelease: pending` label to `tagged` (a stuck label
  blocked every later release, maximal #152). `Release-As: X.Y.Z` forces a
  version.
- `release.yml` (tag push or dispatch): checks and builds, a **draft**
  release, then the `.dmg` job, then one draft-to-published flip, so a
  release is never published without its `.dmg` (maximal shipped three
  without one before this).
- **The `.dmg` is built and signed by `stuffbucket/macos-builder`**, the
  private self-hosted builder maximal uses: the release job starts its
  `build.yml` with `MACOS_BUILDER_PAT`, waits for the draft to gain the
  `.dmg`, renames it `winvm-<tag>-darwin-arm64.dmg` and adds a `.sha256`.
  winvm supplies only `.macos-builder/config` (`bundle_id=co.stuffbucket.winvm`,
  `entitlements=bun-runtime`, `artifact=dmg`, `sign_nested` for the sidecar)
  and `.macos-builder/build.sh`, which builds the unsigned app: stamps the
  version into `tauri.conf.json`, builds the sidecar, deletes the old bundle,
  runs `tauri build --bundles app` and asserts the built
  `CFBundleShortVersionString`. The builder signs the sidecar and the app
  (never `--deep`), notarizes and staples the app, then builds, notarizes and
  staples the `.dmg`. No Apple credentials live in winvm.
- **Bun on the builder is not pinned** (it uses the runner's global Bun, and
  monimal's `build.sh` checks it matches 1.3.14). winvm's `build.sh` installs
  Bun 1.4.3 through mise from `.bun-version` rather than relying on it.
- `macos-build.yml` (manual) rebuilds the `.dmg` for an existing release.
- No auto-updater for now (maximal doesn't use Tauri's either). A policy
  mismatch on the builder fails only after a 20-40 minute build, so the
  config is checked against the policy before the first release.

**Setup only the user can do** (no winvm secrets exist today):

1. Add `stuffbucket/winvm` to the builder's `ALLOWED_CLIENTS`.
2. Approve a `build-config` issue in macos-builder that creates
   `clients/stuffbucket/winvm.policy` (`bundle_id_allowed=co.stuffbucket.winvm`,
   `entitlements_allowed=bun-runtime`, `artifact_allowed=dmg`).
3. Install the app-repoman GitHub App on winvm (Contents read and write).
4. Add the `MACOS_BUILDER_PAT` secret to winvm, and note its expiry (an
   expired token leaves a draft release with no `.dmg`).
5. Rulesets that require the CI check on `main`. Immutable releases can wait
   until the first release succeeds.

## Settled after review (my calls)

- **The UI is its own JS-only package**, `packages/viewer-ui` (React, design
  system, noVNC), separate from the Tauri shell in `apps/viewer`. The service
  serves its built bundle; CI may build it, since no Rust or Tauri is
  involved. Only `apps/viewer` is excluded from CI.
- **The screen stays interactive** (noVNC, as today). While `cua` or a job is
  driving the guest, the toolbar says so; input is not blocked. For a remote
  browser `winvm web` proxies the VNC websocket, so the tunnel needs one
  port. An open viewer still counts as activity for the idle watcher, as a
  connected VNC client does today.
- **One window per instance**, through `winvm open` (see *Getting started*).
  Instances in another `WINVM_HOME` (the cage check's) get their own
  windows. `winvm open` never starts a Rust build itself; without a built app
  it falls back to the browser view and prints how to build the app.
- **The CLI runs from source** through the workspace's `winvm` bin
  (`bun apps/cli/...`). The service reports its version and the build it came
  from; a CLI that finds a service of another version says so and restarts it
  when no command is in flight.
- **The cage check moves in its own commit**, in the cage repo, pinned to the
  winvm commit that lands this.

## Left to the builder

- Service transport details (SSE vs streamed JSON lines). Settled in plan 2a:
  HTTP on `control.sock` with no token, and the CLI finds a running service
  through `service.json`, which the service creates exclusively.
- How boot phases are detected (serial log, QMP state, qemu-ga, agent).
- How `winvm run` jobs and `cua` publish steps and actions to the stream.
- Folder structure inside each package, following conventions for React,
  Tauri and Bun libraries.
- Order of work, provided the CLI and core are usable headless at every step.
