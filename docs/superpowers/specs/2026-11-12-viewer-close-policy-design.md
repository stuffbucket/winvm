# WinVM viewer close policy

Date: 2026-11-12. Status: approved design; builder-reviewed.

## Why

The WinVM viewer, QEMU, control service, and idle watcher are intentionally
separate processes. Closing the viewer currently destroys the window and exits
the app without asking what should happen to Windows. QEMU and its management
processes remain in the background; a watcher may stow the machine later, but a
machine without an active stow policy can remain running indefinitely.

That behavior protects Windows from accidental termination, but the window gives
no explanation of what closing means and no deliberate choice. The main viewer
also represents every configured machine. Closing it removes the only management
window for all machines, not just the machine currently shown.

## Goals

- Make every ordinary viewer close explicit about what happens to each running
  Windows machine.
- Treat the traffic-light close button, Cmd-W on the main window, and app Quit as
  the same all-machine close transaction.
- Process the currently shown machine first, then every other running machine.
- Offer `Leave Running`, `Stow Windows`, `Shut Down`, and `Cancel` when a machine
  has no remembered choice.
- Offer an unchecked `Remember for this Windows machine` checkbox and persist a
  successful remembered choice per stable instance profile.
- Wait for stow or graceful shutdown to finish before advancing or exiting.
- Keep the viewer open, selected on the affected machine, if an operation fails.
- Remain safe under repeated close requests, concurrent CLI activity, auxiliary
  viewer windows, update restarts, crashes, and force quit.
- Reuse the viewer-wide VM-operation treatment for close-triggered stow and
  shutdown so the machine cannot be interacted with while it changes state.

## Non-goals

- Force-killing Windows when graceful shutdown fails.
- Guaranteeing a dialog or completed operation after Force Quit, SIGKILL, a
  process crash, macOS logout, or host power loss.
- Storing close preferences in a save, internal snapshot, save note, hardware
  profile, display profile, or provisioning metadata.
- Applying one machine's remembered preference to another machine.
- Changing idle autosave or idle-stow policy.
- Closing only the selected machine while silently leaving other running
  machines unreviewed.

## Existing behavior

The main Tauri window has no `CloseRequested` handler. File > Close calls the
window's ordinary close path, and the stock macOS Quit item terminates the app.
The final run callback releases keyboard capture and stops only the app-owned
sharing child. It does not invoke `winvm stop`, `winvm stow`, or `winvm kill`.

QEMU, swtpm, the control service, and the watcher are detached and deliberately
outlive the viewer. This remains the crash-safe fallback: if the close
transaction cannot run, Windows is left alive rather than being terminated.

## Product behavior

### One close transaction

The following actions start the same transaction:

- clicking the main window's red close control;
- Cmd-W or File > Close while the main window is the target;
- Cmd-Q or the app-menu Quit item;
- an otherwise unapproved last-window/application exit request.

The Rust host synchronously prevents the close or exit before any window is
destroyed. The main window remains visible and usable by the coordinator until
the transaction either completes or is cancelled. Repeated close requests while
one transaction is pending are coalesced; they do not create duplicate dialogs
or duplicate VM operations.

Update installation/restart is an explicit bypass: it preserves the current
release behavior and leaves all VMs running. A crash, Force Quit, or process
kill also leaves detached VMs running.

### Machine queue

At transaction start, the viewer obtains a fresh authoritative all-instance
status response. It builds a queue containing machines in a live state:
`running`, `starting`, `paused`, or `asleep`. `stopped`, `stowed`, and `missing`
machines are skipped.

The selected machine is first when it is live. Remaining live machines follow
in the stable machine-list order. Before handling each queue entry, the viewer
selects it and refreshes its status. If it became stopped or stowed while
waiting, it is skipped. A newly started machine discovered after the initial
queue was built is not silently ignored: before final exit the viewer refreshes
the list once, appends live machines not yet resolved, and continues. This final
recheck repeats only when it finds a new unresolved machine, so the transaction
converges without a fixed retry count.

For each machine:

1. Read its effective per-instance close policy from the fresh status.
2. If the policy is `ask`, show the close dialog.
3. If the policy is remembered, apply it without a dialog.
4. Wait for any requested stow or shutdown to finish successfully.
5. Advance to the next unresolved live machine.

A machine whose QEMU is up but whose guest is still `starting` keeps the same
choices. `Leave Running` resolves it immediately. Stow may capture the in-progress
boot. Shutdown waits within `stop`'s existing deadline for the guest agent to
become responsive, then requests normal shutdown; failure leaves the close
transaction open rather than changing the available choices.

`Leave Running` resolves the machine immediately and advances. After every live
machine is resolved, the Rust coordinator authorizes app exit and closes the
viewer and all auxiliary windows together.

### Close dialog

The dedicated modal is titled `What should happen to Windows?` and identifies
the machine by its display title. When more than one live machine remains it
also gives quiet progress context, such as `Machine 1 of 3`.

It offers four actions:

- **Leave Running** — close WinVM while this Windows machine continues in the
  background; its existing watcher policy continues to apply.
- **Stow Windows** — save the machine's resumable state, stop QEMU, then continue
  closing.
- **Shut Down** — ask Windows to shut down normally, wait for QEMU to exit, then
  continue closing.
- **Cancel** — cancel the entire all-machine close transaction and keep WinVM
  open on this machine.

The dialog includes `Remember for this Windows machine`. It is unchecked every
time an `ask` dialog opens, including after a cancelled attempt. Initial focus
lands on Cancel. Escape and backdrop dismissal are equivalent to Cancel.

While stow or shutdown runs, choices, dismissal, window close, and repeated Quit
are disabled/coalesced. The normal viewer-wide operation treatment explains the
active operation (`Stowing Windows` or `Shutting Down`) and blocks guest input.

### Remembered choices

The effective policy is a per-instance enum:

```text
viewer.closePolicy = ask | leave | stow | shutdown
```

`ask` is the default and is stored as no override. The stable instance name—not
the mutable display title—is the profile key. Destroying an instance removes
its close policy with the rest of the instance directory, so recreating a
machine with the same name does not inherit stale intent.

When `Remember` is checked, the selected policy is written only after that
choice succeeds. `Leave Running` succeeds immediately. Stow and shutdown must
return success before persistence. A failed operation therefore cannot install
a policy that automatically fails every future close.

The Details panel exposes `When closing WinVM` for the selected machine with
`Ask every time`, `Leave running`, `Stow Windows`, and `Shut down Windows`. This
is the discoverable way to inspect, change, or reset a remembered choice.
Changing it writes the same validated per-instance config key.

Close policy is not save or snapshot metadata. A save describes a captured
moment, and the reserved stow save is one-shot and consumed on the next start.
Future viewer-close intent belongs to the machine profile.

### Operation outcomes

#### Leave running

No VM command runs. QEMU, its control service, watcher, swtpm, and VM-owned file
sharing continue according to their existing lifecycle rules. The app-owned
computer-use sharing child still stops when the viewer exits, as it does today;
leaving Windows running does not transfer ownership of that viewer session.

#### Stow Windows

The viewer invokes the existing unbounded `winvm stow -i <instance>` operation
and waits for its exit. Stow stops the watcher, saves the machine, and quits
QEMU. It may legitimately take many minutes and must not inherit a short viewer
sidecar deadline.

A successful stow advances the queue. A nonzero exit, launch failure, or other
failure keeps the app open on that machine, preserves the CLI output in an
error treatment, and ends the close transaction. It never falls back to
`Leave Running` or force-kills QEMU.

#### Shut down Windows

The viewer invokes graceful `winvm stop -i <instance>` without imposing a
viewer-side deadline and waits for it. The core command retains its own existing
180-second shutdown deadline. If the guest is still `starting`, that deadline
also bounds waiting for its agent to become responsive before shutdown is
requested.

If the VM is intentionally paused or asleep, shutdown first needs the guest able
to answer; the core shutdown path must safely resume it before requesting guest
shutdown, rather than leaving this as a fragile UI-only sequence. The machine
may therefore briefly run while shutting down.

A successful shutdown advances the queue. On timeout or failure, the core path
restarts the watcher when it had been active and restores the original paused or
asleep state after any shutdown-only resume. The app remains open and reports
the existing recovery guidance. The close transaction never silently substitutes
`winvm kill`.

#### Concurrent operation

A close request does not interrupt a viewer-originated or external CLI operation.
The close coordinator keeps the app open, shows the operation treatment, and
waits for the operation to clear before refreshing status and resolving that
machine. While waiting on an operation the close flow did not start, Cancel
remains available and aborts only the close transaction; it does not cancel the
other operation. Once the close flow itself starts stow or shutdown, cancellation
is disabled until that mutation returns. Save/load/stow serialization and PID
ownership remain authoritative; frontend state is presentation, not a second
lock.

If the concurrent operation fails, its normal error remains visible and the
close transaction is cancelled. If it changes the machine to stopped or stowed,
the refreshed queue skips that machine.

## Architecture

### Rust close coordinator

A single Rust-owned coordinator is managed by Tauri and has explicit states:

- `Idle` — no close transaction;
- `Requested` — close/exit prevented and a frontend request emitted;
- `Running` — the frontend acknowledged and is resolving machines;
- `Authorized` — one-shot permission for the app to exit.

The coordinator is idempotent and coalesces repeated requests. The main
window's `WindowEvent::CloseRequested` calls `prevent_close()` unless state is
`Authorized`, then emits a targeted close request. A custom app-menu Quit item
replaces the predefined macOS Quit item and enters the same coordinator before
AppKit termination. `RunEvent::ExitRequested` prevents any otherwise
unapproved exit as a backstop.

Frontend commands acknowledge/start the transaction, cancel it, and complete
it. Completion transitions to `Authorized` and exits the application, closing
all main, Terminal, and Files windows. Cancellation returns to `Idle`. A later
close request starts from a fresh machine/status list.

Updater restart sets the one-shot authorized bypass before relaunching, so an
update never unexpectedly stows or shuts down machines.

### Core profile and status

`InstanceConfig` gains the validated enum key `viewer.closePolicy`; string enum
validation is separate from title validation. Unknown or mistyped on-disk values
are ignored, producing the default `ask`. CLI assignment accepts exactly the
four values and gives an actionable error otherwise. Atomic override-only writes
remain unchanged.

`InstanceStatus` includes the effective close policy so both single-instance and
all-instance JSON status provide it. The viewer parser defaults an absent field
to `ask` for compatibility with an older CLI.

### React close flow

A focused close-flow hook owns the queue and dialog state rather than adding
more booleans to `App`. It listens for the Rust close request, obtains fresh
all-instance status, orders the queue, selects each machine, and invokes the
existing VM action layer. The flow exposes one discriminated state to a
dedicated close dialog and calls Rust cancel/complete commands.

The operation-screen feature is the single presentation for both ordinary CLI
operations and close-triggered stow/shutdown. The close flow does not create a
second busy overlay.

## Failure and recovery rules

- Any stow/shutdown failure aborts close and leaves the viewer open on the
  failing machine.
- Cancel aborts the entire close transaction; already completed choices remain
  completed. A machine already stowed or shut down is not restarted.
- A remembered policy is not cleared or changed merely because its automatic
  operation failed. The visible error and Details setting let the user retry or
  choose another policy deliberately.
- The queue is rebuilt from current status on the next close attempt.
- A missing or unlaunchable bundled CLI prevents close-policy VM mutations and
  leaves the app open with the existing actionable sidecar error.
- No close path signals QEMU directly. Only existing validated `stow`/`stop`
  lifecycle code may change VM state.
- Auxiliary windows do not independently start VM close transactions. Closing a
  Terminal/Files window keeps its current local meaning. Main-window close or
  app Quit is the all-machine transaction and exits every viewer window only
  after success.

## Accessibility and interaction

- The close dialog is a native modal dialog with focus trapping.
- Cancel receives initial focus.
- Each action has explanatory copy; color is not the only distinction.
- Busy state is announced politely and controls cannot be activated twice.
- Reduced-motion preferences apply to the existing operation treatment.
- Machine title and queue position are announced when advancing.

## Testing and acceptance

Automated coverage must include:

- enum parsing, invalid values, default/override persistence, and status exposure;
- compatibility with status JSON from an older CLI lacking the field;
- Rust coordinator transitions, duplicate close coalescing, cancellation,
  authorization, custom Quit routing, exit backstop, and updater bypass;
- selected-machine-first ordering, skipped non-live machines, remembered-policy
  execution, `ask` dialogs, final discovery of newly live machines, and queue
  completion;
- unchecked Remember state on every ask, persistence only after success, and no
  persistence after cancellation/failure;
- stow/shutdown success, failure, and long-running busy behavior;
- a `starting` machine left running, stowed, or shut down after bounded agent
  readiness;
- close during another local or external operation, including cancellation while
  waiting without cancelling that operation;
- shutdown of paused/asleep machines through a tested core resume-then-shutdown
  path, with watcher and held-state restoration on failure;
- `Leave Running` preserving VM-owned services while app-owned computer-use
  sharing stops at viewer exit;
- close transaction cancellation leaving the viewer and unresolved VMs intact;
- completion exiting all viewer windows only after every live machine resolves.

The packaged development app must be rebuilt before manual acceptance. Manual
acceptance may prove the all-machine dialog and `Leave Running` path against a
real VM while verifying that its QEMU PID survives. Stow or shutdown of a real
user VM requires explicit authorization; tests should otherwise use isolated
temporary profiles and fake processes.

## Safety invariants

- No VM is force-killed because the viewer is closing.
- No app exit occurs while a requested stow or shutdown is still running.
- No remembered preference is written before its selected action succeeds.
- Closing the main viewer cannot silently omit another live configured machine.
- Repeated close/Quit requests cannot run duplicate operations.
- PID and command ownership checks remain in the existing lifecycle layer.
- Crashes and forced termination leave detached VMs running.
