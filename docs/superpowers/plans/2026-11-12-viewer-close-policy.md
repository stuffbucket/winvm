# Viewer Close Policy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add viewer-wide VM-operation feedback and a safe all-machine close transaction with per-machine remembered leave/stow/shutdown policy.

**Architecture:** Each VM-changing CLI process publishes an ownership-validated per-process operation record that `status --json` exposes; the React viewer combines that remote state with its own local action and renders one display-wide blocking treatment. Tauri owns an idempotent close/exit authorization state machine, while a focused React hook obtains fresh status, resolves the selected live machine first, iterates every other live machine, and only authorizes exit after all choices succeed.

**Tech Stack:** Bun/TypeScript, React 18, Zod, happy-dom, Tauri 2/Rust, existing QMP/QGA/watcher lifecycle APIs.

**Spec:** `docs/superpowers/specs/2026-11-12-viewer-close-policy-design.md`

## Global Constraints

- Preserve all pre-existing uncommitted lifecycle-review changes; inspect the current diff before each task and edit only the named feature files and tests.
- Follow strict TDD: add one behavior test, run it and observe the expected RED failure, then make the minimum production change and run the relevant package suite GREEN. Where a step lists several named cases, repeat that RED/GREEN cycle one case at a time; the aggregate command at the end is regression verification, not permission to batch production ahead of tests.
- Do not commit, push, merge, open a PR, reset, restore, clean, or otherwise discard work; commit steps are intentionally omitted from this plan.
- Main-window Close, Cmd-W, and Quit are one transaction; the selected live machine is resolved first, then all other live machines.
- Never signal QEMU directly from close handling and never substitute `kill` for failed stow or graceful shutdown.
- The default close policy is `ask`; `Remember for this Windows machine` starts unchecked on every ask and is persisted only after the chosen action succeeds.
- `winvm stop` keeps its core 180-second deadline; the viewer adds no short deadline to close-triggered `stop` or `stow`.
- Update restart, crashes, Force Quit, and process kills leave detached VMs running.
- Operation copy remains concise and uniform: `Starting Windows`, `Shutting Down`, `Restarting Windows`, `Saving Windows`, `Loading Windows`, `Stowing Windows`, `Pausing Windows`, `Resuming Windows`, `Suspending Windows`, `Waking Windows`, `Locking Windows`, `Resetting Windows`, `Turning Off Windows`, and `Installing Windows`.
- Do not stow or shut down a real user VM during acceptance without explicit authorization; the safe live path is `Leave Running` plus QEMU PID continuity.

## Review Focus

- A PID reused by an unrelated process, a malformed record, or a crashed CLI must not leave the viewer permanently busy; Task 1 tests command/instance ownership and stale cleanup.
- Two overlapping VM commands must not delete each other’s operation state; Task 1 tests per-PID records and ownership-aware cleanup.
- A close request racing a newly started machine must not silently omit it; Task 6 tests the repeated final all-instance recheck.
- A shutdown failure after waking a paused/asleep VM must restore its held state, watcher, and Finder integration; Task 3 tests rollback in each original state.
- Repeated Close/Quit/ExitRequested events must neither duplicate dialogs/operations nor bypass unresolved machines; Task 4 tests coordinator transition idempotence and Task 6 tests one active frontend flow.

---

## File Structure

**Create:**

- `packages/core/src/operation.ts` — operation enum, per-PID record lease, live-owner validation, and status selection.
- `packages/core/tests/operation.test.ts` — operation publication, concurrency, stale ownership, and cleanup tests.
- `apps/viewer/src-tauri/src/close.rs` — pure close-coordinator state machine used by Tauri event handlers and commands.
- `apps/viewer/ui/src/features/operation/OperationOverlay.tsx` — the single display-wide operation treatment.
- `apps/viewer/ui/src/features/close/closeQueue.ts` — pure live-machine queue ordering and resolution rules.
- `apps/viewer/ui/src/features/close/useCloseFlow.ts` — close transaction orchestration.
- `apps/viewer/ui/src/features/close/ClosePolicyDialog.tsx` — dedicated four-choice modal with unchecked Remember control.
- `apps/viewer/tests/operation-ui.test.tsx` — operation parsing, polling, overlay, and interaction tests.
- `apps/viewer/tests/close-flow.test.tsx` — all-machine sequencing, persistence, cancellation, failure, and recheck tests.
- `apps/viewer/tests/close-dialog.test.tsx` — modal focus, copy, checkbox reset, waiting cancellation, and dismissal tests.
- `apps/viewer/tests/close-policy-setting.test.tsx` — Details-panel close-policy mutation and error tests.

**Modify:**

- `packages/core/src/paths.ts`, `apps/cli/src/winvm.ts`, `packages/core/src/status.ts` — publish and expose validated operations.
- `packages/core/src/config.ts`, `packages/core/tests/watch.test.ts` — add and validate `viewer.closePolicy`.
- `packages/core/src/commands.ts`, `packages/core/tests/frozen.test.ts` — make graceful stop handle starting/paused/asleep guests and rollback failures.
- `apps/viewer/src-tauri/src/lib.rs` — intercept Close/Quit/exit, expose close commands, and authorize updater restart.
- `apps/viewer/ui/src/model.ts`, `apps/viewer/tests/model.test.ts` — backward-compatible operation and close-policy schemas.
- `apps/viewer/ui/src/backend.ts` — typed close events and coordinator commands.
- `apps/viewer/ui/src/features/winvm/statusGuard.ts`, `apps/viewer/ui/src/features/winvm/useWinvm.ts`, `apps/viewer/tests/pause-ui.test.tsx` — combine local/remote operation state and provide explicit-instance actions/fresh reads.
- `apps/viewer/ui/src/App.tsx`, `apps/viewer/ui/src/features/panel/Panel.tsx`, `apps/viewer/ui/src/styles/styles.css`, `apps/viewer/ui/src/i18n/en.json`, `apps/viewer/tests/i18n.test.ts` — integrate the operation overlay, close flow/dialog, and discoverable close-policy setting.

---

### Task 1: Cross-process VM operation records

**Files:**
- Create: `packages/core/src/operation.ts`
- Create: `packages/core/tests/operation.test.ts`
- Modify: `packages/core/src/paths.ts:127-201`
- Modify: `apps/cli/src/winvm.ts:141-164,218-434`
- Modify: `packages/core/src/status.ts:17-31,66-96,365-437`
- Test: `packages/core/tests/operation.test.ts`
- Test: `packages/core/tests/frozen.test.ts`

**Interfaces:**
- Produces `VmOperation = "start" | "stop" | "reboot" | "kill" | "reset" | "snapshot" | "rewind" | "save" | "load" | "pause" | "resume" | "sleep" | "wake" | "lock" | "stow" | "setup" | "golden-create" | "golden-reset"`, `VM_OPERATIONS`, and `OperationInfo` with `{ operation, pid, startedAt }`.
- Produces `operationFor(sub: string | undefined, args: Args): VmOperation | null`, `withOperation<T>(name: string, operation: VmOperation, run: () => T | Promise<T>): Promise<T>`, and `readOperation(name: string, seams?: OperationReadSeams): OperationInfo | null`.
- The private on-disk record also carries an unguessable lease token; that token is never exposed in `OperationInfo`.
- Adds `Paths.operations`, a per-instance directory containing one `<pid>.json` record per active command.
- Adds `InstanceStatus.operation: OperationInfo | null`.

- [ ] **Step 1: Write failing record-lifecycle tests**

Add tests named:

- `publishes this pid and operation until the command settles`
- `keeps another pid's operation when this lease clears`
- `chooses the newest valid operation when records overlap`
- `rejects malformed, dead, reused, wrong-instance, and wrong-verb owners`
- `removes only the stale record it inspected`

Use injected `alive(pid)` and `command(pid)` seams so tests exercise real file/CAS behavior without signalling processes. For ordinary verbs, validate with `winvmCommandAfter(command, verb)`; for `golden-create`/`golden-reset`, validate `winvmCommandAfter(command, "golden")` plus the first nested word. An explicit `commandInstance(...)` must equal the recorded instance; when the command has no selector, accept the resolved instance published by that live CLI process because `WINVM_INSTANCE` is not present in `ps` text. Reject every wrong verb, nested action, executable, or explicit instance.

- [ ] **Step 2: Run the operation test and verify RED**

Run: `bun test packages/core/tests/operation.test.ts`

Expected: FAIL because `operation.ts`, `Paths.operations`, and its exports do not exist.

- [ ] **Step 3: Implement operation records**

Use atomic temp-file-plus-rename writes under `instances/<name>/operations/`. `withOperation` must clear its own exact record in `finally`; stale readers remove only the unchanged file they inspected. Map only machine-impacting invocations: `start`, `stop`, `reboot`, `kill`, `reset`, `snapshot`, `rewind`, `save`, `load`, `pause`, `resume`, `sleep`, `wake`, `lock`, `stow`, `setup`, and `golden create|reset`. Cleanup must reread the file and unlink it only when its lease token still matches, so neither overlapping publication nor PID reuse can erase a newer owner.

Wrap those CLI cases with `withOperation(instanceName(args), operation, action)` without changing unrelated dispatch behavior or calling `process.exit` from inside the lease callback.

- [ ] **Step 4: Add failing status-exposure tests**

Extend the existing temporary-instance status test to assert `operation: null` by default and the validated `OperationInfo` while an operation record is live. Include a crashed/dead owner and assert status returns `null`, not permanent busy state.

- [ ] **Step 5: Run the status test and verify RED**

Run: `bun test packages/core/tests/frozen.test.ts`

Expected: FAIL because `InstanceStatus` and `gather()` do not expose `operation`.

- [ ] **Step 6: Expose the operation in all status shapes**

Call `readOperation(name)` once in `gather()` and return it for missing, stopped, stowed, held, and running instances (viewer `phase(status)` derives `starting` from a running silent-agent status). Do not make status wait for the operation or its save lock.

- [ ] **Step 7: Verify Task 1 GREEN**

Run:

```bash
bun test packages/core/tests/operation.test.ts packages/core/tests/frozen.test.ts
bun --filter @winvm/core test
bun --filter @winvm/core typecheck
```

Expected: all core tests and typecheck pass.

### Task 2: Close-policy configuration and backward-compatible status model

**Files:**
- Modify: `packages/core/src/config.ts:17-143`
- Modify: `packages/core/tests/watch.test.ts:315-357`
- Modify: `packages/core/src/status.ts:66-96,365-437`
- Modify: `apps/viewer/ui/src/model.ts:1-37,64-89`
- Modify: `apps/viewer/tests/model.test.ts:22-66,320-337`

**Interfaces:**
- Produces `ClosePolicy = "ask" | "leave" | "stow" | "shutdown"` and `CLOSE_POLICIES` from core config.
- Adds `InstanceConfig["viewer.closePolicy"]`, defaulting to `ask` with no persisted override.
- Adds `InstanceStatus.closePolicy: ClosePolicy` and viewer `Status.closePolicy` defaulting to `ask` when absent.
- Viewer model exports its Zod-inferred `VmOperation`, `OperationInfo`, and `ClosePolicy` types plus `closePolicyAssignment(policy: ClosePolicy): string`.

- [ ] **Step 1: Write failing core configuration tests**

Assert exact acceptance of all four enum values, rejection of case variants/unknown values with an actionable list, invalid on-disk values falling back to `ask`, and writing `ask` removing the override while preserving unrelated settings.

- [ ] **Step 2: Run the focused core test and verify RED**

Run: `bun test packages/core/tests/watch.test.ts --test-name-pattern "instance settings"`

Expected: FAIL because `viewer.closePolicy` is unknown and string settings still all use title validation.

- [ ] **Step 3: Implement enum-specific config validation**

Branch string validation/parsing by key: `title` continues through `checkTitle`; `viewer.closePolicy` accepts only `CLOSE_POLICIES`. Keep override-only atomic writes unchanged.

- [ ] **Step 4: Write failing status/parser compatibility tests**

In core status coverage, assert effective policy is emitted. In `model.test.ts`, assert a new payload parses `operation` and `closePolicy`, while an older payload lacking both parses as `operation: null` and `closePolicy: "ask"`.

- [ ] **Step 5: Run focused parser tests and verify RED**

Run: `bun test apps/viewer/tests/model.test.ts packages/core/tests/frozen.test.ts`

Expected: FAIL because neither status model carries the new fields.

- [ ] **Step 6: Implement core and viewer status fields**

Add Zod operation and close-policy schemas, with defaults only for backward compatibility. Keep unknown operation names invalid rather than presenting misleading copy.

- [ ] **Step 7: Verify Task 2 GREEN**

Run:

```bash
bun test packages/core/tests/watch.test.ts packages/core/tests/frozen.test.ts apps/viewer/tests/model.test.ts
bun --filter @winvm/core typecheck
bun --filter @winvm/viewer typecheck
```

Expected: focused tests and both typechecks pass.

### Task 3: Graceful shutdown from starting, paused, and asleep states

**Files:**
- Modify: `packages/core/src/commands.ts:806-829`
- Modify: `packages/core/tests/frozen.test.ts`

**Interfaces:**
- Produces `stopWith(args: Args, seams?: StopCommandSeams): Promise<number>`; exported `stop(args)` delegates to it with production dependencies. `StopCommandSeams` has optional `now`, `sleep`, `pidOf`, `isRunning`, `frozenState`, `resume`, `hold`, `waitFor`, `shutdown`, `watcherPid`, `stopWatcher`, `ensureWatcher`, `beforeDown`, `afterUp`, and `stopSidecars` functions matching those production calls.
- Consumes existing `qga.waitFor`, `qga.shutdown`, `frozenState`, QMP `cont`/`stop`, asleep marking, `watcherPid`/`stopWatcher`/`ensureWatcher`, and Finder down/up hooks.

- [ ] **Step 1: Write failing shutdown state-machine tests**

Use seams and a fake clock to assert:

- a starting guest waits for QGA only within the existing shared 180-second deadline, then requests shutdown;
- paused and asleep guests resume before shutdown;
- success does not restore held state or watcher;
- timeout/failure restores paused state, restores the asleep mark when applicable, restarts a watcher only when one existed, and calls Finder recovery;
- a guest that never becomes agent-ready fails without sending shutdown or kill.

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `bun test packages/core/tests/frozen.test.ts --test-name-pattern "graceful stop"`

Expected: FAIL because current `stop()` immediately calls QGA and has no held-state or watcher rollback.

- [ ] **Step 3: Implement one deadline and rollback path**

Capture original frozen state, QEMU PID, and watcher presence before teardown. Start the 180-second deadline before readiness; resume held QEMU with QMP `cont`, clear the asleep mark only for that shutdown-only resume, call `qga.waitFor(p.qga, remainingMs)` (not full-logon `untilReady`), request guest shutdown, and poll QEMU until that same deadline. On any failure after teardown begins, first restore Finder integration while the guest is still resumed, then use QMP `stop` and restore the asleep mark against the same still-live QEMU PID when applicable; finally call `ensureWatcher(name)` only if a watcher existed before. Never invoke `kill`.

- [ ] **Step 4: Verify Task 3 GREEN**

Run:

```bash
bun test packages/core/tests/frozen.test.ts packages/core/tests/qga.test.ts packages/core/tests/watch.test.ts
bun --filter @winvm/core test
bun --filter @winvm/core typecheck
```

Expected: all core tests and typecheck pass.

### Task 4: Rust-owned close/exit coordinator

**Files:**
- Create: `apps/viewer/src-tauri/src/close.rs`
- Modify: `apps/viewer/src-tauri/src/lib.rs:1-23,285-342,344-404,435-540`

**Interfaces:**
- Produces `CloseCoordinator` with states `Idle`, `Requested`, `Running`, and `Authorized`; `Authorized` permits every callback in the one terminating `app.exit`/restart sequence and is never consumed by the first window event.
- Produces commands `close_start`, `close_cancel`, and `close_complete`.
- Emits targeted `viewer-close-requested` to the main window exactly once per transaction.
- Consumes frontend backend bindings added in Task 6.

- [ ] **Step 1: Write failing pure Rust coordinator tests**

In `close.rs`, specify tests for first request emission, duplicate request coalescing, acknowledgement, cancellation to Idle, completion to Authorized for the full terminating sequence, unapproved exit prevention, and updater authorization bypass.

- [ ] **Step 2: Run Rust tests and verify RED**

Run: `mise -C apps/viewer exec -- cargo test --manifest-path src-tauri/Cargo.toml close`

Expected: FAIL because the close module/state machine does not exist.

- [ ] **Step 3: Implement the pure coordinator**

Keep synchronization inside `CloseCoordinator(Mutex<CloseState>)`. Invalid/out-of-order frontend acknowledgements return errors; repeated native requests are harmless and do not emit again.

- [ ] **Step 4: Route every native close path through it**

Register coordinator state and commands. Intercept main `WindowEvent::CloseRequested` with `prevent_close()` unless authorized. Replace the predefined app-menu Quit item with custom `quit`/Cmd-Q and route it plus main File > Close to the same request helper; auxiliary Close retains its local meaning. Handle `RunEvent::ExitRequested` as a prevention backstop. `close_complete` authorizes then calls `app.exit(0)`.

Before updater `app.restart()`, set the updater authorization bypass so updating never opens the close flow or changes VMs.

- [ ] **Step 5: Add Rust routing assertions**

Extract and test small pure routing helpers for main-vs-aux Close and custom Quit IDs. Assert updater authorization makes the next exit allowed while ordinary unapproved `ExitRequested` is prevented.

- [ ] **Step 6: Verify Task 4 GREEN**

Run:

```bash
mise -C apps/viewer exec -- cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
mise -C apps/viewer exec -- cargo test --manifest-path src-tauri/Cargo.toml
mise -C apps/viewer exec -- cargo check --manifest-path src-tauri/Cargo.toml
```

Expected: formatting, Rust tests, and check pass.

### Task 5: Unified viewer operation state and display treatment

**Files:**
- Create: `apps/viewer/ui/src/features/operation/OperationOverlay.tsx`
- Create: `apps/viewer/tests/operation-ui.test.tsx`
- Modify: `apps/viewer/ui/src/features/winvm/statusGuard.ts:19-34`
- Modify: `apps/viewer/ui/src/features/winvm/useWinvm.ts:1-288`
- Modify: `apps/viewer/tests/pause-ui.test.tsx`
- Modify: `apps/viewer/ui/src/App.tsx:445-647`
- Modify: `apps/viewer/ui/src/styles/styles.css:318-437,1504-1545`
- Modify: `apps/viewer/ui/src/i18n/en.json`
- Modify: `apps/viewer/tests/i18n.test.ts`

**Interfaces:**
- Produces viewer `ActiveOperation = { operation: VmOperation; source: "local" | "external" }` and `Winvm.operation: ActiveOperation | null` for the selected machine.
- Produces `runOn(name: string, verb: Verb, arg?: string): Promise<Ran | null>`, while existing `act()` delegates to the selected machine.
- Produces `refreshAll(): Promise<readonly Status[] | null>` and `refreshOne(name: string): Promise<Status | null>` for close flow.
- `OperationOverlay` consumes an operation and renders one polite `role="status"` full-display blocker. Its exact mapping is: start → `Starting Windows`; stop → `Shutting Down`; reboot → `Restarting Windows`; kill → `Turning Off Windows`; reset → `Resetting Windows`; snapshot/save/golden-create → `Saving Windows`; rewind/load/golden-reset → `Loading Windows`; pause → `Pausing Windows`; resume → `Resuming Windows`; sleep → `Suspending Windows`; wake → `Waking Windows`; lock → `Locking Windows`; stow → `Stowing Windows`; setup → `Installing Windows`.

- [ ] **Step 1: Write failing hook tests for external operations**

Extend the fake status bridge to return `operation`. Assert an external `stow` appears as `source: "external"`, starts 1.5-second polling, clears after a later `operation: null`, and cannot override a local operation currently run by this viewer. Assert `runOn("other", "stop")` targets that explicit instance independent of the selected-state closure.

- [ ] **Step 2: Run the hook tests and verify RED**

Run: `bun test apps/viewer/tests/pause-ui.test.tsx --test-name-pattern "operation"`

Expected: FAIL because `Winvm.operation`, explicit-instance actions, and remote fast polling do not exist.

- [ ] **Step 3: Implement combined operation state**

Track local operation with its target machine, extend `Verb` with close-owned `stow`, and map viewer verbs into the shared `VmOperation` domain. For the selected machine, local state takes precedence; otherwise use `status.operation`. Treat either source as busy for controls, guest readiness, terminal, screen input, keyboard capture, drag/drop, and fast polling. Preserve existing status-ticket barriers.

- [ ] **Step 4: Write failing overlay tests**

Render `OperationOverlay` and an App-level fixture. Assert exact messages from Global Constraints, `role="status"` with polite live semantics, pointer/input blocking over both Screen and Overview branches, and removal when operation clears. Assert paused/asleep overlay behavior remains unchanged when no operation exists.

- [ ] **Step 5: Run overlay tests and verify RED**

Run: `bun test apps/viewer/tests/operation-ui.test.tsx`

Expected: FAIL because the overlay and copy do not exist.

- [ ] **Step 6: Implement the overlay and interaction blocking**

Place the overlay as the final child of `.display`, after Screen/Overview, so stow/stop transitions cannot uncover interaction. Reuse `var(--scrim-paused)`, existing display typography, and reduced-motion conventions; unlike `.screen__held`, make the active overlay receive/block pointer events. Release system keyboard capture when an operation begins.

- [ ] **Step 7: Verify Task 5 GREEN**

Run:

```bash
bun test apps/viewer/tests/pause-ui.test.tsx apps/viewer/tests/operation-ui.test.tsx apps/viewer/tests/i18n.test.ts
bun --filter @winvm/viewer test
bun --filter @winvm/viewer typecheck
```

Expected: all viewer tests and typecheck pass.

### Task 6: React all-machine close queue and dedicated dialog

**Files:**
- Create: `apps/viewer/ui/src/features/close/closeQueue.ts`
- Create: `apps/viewer/ui/src/features/close/useCloseFlow.ts`
- Create: `apps/viewer/ui/src/features/close/ClosePolicyDialog.tsx`
- Create: `apps/viewer/tests/close-flow.test.tsx`
- Create: `apps/viewer/tests/close-dialog.test.tsx`
- Modify: `apps/viewer/ui/src/backend.ts:136-168,225-249`
- Modify: `apps/viewer/ui/src/App.tsx`
- Modify: `apps/viewer/ui/src/i18n/en.json`
- Modify: `apps/viewer/ui/src/styles/styles.css`

**Interfaces:**
- Backend produces `onViewerCloseRequested(cb: () => void): Unlisten`, `closeStart(): Promise<void>`, `closeCancel(): Promise<void>`, and `closeComplete(): Promise<void>`.
- `orderCloseQueue(statuses: readonly Status[], selected: string | null, resolved: ReadonlySet<string>): string[]` returns selected-live first then stable list order, excluding stopped/stowed/missing/resolved machines.
- `CloseFlowState` is exactly `idle`; `waiting` with machine status, active operation, index, and total; `asking` with machine status, index, total, and `remember`; `acting` with machine status, `stow | shutdown` policy, index, and total; or `failed` with machine status and message.
- `useCloseFlow(w: Winvm)` returns `{ state, setRemember(value: boolean), choose(policy: "leave" | "stow" | "shutdown"), cancel() }`.
- `ClosePolicyDialog` consumes `asking` or unrelated-operation `waiting` state: asking emits a policy or Cancel and controls `remember`, while waiting presents the active operation and a Cancel action that cancels only the close transaction.

- [ ] **Step 1: Write failing pure queue tests**

Assert selected live first; other live machines retain status-list order; `phase(status)` classifies a `running`/silent-agent status as starting and all running/starting/paused/asleep machines as live; stopped/stowed/missing are skipped; resolved names are excluded; and a newly live unresolved machine is returned by a later recheck.

- [ ] **Step 2: Write failing close-flow tests**

With fake fresh status reads, explicit-instance actions, config writes, and Rust bridge calls, assert:

- native request is acknowledged once and repeated requests do not start a second flow;
- `ask` presents selected machine first with progress, Remember false, then iterates all remaining live machines;
- remembered `leave`, `stow`, and `shutdown` execute without a dialog;
- Leave resolves immediately; stow maps to `stow`; shutdown maps to `stop`;
- a starting (`state: "running"`, silent-agent) machine can be left, stowed, or shut down through the same choices;
- deferred stow/stop promises remain in `acting` with no viewer timeout, do not advance the queue, and do not authorize exit until they settle;
- Remember persists `viewer.closePolicy=<choice>` only after success, never after cancel/failure;
- cancel aborts the whole flow but does not undo already resolved machines;
- an operation already owned elsewhere yields a cancellable waiting state and is never cancelled by this flow;
- once close starts stow/stop, cancel is disabled until it returns;
- action or config failure selects the affected machine, exposes the existing actionable output, calls native cancel, and leaves the viewer open;
- final all-instance refresh repeats while it discovers newly live unresolved machines, then completes exactly once.

- [ ] **Step 3: Run close-flow tests and verify RED**

Run: `bun test apps/viewer/tests/close-flow.test.tsx`

Expected: FAIL because the queue/hook/backend close APIs do not exist.

- [ ] **Step 4: Implement queue orchestration**

On native request, call `closeStart`, fetch authoritative all-instance status, and drive one machine at a time. Select before refreshing each machine. For external/local operations, poll via fresh status until clear while keeping Cancel available only for operations the close flow did not start. At convergence, repeatedly fetch all status and append newly live unresolved names; call `closeComplete` only when none remain.

Use `w.runOn` so selection timing cannot target the previous machine. Feed close-triggered stow/stop through the same local operation state from Task 5; do not introduce a second busy overlay.

- [ ] **Step 5: Write failing dedicated-dialog tests**

Assert title `What should happen to Windows?`, display title, `Machine N of M`, three action descriptions, Cancel, unchecked Remember on every new ask, initial Cancel focus, and Escape/backdrop cancellation. Also assert waiting on an unrelated operation shows its operation message with an enabled, initially focused Cancel button; the close-owned `acting` state dismisses the dialog and cannot be cancelled until the mutation settles.

- [ ] **Step 6: Run dialog tests and verify RED**

Run: `bun test apps/viewer/tests/close-dialog.test.tsx`

Expected: FAIL because `ClosePolicyDialog` does not exist.

- [ ] **Step 7: Implement and integrate the dialog**

Model it on `ConfirmDialog` but keep a dedicated API for three policies plus Cancel and checkbox. Mount the close-flow hook and dialog once in `App`; do not add independent close booleans. Keep Cancel initial focus and native `<dialog>` focus trapping.

- [ ] **Step 8: Verify Task 6 GREEN**

Run:

```bash
bun test apps/viewer/tests/close-flow.test.tsx apps/viewer/tests/close-dialog.test.tsx apps/viewer/tests/operation-ui.test.tsx
bun --filter @winvm/viewer test
bun --filter @winvm/viewer typecheck
```

Expected: all viewer tests and typecheck pass.

### Task 7: Discoverable per-machine close-policy setting

**Files:**
- Modify: `apps/viewer/ui/src/features/panel/Panel.tsx:20-138`
- Modify: `apps/viewer/ui/src/features/winvm/useWinvm.ts`
- Modify: `apps/viewer/ui/src/App.tsx:631-646`
- Modify: `apps/viewer/ui/src/i18n/en.json`
- Create: `apps/viewer/tests/close-policy-setting.test.tsx`
- Modify: `apps/viewer/tests/i18n.test.ts`

**Interfaces:**
- Adds `Winvm.setClosePolicy(policy: ClosePolicy): Promise<string | null>` for the selected stable instance name.
- Adds Panel props `closePolicy`, `closePolicyBusy`, and `onClosePolicy(policy)`.

- [ ] **Step 1: Write failing panel setting tests**

Render the Details panel and assert `When closing WinVM` offers `Ask every time`, `Leave running`, `Stow Windows`, and `Shut down Windows`; the current effective policy is selected; changing it issues `winvm config -i <stable-name> viewer.closePolicy=<value>`; failure keeps the old value and shows actionable output.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `bun test apps/viewer/tests/close-policy-setting.test.tsx`

Expected: FAIL because the setting and mutation API do not exist.

- [ ] **Step 3: Implement the setting**

Place it in Details as an ordinary labelled `<select>`, disabled while any operation is active. On success refresh the selected status so dialog behavior and setting share the CLI’s validated effective value; key persistence by `status.name`, never display title.

- [ ] **Step 4: Verify Task 7 GREEN**

Run:

```bash
bun test apps/viewer/tests/close-policy-setting.test.tsx apps/viewer/tests/i18n.test.ts
bun --filter @winvm/viewer test
bun --filter @winvm/viewer typecheck
```

Expected: all viewer tests and typecheck pass.

### Task 8: Whole-system verification and safe packaged acceptance

**Files:**
- Modify only if a failing verification first demonstrates a defect in the feature files above.

**Interfaces:**
- Consumes every interface from Tasks 1–7.
- Produces a packaged development app ready for user-directed acceptance; no repository integration action.

- [ ] **Step 1: Inspect the final working tree without altering it**

Run: `git status --short && git diff --stat`

Expected: pre-existing lifecycle-review changes remain present alongside this feature; no unexpected generated, deleted, or reverted files.

- [ ] **Step 2: Run the complete TypeScript/Bun verification**

Run:

```bash
bun check
bun run build
```

Expected: all workspace tests/typechecks and builds pass. If any failure appears, add a focused failing regression test before changing production code.

- [ ] **Step 3: Run complete Rust verification**

Run:

```bash
mise -C apps/viewer exec -- cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
mise -C apps/viewer exec -- cargo test --manifest-path src-tauri/Cargo.toml
mise -C apps/viewer exec -- cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
```

Expected: format, tests, and clippy pass.

- [ ] **Step 4: Build the packaged development app**

Run: `bun --filter @winvm/viewer app`

Expected: the `.app` bundle and bundled CLI sidecar build successfully from the current tree. Do not launch a duplicate while the earlier tracked viewer process is still running; stop that tracked process before relaunching.

- [ ] **Step 5: Perform safe manual acceptance**

Using the packaged app and an already-authorized development VM only:

1. Record its QEMU PID.
2. Trigger main-window Close and verify the selected live machine appears first.
3. Choose `Leave Running` with Remember unchecked.
4. Resolve any other live machines with `Leave Running` only.
5. Verify the app exits only after the queue is complete.
6. Verify the recorded QEMU PID, control service, watcher, and swtpm remain alive; if app-owned computer-use sharing was started for the session, verify that child stops on viewer exit.
7. Relaunch and verify `ask` appears again because Remember was unchecked.
8. Confirm an external harmless operation such as pause/resume only if explicitly safe for the development VM; otherwise rely on automated operation-overlay tests.

Do not exercise real stow or shutdown without explicit authorization.

- [ ] **Step 6: Report verification faithfully**

List exact commands, passing counts, packaged app path, safe acceptance evidence, anything skipped, and all remaining uncommitted files. Do not commit, push, merge, open a PR, or offer to discard the work.
