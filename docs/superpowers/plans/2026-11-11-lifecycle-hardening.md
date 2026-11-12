# WinVM Lifecycle Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Replace stale detached WinVM management generations safely while Windows keeps running, and make missing or wedged viewer sidecars fail within a bound with actionable errors.

**Architecture:** A content-derived build identity is embedded into compiled sidecars and computed once for source runs. Service and watcher metadata carry that identity; a serialized per-instance reconciler quiesces the watcher, rotates stale management processes, and never signals QEMU. The Tauri shell runs the sidecar through an event-aware bounded runner that terminates only the invoked CLI and returns a structured failure normalized by the viewer backend.

**Tech Stack:** Bun 1.4.3, TypeScript, bun:test, Rust 1.99, Tauri 2.12.5, tauri-plugin-shell 2.3.5, Tokio 1.x time support, React.

**Spec:** `docs/superpowers/specs/2026-11-11-lifecycle-hardening.md`

## Global Constraints

- Write each behavior test first and run it to observe the expected failure before changing production code.
- Build identity must distinguish changed executable content even when version and installed path are unchanged.
- Metadata with no build identity is legacy and stale, not malformed.
- When replacement requires quiescence, reconciliation orders watcher stop, stale service stop, current service start, then watcher restoration; a current watcher remains running while a merely missing service is retried.
- Automatic read/status reconciliation defers without signalling a watcher that is autosaving or stowing; explicit management retains the existing save-aware bounded wait and forced-termination fallback.
- Reconciliation never sends a signal to QEMU, swtpm, or virtiofsd.
- Timed-out viewer invocations terminate only that CLI child, never its process group.
- Long-running mutating verbs (`start`, `stop`, `setup`, `save`, `load`, file transfers) must not inherit the short read timeout.
- Detached `serve`, `watch`, and watcher-spawned save/stow children never recursively reconcile.
- Tests use temporary `WINVM_HOME` directories and must not signal real user processes.
- Preserve the existing checkpoint-copy edits in `apps/viewer/ui/src/i18n/en.json` and `apps/viewer/tests/i18n.test.ts`.
- No new third-party JavaScript dependency.

## Review Focus

- A content change at the same compiled path changes identity and rotates management processes (Task 1 compile smoke; Tasks 2-3 mismatch tests).
- A watcher already autosaving or stowing finishes through its long graceful deadline before service replacement (Task 2 active-state tests; Task 3 ordering test).
- Concurrent status polls cannot double-spawn or stop one another's replacement service (Task 3 serialized-reconcile test).
- Replacement failure leaves QEMU's pid and start identity untouched and a later valid invocation can recover (Task 3 failure-and-retry test).
- A timed-out status or terminal connection kills only the CLI child, reports why, and polling/retry remains usable (Task 4 Rust and viewer tests).

---

### Task 1: Content-derived build identity

**Files:**
- Create: `packages/core/src/identity.ts`
- Modify: `packages/core/src/paths.ts`
- Modify: `apps/viewer/scripts/build-sidecar.ts`
- Test: `packages/core/tests/identity.test.ts`
- Test: `packages/core/tests/compiled.test.ts`

**Interfaces:**
- Produces `identityFromEntries(entries: readonly { readonly path: string; readonly bytes: Uint8Array }[], version: string, bunVersion: string): string`, a deterministic `sha256:<hex>` over sorted paths, bytes, version, and Bun version.
- Produces `sourceBuildIdentity(): string`, hashing the CLI/core TypeScript sources plus the root `package.json`, `apps/cli/package.json`, `packages/core/package.json`, `.bun-version`, `pnpm-lock.yaml`, `packages/core/runtime.json`, and `apps/viewer/scripts/build-sidecar.ts`.
- Produces `buildIdentity(): string`, memoized per process, preferring the compile-time `WINVM_BUILD_ID`, then `process.env.WINVM_BUILD_ID`, then `sourceBuildIdentity()`.
- `recordCliEntry(path)` continues recording `WINVM_CLI` and also sets `process.env.WINVM_BUILD_ID` to the process's memoized identity so detached descendants inherit the exact parent generation.
- `build-sidecar.ts` computes `sourceBuildIdentity()` before compilation and passes it through Bun's `--define` as `WINVM_BUILD_ID`; no runtime file lookup is required by the compiled executable.

- [x] **Step 1: Write failing identity tests**

Add tests proving sorted identical entries return the same identity, a one-byte source change returns a different identity, version/Bun changes return a different identity, an environment identity is stable after source files change, and `recordCliEntry` exports both CLI path and identity.

- [x] **Step 2: Run the tests and observe the intended failure**

Run: `cd packages/core && bun test tests/identity.test.ts tests/compiled.test.ts`

Expected: FAIL because `src/identity.ts` and the identity exports do not exist.

- [x] **Step 3: Implement the identity module and propagation**

Use `node:crypto` SHA-256 and deterministic sorted relative paths. Cache the selected identity on first use. Keep the compile-time lookup guarded with `typeof WINVM_BUILD_ID` so source execution never throws.

- [x] **Step 4: Embed the same identity in the compiled sidecar**

Modify `build-sidecar.ts` to pass the computed identity through `bun build --compile --define`. Preserve the existing target and output naming.

- [x] **Step 5: Verify focused tests and a compile smoke**

Run:
- `cd packages/core && bun test tests/identity.test.ts tests/compiled.test.ts`
- `bun apps/viewer/scripts/build-sidecar.ts`
- `pnpm --filter @winvm/core typecheck`

Expected: all tests pass, typecheck succeeds, and the sidecar compiles.

- [x] **Step 6: Commit**

```bash
git add packages/core/src/identity.ts packages/core/src/paths.ts packages/core/tests/identity.test.ts packages/core/tests/compiled.test.ts apps/viewer/scripts/build-sidecar.ts
git commit -m "fix(lifecycle): identify exact winvm build generations"
```

---

### Task 2: Generation-aware service and watcher records

**Files:**
- Modify: `packages/core/src/service.ts`
- Modify: `packages/core/src/watch.ts`
- Modify: `packages/core/src/paths.ts`
- Test: `packages/core/tests/service.test.ts`
- Test: `packages/core/tests/watch.test.ts`
- Test: `packages/core/tests/pidfile.test.ts`

**Interfaces:**
- `ServiceInfo` gains optional `readonly build?: string`; new services always write `build: buildIdentity()`.
- `serviceFreshness(info: ServiceInfo, current?: string): "current" | "stale" | "legacy"` classifies absent identity as legacy and a mismatch as stale.
- `WatchState` gains optional `readonly build?: string` and `readonly cli?: string`; the watcher publishes `{pid, build, cli}` immediately after acquiring `watch.pid` and on every later state write.
- `watcherRecord(name: string): { readonly pid: number; readonly build?: string } | null` trusts `watch.json` only when its pid equals the validated `watch.pid` pid.
- `watcherFreshness(record, current?): "current" | "stale" | "legacy"` mirrors service classification.
- `ensureService(name, p)` reuses only a current generation and waits for the replacement record to contain the current build. It remains idempotent after a failed start.
- Existing PID command validation remains mandatory before SIGTERM/SIGKILL; a mismatched or reused PID causes stale metadata cleanup, never a signal.
- Existing `stopWatcher` timing remains 10 seconds normally and 10 minutes for `autosaving`/`stowing`.

- [x] **Step 1: Write failing service-generation tests**

Add focused tests for same-generation reuse, mismatched-generation replacement, legacy-record replacement, replacement readiness requiring the current build, and a reused unrelated PID never being signalled.

- [x] **Step 2: Run service tests and observe the intended failures**

Run: `cd packages/core && bun test tests/service.test.ts tests/pidfile.test.ts`

Expected: new assertions fail because service metadata has no build and reuse compares only `cli`.

- [x] **Step 3: Implement service metadata and freshness**

Keep `readService` capable of returning a live legacy record. Put freshness decisions in `serviceFreshness`/`ensureService`, not in `readService`, so callers can inspect stale state safely.

- [x] **Step 4: Write failing watcher-generation and shutdown tests**

Add tests for same-generation watcher reuse, mismatched and legacy records being stale, pid disagreement between `watch.pid` and `watch.json`, PID-reuse safety, and `autosaving`/`stowing` selecting the long graceful deadline through an injectable clock/process seam rather than a real ten-minute wait.

- [x] **Step 5: Run watcher tests and observe the intended failures**

Run: `cd packages/core && bun test tests/watch.test.ts tests/pidfile.test.ts`

Expected: new assertions fail because watcher state has no build or freshness decision.

- [x] **Step 6: Implement watcher metadata and freshness**

Publish the identity immediately after lock acquisition. Keep `ensureWatcher`'s current synchronous spawn behavior; Task 3 owns asynchronous stop-and-replace ordering.

- [x] **Step 7: Verify lifecycle metadata tests and typecheck**

Run:
- `cd packages/core && bun test tests/service.test.ts tests/watch.test.ts tests/pidfile.test.ts`
- `pnpm --filter @winvm/core typecheck`

Expected: all pass.

- [x] **Step 8: Commit**

```bash
git add packages/core/src/service.ts packages/core/src/watch.ts packages/core/src/paths.ts packages/core/tests/service.test.ts packages/core/tests/watch.test.ts packages/core/tests/pidfile.test.ts
git commit -m "fix(lifecycle): record service and watcher generations"
```

---

### Task 3: Serialized startup reconciliation that preserves QEMU

**Files:**
- Create: `packages/core/src/lifecycle.ts`
- Modify: `packages/core/src/paths.ts`
- Modify: `packages/core/src/service.ts`
- Modify: `packages/core/src/watch.ts`
- Modify: `packages/core/src/commands.ts`
- Modify: `apps/cli/src/winvm.ts`
- Test: `packages/core/tests/lifecycle.test.ts`
- Test: `packages/core/tests/service.test.ts`
- Test: `packages/core/tests/watch.test.ts`

**Interfaces:**
- `Paths` gains `reconcile: <instance>/reconcile.lock`.
- Produces `type ManagementFailureKind = "service-replace" | "watcher-replace" | "reconcile-lock"` and `class ManagementError extends Error { readonly kind: ManagementFailureKind; readonly retryable = true }`.
- Produces `type ReconcileResult = { readonly changed: boolean; readonly servicePid: number | null; readonly watcherPid: number | null; readonly deferred?: "saving" | "autosaving" | "stowing" }`.
- Produces `reconcileManagement(name: string, p?: Paths, options?: ReconcileOptions): Promise<ReconcileResult>`; automatic read/status callers defer busy watcher work, while explicit start may use bounded waiting.
- Produces `shouldReconcileVerb(verb: string, env?: NodeJS.ProcessEnv): boolean`; it is false for `serve`, `watch`, destructive teardown/build/test verbs, and when `WINVM_NO_RECONCILE=1`.
- The reconciler returns without changes when QEMU is not running. For a running instance it serializes callers with a pid-validated O_EXCL lock and rechecks records after acquiring it.
- Same-build records are reusable across CLI paths. Legacy records rotate. A different build at the same CLI path rotates as an in-place update; a live different-build record at another CLI path is foreign and automatic reconciliation leaves it untouched to prevent install ping-pong.
- If replacement requires watcher quiescence, preserve watcher intent as durable QEMU-bound debt, stop only validated management processes, start/verify the current service, and restore the watcher when watching remains enabled. If the service is merely missing, keep an existing current watcher running during retries.
- If a live save lock or `saving.json` owner exists while QEMU is running, return `deferred: "saving"` without stopping the service. Automatic read/status reconciliation also immediately defers an `autosaving` or `stowing` watcher without signalling it; explicit start keeps the bounded save-aware shutdown path.
- Detached service/watcher spawns and watcher-spawned save/stow children receive `WINVM_NO_RECONCILE=1`.
- The CLI invokes reconciliation before instance-scoped read/management verbs; `status --json` is the viewer startup-repair path. `serve` and `watch` cannot recurse.
- The already-running `start` path unconditionally reaches the same freshness/reconciliation logic instead of checking only `readService(p) === null`.

- [x] **Step 1: Write failing reconciliation tests**

Cover: no-QEMU no-op; same-generation no-op; watcher-before-service ordering; stale service with a current watcher still quiesces and restores that watcher; a live manual-save lock defers replacement; absent watcher stays absent; legacy records rotate; simultaneous reconciliations produce one replacement; serve/watch/child recursion is skipped.

- [x] **Step 2: Add failed-replacement and QEMU-preservation tests**

Use a temporary pidfile/process seam. Force service spawn/readiness failure, assert `ManagementError.kind === "service-replace"`, stale service metadata is not reported healthy, QEMU's pid is unchanged and never receives a nonzero signal, then make the spawn valid and prove a second reconciliation succeeds.

- [x] **Step 3: Run tests and observe the intended failures**

Run: `cd packages/core && bun test tests/lifecycle.test.ts tests/service.test.ts tests/watch.test.ts`

Expected: FAIL because lifecycle interfaces and startup call path do not exist.

- [x] **Step 4: Implement lock, ordering, error, and retry behavior**

Reuse existing process validation and atomic-file conventions. On any failure, release only the caller-owned reconcile lock. Never call QEMU cleanup helpers from this module.

- [x] **Step 5: Integrate CLI startup without recursion**

Place the call after argument/finder resolution and before the relevant command dispatch. Preserve read-only behavior for homes/instances with no running QEMU. Set `WINVM_NO_RECONCILE=1` on detached and watcher child environments.

- [x] **Step 6: Verify focused and core suites**

Run:
- `cd packages/core && bun test tests/lifecycle.test.ts tests/service.test.ts tests/watch.test.ts tests/saved-display.test.ts tests/saves.test.ts`
- `pnpm --filter @winvm/core typecheck`
- `pnpm --filter @winvm/cli typecheck`

Expected: all pass.

- [x] **Step 7: Commit**

```bash
git add packages/core/src/lifecycle.ts packages/core/src/paths.ts packages/core/src/service.ts packages/core/src/watch.ts packages/core/src/commands.ts apps/cli/src/winvm.ts packages/core/tests
git commit -m "fix(lifecycle): reconcile stale management processes safely"
```

---

### Task 4: Bounded structured viewer sidecar failures

**Files:**
- Create: `apps/viewer/src-tauri/src/sidecar.rs`
- Modify: `apps/viewer/src-tauri/src/lib.rs`
- Modify: `apps/viewer/src-tauri/src/agent.rs`
- Modify: `apps/viewer/src-tauri/Cargo.toml`
- Modify: `apps/viewer/src-tauri/Cargo.lock`
- Modify: `apps/viewer/ui/src/backend.ts`
- Modify: `apps/viewer/ui/src/features/winvm/useWinvm.ts`
- Modify: `apps/viewer/ui/src/features/terminal/TerminalWindow.tsx`
- Modify: `apps/viewer/ui/src/i18n/en.json`
- Test: inline Rust tests in `apps/viewer/src-tauri/src/sidecar.rs`
- Test: `apps/viewer/tests/backend.test.ts`
- Test: `apps/viewer/tests/pause-ui.test.tsx`
- Test: `apps/viewer/tests/terminal.test.ts`
- Test: `apps/viewer/tests/i18n.test.ts`

**Interfaces:**
- Rust produces serializable `SidecarFailure` tagged by `kind`: `missing`, `launch`, `timeout`, or `exit`; every variant carries `operation` and actionable `message`, with diagnostic `stdout`/`stderr`, optional `code`/`signal`, and `timeoutMs` where applicable.
- `run_sidecar(app, args, timeout)` uses `.spawn()` and consumes `CommandEvent::{Stdout, Stderr, Terminated, Error}`. Timeout sends SIGTERM to the CLI pid, waits a two-second grace period, then consumes `CommandChild::kill()` for SIGKILL. It never signals a process group.
- `share_start` uses the same bounded event runner for the `cua serve` token handshake, and `agent connect` uses it before taking the existing HTTP path; neither can hold viewer state indefinitely.
- Normal nonzero termination is `SidecarFailure(kind="exit")`; signal termination is also `exit` with the signal.
- Timeout policy is operation-specific: status/list/info and terminal discovery/connect are bounded; long mutating operations keep a generous explicit bound or no automatic short bound.
- The existing Tauri `winvm` command returns `Result<Output, SidecarFailure>`.
- UI produces `type SidecarFailure`, `class SidecarError extends Error`, `isSidecarError`, and `normalizeSidecarFailure` in `backend.ts`.
- The `winvm()` wrapper converts rejected `exit` failures back into backward-compatible `Output {code, stdout, stderr, failure}` for existing call sites, and throws `SidecarError` for missing/launch/timeout.
- Status and terminal surfaces use the normalized actionable message; polling and TerminalView's existing retry path continue after failure.
- Add English catalog entries for missing helper, launch failure, and timeout. Preserve the checkpoint-copy entry and test already present.

- [x] **Step 1: Write failing Rust policy and event-collection tests**

Test verb timeout selection, stdout/stderr collection, nonzero exit classification, `CommandEvent::Error`, timeout classification with partial output, the bounded share token handshake, and that timeout invokes the exact child pid terminator before escalation.

- [x] **Step 2: Run Rust tests and observe the intended failure**

Run: `bun apps/viewer/scripts/build-ui.ts && CARGO_TARGET_DIR=/private/tmp/winvm-lifecycle-cargo-199 mise -C apps/viewer exec -- cargo test --manifest-path src-tauri/Cargo.toml sidecar`

Expected: FAIL because `sidecar.rs` does not exist.

- [x] **Step 3: Implement the bounded sidecar runner**

Add direct Tokio time support at the lockfile-resolved 1.x line. Reuse the runner for the general `winvm` command and bound `agent connect`; preserve the existing `paused:` classification. Do not apply a read-sized timeout to setup/save/load/start/stop/file transfer calls.

- [x] **Step 4: Write failing viewer normalization and recovery tests**

Test structured-object and legacy-string rejection normalization, exit-to-Output compatibility, timeout status copy with polling rescheduled, missing-sidecar status copy, and terminal timeout flowing into the existing failed/retry state.

- [x] **Step 5: Run viewer tests and observe the intended failures**

Run: `cd apps/viewer && bun test tests/backend.test.ts tests/pause-ui.test.tsx tests/terminal.test.ts tests/i18n.test.ts`

Expected: new assertions fail because failures are still flattened to strings.

- [x] **Step 6: Implement backend normalization and actionable UI copy**

Convert failures only at the `backend.ts` funnel so existing call sites never stringify a structured object as `[object Object]`. Keep the generic terminal package unchanged.

- [x] **Step 7: Verify Rust, viewer, and typecheck suites**

Run:
- `bun apps/viewer/scripts/build-ui.ts`
- `CARGO_TARGET_DIR=/private/tmp/winvm-lifecycle-cargo-199 mise -C apps/viewer exec -- cargo test --manifest-path src-tauri/Cargo.toml`
- `cd apps/viewer && bun test tests`
- `pnpm --filter @winvm/viewer typecheck`

Expected: all pass.

- [x] **Step 8: Commit**

```bash
git add apps/viewer/src-tauri apps/viewer/ui/src apps/viewer/tests
git commit -m "fix(viewer): bound and explain sidecar failures"
```

---

## Integrated verification

- [x] Run `pnpm check`; expect all Turbo tasks and script tests to pass.
- [x] Run `pnpm --filter @winvm/viewer app`; expect the development app and embedded sidecar to build.
- [x] Before live repair, record `demo` QEMU pid/start time, service pid/build, watcher pid/build, watcher state, and guest-agent status under `WINVM_HOME=/Users/brian/.local/state/cage-winvm`.
- [x] If watcher state is `autosaving` or `stowing`, wait for `watching`; do not force the live acceptance.
- [x] Trigger reconciliation with the newly built CLI/viewer.
- [x] Verify old service/watcher pids exited, new metadata contains the current build identity, a second status call reuses those pids, QEMU pid/start time and swtpm pid are unchanged, and guest status/agent plus `exec -- hostname` still work.
- [x] Never invoke `kill`, `stop`, `stow`, `reset`, or destructive cleanup against the live `demo` instance during acceptance.

### Integrated verification evidence

- `pnpm check`: passed all integrated Turbo, test, typecheck, and script gates.
- Development app build: passed; packaged CLI identity was `sha256:0b56e5da37216f9ba1a8f14f23e5b64a624b93a47c8b048283c4bd6ab600aeff`.
- Pre-repair `demo`: QEMU pid `10528` and swtpm pid `10519` both started 2026-10-28 03:03:36 local time; legacy service pid `10522` and watcher pid `12584` had no build metadata; watcher state was `watching`; direct QGA `guest-ping` returned successfully.
- First packaged `status --json -i demo`: reported that management moved to this build, kept QEMU pid `10528`, showed guest agent `ok`, and installed service pid `89800` plus watcher pid `89802` with the packaged build identity and CLI path.
- Process comparison: legacy pids `10522` and `12584` exited; QEMU pid/start time and swtpm pid/start time were unchanged; only the service and watcher were replaced.
- Second packaged status reused service pid `89800` and watcher pid `89802` with unchanged process start times and no repair notice.
- Post-repair direct QGA `guest-ping` returned successfully and `exec -i demo -- hostname` returned `WINVM`.
- No destructive VM command was used during acceptance.
