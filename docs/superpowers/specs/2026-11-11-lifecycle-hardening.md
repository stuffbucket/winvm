# WinVM lifecycle hardening

Date: 2026-11-11. Status: approved implementation scope.

## Why

The viewer, per-instance control service, watcher, and QEMU are intentionally
detached so closing the viewer does not stop Windows. That separation also
allows an application rebuild or release update to leave the service and
watcher executing an older WinVM generation. Comparing only the CLI path does
not detect this in an installed app because every release uses the same path.
A viewer whose bundled CLI is missing or wedged currently exposes only the raw
host error, such as `No such file or directory (os error 2)`, and can wait
without a viewer-owned deadline.

## Goals

- Give every source, development-app, and packaged-release CLI a stable identity
  for that exact build generation.
- Record that identity in detached service and watcher metadata.
- Reuse same-build management processes across CLI paths, treat legacy metadata
  with no identity as stale, and avoid automatically seizing a live generation
  owned by another installation.
- Rotate stale watcher and service generations safely while leaving QEMU and
  Windows running.
- Defer automatic read/status repair while a watcher autosave or stow is active;
  explicit management retains the existing bounded wait and forced-termination
  fallback.
- Make a failed replacement recoverable: QEMU remains alive, stale metadata is
  not mistaken for a healthy current process, and a later valid CLI can retry.
- Reconcile management processes on a normal current-CLI path so an app update
  repairs stale generations without requiring the VM to stop.
- Put bounded deadlines around viewer read, status, terminal/connect, agent-connect,
  and share-handshake sidecar invocations without imposing a short deadline on
  long-running mutations.
- Classify missing, launch-failed, timed-out, and nonzero-exit sidecar failures
  and show operation-specific, actionable viewer copy.
- Prove generation reuse/replacement, legacy metadata handling, active-save
  behavior, failed replacement, missing-sidecar classification, timeout, and
  QEMU preservation with focused automated tests.
- Validate the finished behavior against the currently running `demo` VM while
  preserving its QEMU process.

## Non-goals

- Stopping or restarting QEMU as part of service or watcher repair.
- Combining the watcher into the control service.
- Redesigning checkpoint cards or other unrelated viewer UI.
- Guaranteeing recovery from an operating-system or hypervisor process that
  cannot complete `SIGKILL`; logout or reboot remains the last resort for that
  kernel-level case.
- Keeping a second independently installed recovery CLI.

## Decisions

### Build identity

A generated build identity is embedded in the compiled sidecar and is also
available when running from source. It must change whenever the executable
content can change, even if its path and package version do not. It must not be
computed from the mutable executable path at service-reuse time.

The same identity value is propagated to detached children and written to both
service and watcher metadata. Metadata without the identity is a legacy
record and is never eligible for reuse.

### Safe reconciliation

Reconciliation is serialized per instance with a pid-and-process-start-validated
lock. A same-build service or watcher is reusable even when its recorded CLI path
differs. A missing identity is legacy and rotates. A different build at the same
CLI path is an in-place update and rotates. A live different build at another CLI
path is foreign; automatic reconciliation leaves that generation untouched so
source and installed CLIs cannot repeatedly replace one another.

When replacement requires watcher quiescence, reconciliation preserves watcher
intent as durable debt bound to the current QEMU pid, stops only validated
management processes, starts and verifies the current service, then restores the
watcher when watching remains enabled. If the service is merely missing, a
current watcher stays running while service startup is retried. Failed or
interrupted repair retains enough debt for a later invocation to converge.

A live manual save defers repair. Automatic read/status reconciliation also
defers immediately when a watcher is `autosaving` or `stowing`, without sending
it a signal. Explicit start/management may use the existing save-aware graceful
path and bounded forced fallback.

QEMU is never signalled by reconciliation. Replacement failure returns a typed,
retryable management error and leaves QEMU running so a later invocation can
retry. Reconciliation must not recurse inside detached service, watcher, or
watcher-spawned save/stow entry points.

### Viewer sidecar failures

The Tauri command returns a structured serializable error with a stable kind,
the requested WinVM operation, and actionable text. At minimum the stable kinds
are `missing`, `launch`, `timeout`, and `exit`. Raw host details may be retained
for diagnostics but are not the only user-facing explanation.

Viewer read/status calls, terminal and agent connection calls, and the share
token handshake have operation-specific bounded timeouts. Long mutations such as
start, stop, save, load, and file transfer do not inherit a short automatic
deadline. Timeout handling terminates only the spawned sidecar process and
reports that management is temporarily unavailable; it does not stop QEMU or
the detached service/watcher.

The React status and terminal surfaces preserve the structured classification
and present recovery guidance appropriate to the operation instead of reducing
all failures to an opaque `Error.message`.

## Safety invariants

- Closing or restarting the viewer does not stop QEMU.
- Replacing a service or watcher does not stop QEMU.
- PID metadata is validated before signalling a process; stale records must not
  be allowed to target an unrelated reused PID.
- Automatic read/status repair does not signal a watcher in `autosaving` or
  `stowing`; explicit management retains the existing long graceful deadline
  before forced termination.
- Tests never signal real user processes or use the real `WINVM_HOME`.
- Existing uncommitted checkpoint-copy changes remain untouched.

## Acceptance

- Focused lifecycle and viewer tests pass after each red/green cycle.
- `pnpm check` passes on the integrated tree.
- The development app builds with the embedded identity and structured error
  contract.
- Live reconciliation replaces the stale `demo` service and watcher with the
  current generation while the QEMU PID remains unchanged and guest status is
  healthy.

Acceptance completed on 2026-11-11: legacy service pid `10522` and watcher pid
`12584` were replaced by packaged-build pids `89800` and `89802`; QEMU pid
`10528` and swtpm pid `10519` retained their original 2026-10-28 start times.
A second status reused both management pids, direct QGA ping succeeded before
and after repair, and guest `hostname` returned `WINVM`.
