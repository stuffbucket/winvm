# winvm Turborepo foundation (plan 1 of 5) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** winvm runs on Bun 1.4.3 as a pnpm + Turborepo monorepo (`packages/core`, `apps/cli`) with pull-request CI, behaving exactly as it does today.

**Architecture:** Pin Bun 1.4.3 first and prove nothing regressed, in the flat layout. Then regenerate the lockfile against public npm. Then move every module with `git mv` into `packages/core` (library, assets, firmware, old web page, tests) and the entry point into `apps/cli`; replace the runtime path lookups that assumed one flat directory. Last, add CI on hosted runners.

**Tech Stack:** Bun 1.4.3, TypeScript 6.0.3, pnpm 12.3.4 workspaces, Turborepo 2.11, mise, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-10-27-monorepo-service-viewer-design.md`

## Plan sequence

The spec spans five subsystems; each plan leaves winvm working and is planned
once the one before it has landed (later plans depend on the paths this one
creates).

1. **Foundation** (this plan): Bun 1.4.3, Turborepo monorepo, CI.
2. **Control service and event stream**: per-instance service owning QMP and
   qemu-ga, the watcher folded in, `events.jsonl`, saves rename and the
   protected kinds, `winvm open` (`--vnc`, `--web`, `--close`), the old
   `web/` page retired.
3. **Viewer UI**: `packages/design-system` (copied unchanged from monimal),
   `packages/viewer-ui` (React, Base UI, layers, toolbar, panel), Playwright
   WebKit layout checks against a mock service.
4. **Native viewer**: `apps/viewer` (Tauri), compiled sidecar with embedded
   files, single-instance windows, `pnpm viewer:build`.
5. **Release**: release-please, `release.yml`, `.macos-builder/` config and
   `build.sh`, signed `.dmg`; then the cage check moves to `winvm open` (cage
   repo, its own commit). Needs the user's builder setup (spec, *Setup only
   the user can do*).

## Global Constraints

- Bun **1.4.3**, pinned only in `.bun-version`; mise and CI read that file. Never `latest`.
- pnpm **12.3.4** (`packageManager` and `mise.toml`, the versions winvm already uses); Turborepo `^2.11.4` (monimal's).
- Install resolves against the public npm registry; no private feed host may appear in `pnpm-lock.yaml`.
- File moves use `git mv` so history follows; no compatibility shims for the old layout.
- `jobs/` and `docs/` stay at the repository root.
- Disk use stays small: pnpm's shared store; no copies of base images; no new caches beyond pnpm's and Turborepo's.
- Behaviour does not change in this plan: same commands, flags, output and exit codes.
- The guest's own Bun (`winvm build --bun 1.3.14`, baked into images) is not the host pin and does not change.
- Commit subjects are Conventional Commits; no references to Claude and no emojis in commit messages.

## Review Focus

- **Running from another directory**: `winvm doctor` and `winvm ls` from `/tmp` must find `assets/`, `firmware/` and `web/` (Task 3 Step 8).
- **Processes winvm spawns detached** (idle watcher, `winvm web` server, job host steps) must find the CLI after the move, including when started from a non-repo directory (Task 3, `cliEntry` test and Step 8).
- **A fresh clone on a machine without the private feed** must install (Task 2 lockfile check).
- **Existing `WINVM_HOME` state** (instances, saves, expanded firmware made by the flat layout) keeps working (Task 3 Step 9, the cage check against `~/.local/state/cage-winvm`).
- **Bun 1.4.3's HTTP client and server** keep winvm#3's behaviour: a guest command longer than 300 s returns its output (Task 1 Step 5).

---

### Task 1: Pin Bun 1.4.3 and prove nothing regressed

**Files:**
- Create: `.bun-version`
- Modify: `mise.toml`, `package.json` (`@types/bun` only if `tsc` needs it)

**Interfaces:**
- Produces: `.bun-version` containing `1.4.3`, the single Bun pin later tasks and CI read.

- [ ] **Step 1: Pin**

`.bun-version` holds `1.4.3` and a newline. In `mise.toml`, remove `bun` from `[tools]` (keep `pnpm = "12.3.4"`) and add:

```toml
[settings]
idiomatic_version_file_enable_tools = ["bun"]
lockfile = true
```

Keep the existing comment explaining the versions, updated to say Bun comes from `.bun-version` and tool artifacts are checksum-pinned in `mise.lock`.

- [ ] **Step 2: Verify the pin is live, and lock the tools**

Run: `mise install && mise lock && bun --version`
Expected: `mise.lock` written (pnpm and bun entries with checksums); `1.4.3`

- [ ] **Step 3: Typecheck and test**

Run: `pnpm run check`
Expected: `tsc` clean; `198 pass, 0 fail`. A failure here is a Bun 1.4 behaviour change: fix it in the code it breaks, in this task, with a note in the commit body.

- [ ] **Step 4: Boot a guest end to end**

Run: `CAGE_WINVM=$PWD/winvm.ts ~/github/stuffbucket/cage/checks/windows-arm64-winvm/run.sh`
Expected: `0 failed` (the winvm line shows `(modified)`; that is expected on a branch).

- [ ] **Step 5: A guest command longer than 300 s still returns its output**

With an instance up in `~/.local/state/cage-winvm` and the agent installed (as in the check, `CAGE_KEEP=1`), run:
`WINVM_HOME=~/.local/state/cage-winvm bun winvm.ts exec -i cage-arm64 -- powershell.exe -NoProfile -Command 'Write-Output start; Start-Sleep 320; Write-Output end'`
Expected: prints `start` and `end`, exit 0, after ~322 s. Then `kill` and `destroy` the instance.

- [ ] **Step 6: Commit**

```bash
git add .bun-version mise.toml mise.lock package.json
git commit -m "build: run winvm on Bun 1.4.3, pinned in .bun-version"
```

---

### Task 2: Resolve dependencies against public npm, and keep it that way

**Files:**
- Modify: `pnpm-lock.yaml` (regenerated)
- Create: `scripts/check-lockfile-hosts.ts`
- Test: `scripts/check-lockfile-hosts.test.ts`

**Interfaces:**
- Produces: `bun scripts/check-lockfile-hosts.ts [lockfile]`, exit 0 when every `tarball:`/`resolution` URL in the lockfile is on `registry.npmjs.org` (or the lockfile records no tarball URLs), exit 1 listing each other host otherwise. `export function foreignHosts(lockText: string): string[]` (sorted, unique).

- [ ] **Step 1: Write the failing test**

```ts
import { expect, it } from "bun:test"
import { foreignHosts } from "./check-lockfile-hosts"

it("accepts integrity-only entries and the public registry", () => {
  expect(foreignHosts("  resolution: {integrity: sha512-abc}\n  tarball: https://registry.npmjs.org/a/-/a-1.0.0.tgz\n")).toEqual([])
})

it("names every other host once", () => {
  const lock =
    "  resolution: {tarball: https://ms-feed-25.pkgs.visualstudio.com/x/a-1.tgz}\n" +
    "  resolution: {tarball: https://ms-feed-25.pkgs.visualstudio.com/x/b-1.tgz}\n" +
    "  tarball: https://packagefeedproxy.microsoft.io/c-1.tgz\n"
  expect(foreignHosts(lock)).toEqual(["ms-feed-25.pkgs.visualstudio.com", "packagefeedproxy.microsoft.io"])
})
```

- [ ] **Step 2: Run it to see it fail**

Run: `bun test scripts/check-lockfile-hosts.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `foreignHosts` and the CLI wrapper** in `scripts/check-lockfile-hosts.ts` (scan for `https://` URLs on lines containing `tarball`; default path `pnpm-lock.yaml`).

- [ ] **Step 4: Run it to see it pass, and see it reject today's lockfile**

Run: `bun test scripts/check-lockfile-hosts.test.ts && bun scripts/check-lockfile-hosts.ts`
Expected: test PASS; the script exits 1 naming `ms-feed-25.pkgs.visualstudio.com` (today's lockfile).

- [ ] **Step 5: Regenerate the lockfile against public npm**

Run: `rm pnpm-lock.yaml && pnpm install --registry=https://registry.npmjs.org/ && bun scripts/check-lockfile-hosts.ts`
Expected: install succeeds with the same versions (`@anthropic-ai/sdk 0.134.0`, `@types/bun`, `typescript 6.0.3`); the check exits 0.

- [ ] **Step 6: Typecheck and test**

Run: `pnpm run check`
Expected: clean; `200 pass, 0 fail` (the flat layout's `bun test` also picks up `scripts/*.test.ts`).

- [ ] **Step 7: Commit**

```bash
git add pnpm-lock.yaml scripts/check-lockfile-hosts.ts scripts/check-lockfile-hosts.test.ts
git commit -m "build: resolve the lockfile against public npm and check it stays there"
```

---

### Task 3: Move to `packages/core` and `apps/cli` under Turborepo

**Files:**
- Move (`git mv`): every root `*.ts` except `winvm.ts` → `packages/core/src/`; `assets/`, `firmware/`, `web/` → `packages/core/`; `tests/` → `packages/core/tests/`; `winvm.ts` → `apps/cli/src/winvm.ts`
- Create: `pnpm-workspace.yaml`, `turbo.json`, `packages/core/package.json`, `packages/core/tsconfig.json`, `packages/core/bunfig.toml`, `apps/cli/package.json`, `apps/cli/tsconfig.json`
- Modify: root `package.json`, `mise.toml`, `.gitignore`; `packages/core/src/paths.ts`, `agent.ts`, `media.ts`, `host.ts`, `ocr.ts`, `diagnose.ts`, `web.ts`, `watch.ts`, `hoststep.ts`; every `packages/core/tests/*.ts` import (`../x` → `../src/x`)
- Delete: root `tsconfig.json`, root `bunfig.toml`
- Test: `packages/core/tests/paths.test.ts`

**Interfaces:**
- Consumes: Task 1's `.bun-version`.
- Produces:
  - Package `@winvm/core` with `"exports": { "./*": "./src/*.ts" }`; consumers import e.g. `@winvm/core/commands`.
  - `export const PACKAGE_DIR: string` in `packages/core/src/paths.ts` = the `packages/core` directory; every lookup of `assets/`, `firmware/`, `web/` resolves from it.
  - `export function cliEntry(): string` in `packages/core/src/paths.ts`: the absolute path of the CLI entry to spawn, from `process.env["WINVM_CLI"]`; throws `Error("WINVM_CLI is not set: start winvm through apps/cli")` when unset.
  - Package `@winvm/cli` with `"bin": { "winvm": "./src/winvm.ts" }`; `apps/cli/src/winvm.ts` sets `process.env["WINVM_CLI"] ??= import.meta.path` before anything else runs, so detached children inherit it.
  - Root scripts: `build`, `typecheck`, `test` = `turbo run <task>`; `test:scripts` = `bun test scripts`; `check` = `turbo run typecheck test && bun test scripts`; `winvm` = `bun apps/cli/src/winvm.ts`.
  - `winvm` on `PATH` inside the repository: root `devDependencies` has `"@winvm/cli": "workspace:*"`, and `mise.toml` adds `[env] _.path = ["{{config_root}}/node_modules/.bin"]`.

- [ ] **Step 1: Write the failing test** (`packages/core/tests/paths.test.ts`)

```ts
import { afterEach, expect, it } from "bun:test"
import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { PACKAGE_DIR, cliEntry } from "../src/paths"

const saved = process.env["WINVM_CLI"]
afterEach(() => {
  if (saved === undefined) delete process.env["WINVM_CLI"]
  else process.env["WINVM_CLI"] = saved
})

it("finds the package's own files from any working directory", () => {
  for (const d of ["assets", "firmware", "web"]) expect(existsSync(resolve(PACKAGE_DIR, d))).toBe(true)
})

it("spawns the CLI it was started through", () => {
  process.env["WINVM_CLI"] = "/x/apps/cli/src/winvm.ts"
  expect(cliEntry()).toBe("/x/apps/cli/src/winvm.ts")
})

it("says how to start winvm when it does not know its CLI", () => {
  delete process.env["WINVM_CLI"]
  expect(() => cliEntry()).toThrow("WINVM_CLI is not set: start winvm through apps/cli")
})
```

- [ ] **Step 2: Move the files** with `git mv` as listed, then write the workspace files: `pnpm-workspace.yaml` (`packages/*`, `apps/*`); `turbo.json` with tasks `build` (`dependsOn: ["^build"]`, `outputs: ["dist/**"]`), `typecheck` and `test` (`dependsOn: ["^build"]`, `outputs: []`), `globalDependencies` `["mise.toml", "mise.lock", ".bun-version", "pnpm-workspace.yaml"]`; per-package `package.json` and `tsconfig.json` (today's compiler options; core includes `src/**/*.ts` and `tests/**/*.ts`); `packages/core/bunfig.toml` (`[test] root = "."`). `@anthropic-ai/sdk`, `@types/bun` and `typescript` move to `@winvm/core`; `turbo` goes in the root `devDependencies`. `.gitignore` adds `.turbo/`.

- [ ] **Step 3: Run the new test to see it fail**

Run: `pnpm install && cd packages/core && bun test tests/paths.test.ts`
Expected: FAIL, `PACKAGE_DIR` and `cliEntry` are not exported.

- [ ] **Step 4: Implement `PACKAGE_DIR` and `cliEntry`** in `paths.ts`, then replace each `resolve(import.meta.dir, "assets" | "firmware" | "web")` in `agent.ts`, `media.ts`, `host.ts`, `ocr.ts`, `diagnose.ts`, `web.ts` with `resolve(PACKAGE_DIR, ...)`, and each `resolve(import.meta.dir, "winvm.ts")` in `watch.ts`, `hoststep.ts`, `web.ts` with `cliEntry()`. `web.ts`'s spawned jobs use `cwd: PACKAGE_DIR`. Leave `guestagent.ts:436` alone (it runs in the guest); `resolve(import.meta.dir, "guestagent.ts")` stays correct (same directory).

- [ ] **Step 5: Point `apps/cli/src/winvm.ts` at the package** (`./x` imports become `@winvm/core/x`) and set `WINVM_CLI` as its first statement.

- [ ] **Step 6: Typecheck and test through Turborepo**

Run: `pnpm check`
Expected: both packages typecheck; core's tests `201 pass, 0 fail` (198 + 3 new); `scripts` tests `2 pass`.

- [ ] **Step 7: The CLI works through the bin**

Run: `mise trust && mise install && winvm --help | head -3`
Expected: winvm's usage text.

- [ ] **Step 8: From another directory, including what it spawns**

Run: `cd /tmp && winvm doctor && WINVM_HOME=~/.local/state/cage-winvm winvm ls && WINVM_HOME=~/.local/state/cage-winvm winvm open -i nothing-running --web --print | tail -1 && WINVM_HOME=~/.local/state/cage-winvm winvm web --stop`
Expected: doctor's checks; the cage home's image listed; a note that the instance is not running, then a `http://127.0.0.1:…` URL (the detached web server, started via `cliEntry`); "stopped the web server (pid …)".

- [ ] **Step 9: Boot a guest end to end, with the watcher**

Run: `CAGE_WINVM=$PWD/apps/cli/src/winvm.ts CAGE_ENABLE_WHP=1 ~/github/stuffbucket/cage/checks/windows-arm64-winvm/run.sh`
Expected: `0 failed`. Then `WINVM_HOME=~/.local/state/cage-winvm winvm start -i watch-test --ephemeral` (watcher on), `winvm status -i watch-test` shows the watcher running, then `kill` and `destroy` it.

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "refactor: winvm as a Turborepo monorepo, packages/core and apps/cli"
```

---

### Task 4: Documentation and job files use the new commands

**Files:**
- Modify: `README.md`, `docs/*.md`, `jobs/**/*.yml` (comments), `apps/cli/src/winvm.ts` (usage text)

**Interfaces:**
- Consumes: Task 3's `winvm` bin and root scripts.

- [ ] **Step 1: Find every old invocation**

Run: `grep -rn "bun winvm.ts\|winvm\.ts" README.md docs jobs apps/cli/src/winvm.ts`
Expected: the ~64 places to change (62 in README).

- [ ] **Step 2: Replace them** with `winvm …`, and add a "Getting started" section at the top of `README.md` with the spec's sequence, limited to what exists after this plan:

```sh
mise install            # Bun 1.4.3 and pnpm
pnpm install
winvm doctor            # check the host
winvm start             # boot the default instance
```

Note that `winvm` is on `PATH` inside the repository through mise, and `pnpm winvm …` works without mise activation.

- [ ] **Step 3: Verify none are left**

Run: `grep -rn "bun winvm.ts" README.md docs jobs apps`
Expected: no output.

- [ ] **Step 4: Commit**

```bash
git add README.md docs jobs apps/cli/src/winvm.ts
git commit -m "docs: run winvm through its bin, and a getting-started sequence"
```

---

### Task 5: Pull-request CI

**Files:**
- Create: `.github/workflows/ci.yml`, `scripts/check-commit-msg.ts` (from maximal, adapted), `scripts/check-commit-msg.test.ts`
- Modify: any core test that needs macOS (skip on other platforms with a reason)

**Interfaces:**
- Consumes: `.bun-version`, `packageManager`, `scripts/check-lockfile-hosts.ts`, root `check` script.
- Produces: a required-able check named `ci / check`.

- [ ] **Step 1: Bring over the commit-subject check** from `~/github/stuffbucket/maximal/scripts/check-commit-msg.ts` with its accepted types, and a test that accepts `fix(qemu): pass ppi=off only when supported` and rejects `Fixed stuff`.

- [ ] **Step 2: Run the test**

Run: `bun test scripts/check-commit-msg.test.ts`
Expected: PASS.

- [ ] **Step 3: Write `ci.yml`** following monimal's `.github/workflows/ci.yml`: triggers `pull_request` and `push` to `main`; `permissions: contents: read`; `defaults.run.shell: bash -eo pipefail`; job `check` on `ubuntu-latest`: checkout; `pnpm/action-setup` (version from `packageManager`); `oven-sh/setup-bun` with `bun-version-file: .bun-version`; pnpm store cache keyed on `pnpm-lock.yaml` (saved on push only); `pnpm install --frozen-lockfile`; `bun scripts/check-lockfile-hosts.ts`; on pull requests, the commit-subject check over the PR's commits; `pnpm check`; a step asserting `bun --version` equals `.bun-version`; `actionlint`. Pin each action to the exact version monimal uses.

- [ ] **Step 4: Run the suite as CI will, on Linux**

Run: `docker run --rm -v "$PWD":/w -w /w oven/bun:1.4.3 sh -c 'bunx pnpm@12.3.4 install --frozen-lockfile && bunx pnpm@12.3.4 check'` (Colima's Docker; if no Docker is available, go to Step 5 and let CI be the Linux run).
Expected: all pass. Any test that needs macOS (QEMU, `swift`, `hdiutil`, `sips`) is skipped on non-darwin with `it.skipIf(process.platform !== "darwin")` and a comment saying what it needs.

- [ ] **Step 5: Push the branch and watch CI**

Run: `git push -u origin <branch> && gh run watch --exit-status`
Expected: `check` succeeds.

- [ ] **Step 6: Commit** (any skips added in Step 4 go in with it)

```bash
git add .github/workflows/ci.yml scripts/check-commit-msg.ts scripts/check-commit-msg.test.ts packages/core/tests
git commit -m "ci: typecheck and test the workspace on every pull request"
```
