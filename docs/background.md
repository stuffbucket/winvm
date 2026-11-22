# Background processes

A running instance has two helper processes besides QEMU: the keeper and the
control service, which also runs the idle watcher.

## The keeper

`winvm start`, and anything else that launches QEMU, runs QEMU through the
instance's keeper: `winvm-keeper`, a small launchd job in your account's
background session, labelled `co.stuffbucket.winvm.keeper.<hash>.<name>`. The
keeper starts QEMU, its TPM emulator (`swtpm`) and the shared folder's daemon
(`virtiofsd`) as its own children, waits on them, and writes each start and
exit to `events.jsonl` as a `keeper` line. It exits 10 seconds after QEMU does.
Its files are in `instances/<name>/keeper/`, and it logs to `keeper.log` there.
The children get the umask of the command that started them, and of its
environment only `HOME`, `USER`, `LOGNAME`, `PATH`, `SHELL`, `TMPDIR`, `LANG`,
`LC_*` and `WINVM_*`.

These children ignore SIGTERM, SIGHUP and SIGINT, so a stray SIGTERM can't
end Windows abruptly. Activity Monitor's Quit does nothing to a kept QEMU;
Force Quit does. `winvm kill` is the supported hard stop, and it asks the
keeper to do it.

The keeper also runs the control service (below) as its child, so the
service is still there when the Mac shuts down. The service is not shielded,
but while the keeper is its parent it records a SIGTERM, SIGHUP or SIGINT in
`events.jsonl` and carries on; the keeper stops it with SIGUSR2. The keeper
restarts a service that crashes while QEMU runs, waiting 1, 2, 4 and up to 30
seconds between tries.

When the keeper itself is told to stop, because the Mac is shutting down or
restarting, because launchd ends your background session at logout, or
because someone ran `launchctl bootout` on it, it hands the moment to the
service (`POST /host-ending`, with a deadline). launchd allows the keeper 60
seconds, and the service has until 47 seconds after the stop began:

- An idle Windows is stowed: the guest's drives are first unmounted from
  Finder while Windows still runs (at most 3 seconds for all of them, after
  which a hung unmount is abandoned), then its memory is saved as the `stow`
  save, the save is written in full, and only then does QEMU quit.
  `winvm start` recalls it later. Nothing starts by itself at the next login.
- An autosave in progress is cancelled first. A stow you started is waited
  for; a save you started is waited for until 15 seconds before the deadline,
  then cancelled.
- A guest started with `--ephemeral`, or one running an installer, is quit.
- When the instance's `hostEnd.action` is `shutdown`
  (`winvm config -i NAME hostEnd.action=shutdown`), when its image predates
  virtio boot, when the disk has less room than the memory QEMU uses plus
  1 GiB, when this winvm could not recall a stow of the QEMU that runs it
  (the VM was started before an update that changed QEMU), or when the stow
  fails, the service hands the moment back to the keeper, which shuts
  Windows down instead. winvm never writes a stow that the next `start`
  would refuse or boot past: `winvm stow`, the idle watcher's stow and the
  app's close-window stow refuse it too, and Windows keeps running.
  `winvm stow` then exits 4 and says to shut Windows down and start it
  again, before it turns the watcher off or takes the Finder drives down;
  the watcher stops trying idle stows until QEMU restarts, and
  `winvm status` says so; the app's close stays open with the same words.
  When QEMU does not say which version it runs, `winvm stow` exits 5
  instead, and the watcher tries again later. A stow that fails once it has
  begun turns the watcher it turned off back on while Windows still runs.

The keeper never lets two of them act on Windows at once. If the service
refuses the moment, or can't be reached, or never answered and has died, the
keeper takes over through a QMP monitor of its own (`keeper/qmp.sock`): it
lets a save that is still running go on until 43 seconds, then cancels it;
presses the power button; quits QEMU at 50 seconds if Windows hasn't shut
down; and kills it at 53. A guest that is stopped mid-save or mid-load can't
act on the power button, so the keeper quits it at once. Once the service may
be stowing (it answered, or the answer was lost), the keeper only waits: if
the service dies, or is still busy at 47 seconds, the keeper quits QEMU, and
never presses the power button on a guest that may be half saved. A VM an
older winvm started gets SIGTERM a second before SIGKILL, since nothing
shields it. While a winvm command or the watcher holds the instance (its
`lease.json`), the keeper never presses the power button; it waits, and quits
QEMU at 50 seconds if it must.

A stow is used up the moment QEMU has loaded it and Windows runs again, so
`winvm start` never recalls the same stow twice, even when Windows was
stowed in the middle of restarting or installing updates and is slow to
answer afterwards. If Windows' guest agent does not answer within 5 minutes
of a recall (or of `winvm load`, `winvm rewind` or `winvm golden reset`),
winvm says Windows is still busy but was restored, turns the watcher on, and
exits 6; set the clock and mount the drives later with `winvm clock` and
`winvm files mount`. The app shows that as a notice, not a failure.
`winvm share install` says it could not check the shared folder and also
exits 6, and `winvm run` runs no job and exits 6. A load that QEMU never
finishes is quit, and the stow is kept. If QEMU cannot be quit, or does not
say what state it is in, it is left as it is and the stow is marked so that
`winvm start` does not recall it; `winvm load` still can.

At logout, the keeper only does this if launchd stops it. If launchd leaves
your background session running, so does Windows, without a window, and you
find it still running when you log back in.

After the next login, `winvm status` says what happened: Windows was stowed;
or winvm did not stow it, with the reason (your `hostEnd.action`, or what
went wrong), and it was shut down, quit or killed instead; or the Mac ended
winvm before the keeper finished, with the last step it reached. Each note
says how many seconds after the stop began that happened, which is how long
macOS gave winvm.

Every save records the QEMU that wrote it. For a VM an older winvm started,
winvm asks that QEMU for its version; when it can't tell which winvm runtime
it came from, the save says so, and `winvm start` recalls such a stow only
with QEMU of the same version. Otherwise it refuses, and
`winvm start -i NAME --boot` discards the stow and starts Windows afresh.

The keeper isn't a login item and doesn't outlive a restart. The app carries
it; a CLI-only install gets it from `winvm setup`, which downloads the keeper
`packages/core/keeper.json` pins.
`WINVM_KEEPER=<path>` uses another build, for development. Every VM runs under
the keeper: when none is found, `winvm start`, and anything else that launches
QEMU, starts nothing and says how to get one; `load`, `rewind`,
`golden reset` and `stow` refuse before they touch Windows, since none of them
could bring it back (a stow refused this way exits 4, as any refused stow
does); and `winvm doctor` lists it as a missing prerequisite. `winvm create`, `winvm adopt` and `winvm setup`, which
start no VM, only mention it. A command whose
`WINVM_KEEPER` differs from the one winvm's service runs with is not run; it
says which keeper each names. `winvm status` has a `keeper` row:

- `protected`: QEMU runs under the keeper.
- `watched, not shielded: started by an older winvm`: QEMU was started
  detached before this update. The next winvm command, or the app, starts a
  keeper that watches it where it is and runs the control service, without
  restarting Windows. At a shutdown the keeper still tries to stow it, but
  macOS may end QEMU first. Protect now in the app's Details, or
  `winvm stow -i NAME && winvm start -i NAME`, restarts it under the keeper.
  When this winvm could not recall a stow of the QEMU that runs it (an update
  changed QEMU), there is no Protect now: status and the app say so, and
  `winvm stop` then `winvm start` puts it under the keeper instead.
- `not protected: started without winvm's keeper`: QEMU was started detached
  and no keeper watches it yet. It keeps working, and `winvm stop`, `kill`
  and `status` treat it as before.
- `not protected: no winvm-keeper installed`: QEMU was started without the
  keeper, and this winvm has no keeper to take it over; the note says how to
  get one.
- `confused`: the keeper and `qemu.pid` name different processes; `winvm kill`
  clears it.

`winvm doctor` says which keeper it would use, and lists every VM still
running from an older winvm (`watched, not shielded`, `not protected`), each
with the note `winvm status` gives for it: Protect now in the app, or
`winvm stow -i NAME && winvm start -i NAME`, puts it under the keeper, and
when the stow could not be brought back, `winvm stop` then `winvm start`
does. `winvm doctor --json` lists them as `legacy`, each with its `name`,
`protection` and `note`.

## The control service

`winvm start`, and anything else that launches QEMU, starts a control service
for the instance. It stops 10 seconds after QEMU exits.

QEMU's own sockets are `qmp-qemu.sock` and `qga-qemu.sock`. The service
listens on `qmp.sock` and `qga.sock` and passes callers through one at a time.
Connect to `qmp.sock` and `qga.sock`, never to the `-qemu` ones.

The service also answers HTTP on `control.sock` in the instance folder. The
socket is readable only by your account, so there is no port or token.

- `GET /events` streams server-sent events: every QMP event QEMU sends, with
  its data and timestamp; QEMU's run state, read with `query-status` each time
  the service connects to QEMU; the connection to QEMU being lost; and the
  service starting and stopping.
- `GET /status` returns the last known run state, QEMU's process ID, and
  whether the service is connected to QEMU.

```sh
curl -N --unix-socket ~/.local/state/winvm/instances/NAME/control.sock http://localhost/events
```

The same events are appended to `events.jsonl` in the instance folder, one
JSON object per line. Every command that changes the machine (`start`, `stop`,
`save`, `stow` and the rest) also appends a line when it begins and another
when it ends, with its exit code or error. Past 1 MiB the service moves the
file to `events.prev.jsonl` and starts a new one, so the two files together
hold the recent history.
`winvm status` shows the service. `winvm kill` and `winvm destroy` stop it.

`winvm events` prints the records of every instance (or one, with `-i`), and
`--follow` keeps following them. With `--json`, each line is one JSON object
whose `type` is `hello`, `entry` (the record's line, whole), `gap` (lines were
rotated away before they were read), `instances` (an instance appeared or
went) or `end`. Every line carries a `cursor`; pass it back with `--since` to
carry on from that line without losing one. The app follows the records this
way, with one long-lived `winvm events --follow --json`, instead of asking for
the status every few seconds.

## Operations the service runs

`start`, `stop`, `stow`, `save`, `load`, `rewind`, `golden reset`, `pause`,
`resume`, `wake`, `sleep`, `lock`, `reboot` and `kill` run inside the control
service. The CLI, and the app, which runs the CLI, sends the command to the
service, prints what the service records for it, and exits with its exit code.
What they print and their exit codes (3, 4, 5 and 6 included) are as before.
When no service answers and the machine is not running, a command that needs
a running guest (`stop`, `pause`, `save` and the like) is answered by the CLI
itself, as before: it says the machine is not running, with the same exit
code, and starts nothing. `start`, `load`, `rewind` and `golden reset` first
start a service under the instance's keeper, holding the instance under the
command's own name, so `start` and `load` can still create an instance, then
send it the command. A service that is just stopping is waited for, and a new
one started.

- **Ctrl-C only lets go.** Ctrl-C, or the app quitting, stops the CLI from
  following, not the command. The command finishes in the service and its end
  is recorded. The CLI says
  ``pause continues in winvm's service; follow it with `winvm events -i NAME --follow` ``
  and exits 130.
- **One at a time.** While the service runs a command it holds the instance's
  lease (`lease.json`), so a second command, from this winvm or an older one,
  is refused as busy. With `--wait` it queues instead, and says what it waits
  for. As before, a command always waits for work winvm started by itself,
  such as an idle autosave.
- **`kill` never waits.** It runs beside the command in progress, which then
  ends as killed and sends nothing more to QEMU or Windows. Once the kill is
  recorded, the service stops.
- **`winvm cancel -i NAME`** ends the command the service runs, or, with
  `--id ID`, a given one. It ends a command still waiting for its turn, and
  these before their point of no return:
  - `stop`, before it presses the power button: everything it took down is
    put back, as when Ctrl-C stopped it before;
  - `stow` and `save`, before the migration completes: QEMU is asked to
    cancel the migration, and Windows runs on;
  - `start`, `load`, `rewind` and `golden reset`, before they quit or launch
    QEMU or replace its disk;
  - `reboot`, before it asks Windows to restart.

  Any other command, and these after that point, is refused with the reason.
  A CLI interrupted while its command still waited prints the `--id` to use.
- **When the Mac shuts down**, a `stow`, a `save` and a `stop` that has
  pressed the power button are left to finish (a `save` is cancelled if it
  would run past the keeper's limit); every other command ends at its next
  step, and winvm stows Windows.
- **`reboot` counts the restart by Windows' new boot and a logon**, as
  before, then looks for QEMU's report that Windows reset; when the record
  has none, it says so with a `warning` line. It stops at once if QEMU exits.
- **The guest's Finder drives come back through the CLI.** `start`, `load`,
  `rewind`, `resume`, `wake` and `reboot`, and a `stop` or `stow` that put
  things back, leave mounting the drives again to the CLI that follows them,
  which mounts them in your own session while it holds the instance, and not
  while the Mac is shutting down or the guest is paused. A CLI that let go
  leaves them down, and `winvm status` names them and the
  `winvm files mount -i NAME` that brings them back.
- **When the service can't take it.** When no service answers for a running
  machine, or the service comes from an older winvm that runs no commands,
  the CLI starts a current service, adopting a machine an older winvm started
  and handing an older service of this install over, and sends the command
  again; with `--wait` it waits for the instance meanwhile. If it still can't
  be sent, the CLI says why and runs nothing, except for `stop` and `stow`,
  which it then runs itself under the instance's lease, so a running machine
  can always be shut down or saved. If the service took the command but gave
  no answer within 5 seconds, the CLI says so and does not run it again,
  because it may already be running. `kill` kills QEMU itself whenever no
  service takes it.

The requests, on `control.sock`:

- `POST /ops` with `{"protocol": 1, "op": "pause", "args": [], "wait": false}`
  answers `202` with `{id, cursor, pid, queued}`, or `409` with `{busy}` naming
  the lease holder. An optional `id` (8 to 64 letters, digits and dashes) is
  used as the op's id, so a client can follow it in the record by a name it
  chose. The service refuses an id an op it has taken still uses; keeping ids
  unique over time is the client's job (the app uses fresh UUIDs). A protocol or command the service doesn't have gets `400`
  or `501`, with the protocol it speaks and the reason.
- `POST /ops/cancel` with `{"protocol": 1}` and an optional `id` answers `200`
  with `{cancelled}`, `409` with `{refused}` and the reason, or `404` when
  nothing runs.

Between a command's `begin` and `end` lines in `events.jsonl`, each piece it
prints is a line `{"kind": "op", "phase": "output", "id", "operation",
"stream": "out" | "err", "text"}`. Older readers skip these lines.

A command can be given its op's id with `--op-id ID` (8 to 64 letters, digits
and dashes). `winvm status --json` names the id of the command in progress,
and `winvm events -i NAME --op ID` prints what that command printed and exits
with its exit code; `--follow` waits while it runs, and `--json` prints how it
ended as one object. The app names every command it runs this way, and its
close reads how each one ended from the record: its own stow or stop, and any
command it waited for, whoever ran it. While its own stow or stop runs, the
app notes it in its data folder, so if the app is quit before it ends, the
next app follows it to its end and says if it did not finish.

## Keeping them current

`winvm status` only reads. Before this release it also replaced an
out-of-date service and unmounted drives a gone guest left; it no longer does,
so scripts that ran `winvm status` to repair an instance should run
`winvm reconcile` instead. When the service is missing or was started by
another build of winvm, or a guest that is gone left its drives mounted,
`status` says so (`"management": "repair"` in `--json`) and leaves them be.
`winvm reconcile [-i name]` repairs them and leaves Windows running. So do
`winvm start` on a running instance, and the other commands that use the guest
(`exec`, `info`, `save` and the rest). The app runs `winvm reconcile -i NAME`
when a status it reads says a repair is due, one at a time per instance: a
minute after a repair that finished (or was put off because a command held the
instance), and after one that failed it waits 1, 2, 4 minutes and so on, up to
30.

A repair hands the service over under the instance's lease, so it is put off
while any command, or an autosave, holds the instance, and never interrupts
one. The new service carries on the watcher's work: if a watcher process an
older winvm started (v0.1.4 and before) is still running, the service asks it
to stop, waits for an autosave or stow it has under way to finish, and only
then watches the guest itself. The record says so with `{"kind": "service",
"what": "watcher taken over"}`. That process is known by `watch.pid`, by a
start no later than `watch.pid` was written, and by its command line
(`winvm watch` for this instance), so a pid reused by another process is
never signalled.

`winvm status` also no longer looks at the folder the Windows ISO links to
when it reports Time Machine: if that is on another disk, macOS would ask for
permission and the status would wait. `winvm doctor` and `winvm timemachine`
still check it.

## The idle watcher

`start` also turns on the idle watcher, unless you pass `--no-watch`. `load`
and `rewind` into a stopped instance turn it on too. The watcher runs inside
the control service; there is no separate process. It logs to
`instances/<name>/watch.log` and stops when QEMU does.

The guest counts as idle when QEMU's CPU use stays below a threshold, no
`winvm` command is using the guest, and no VNC client is connected. When it
has been idle long enough, the watcher:

- **autosaves**: one save named `auto-<time>`, then another only after the
  guest has been used and gone idle again. It keeps the newest three
  (`autosave.keep`) and never touches other saves.
- **stows**: after a longer idle time, stows the guest, which saves it and
  shuts QEMU down. `winvm start` brings it back.
- **fixes the clock**: after the Mac sleeps, or when the guest's clock has
  drifted, it resyncs it.

Autosaves and stows are operations the service runs itself, in the same queue
as yours and marked as winvm's own (`"automatic": true` in the record). They
never run beside a command you started: while one holds the instance, the
watcher skips that round. A command you start meanwhile waits for an autosave
under way, as before. When the Mac shuts down, an autosave under way is
cancelled and Windows is stowed.

Turning the watcher off waits for it, as stopping the watcher process did:
`winvm watch --stop`, `winvm run` and `winvm test` ask the service, which
starts no more autosaves or stows, lets one under way finish, and only then
answers. After an idle stow, QEMU has stopped by then, so `winvm run` recalls
the stow. A watcher process an older winvm started is stopped too, waiting for
its autosave or stow.

A stow takes the guest's Finder drives down first. If an idle stow then fails,
nobody's command is there to mount them again, so the record says a remount
is due (`"remount": true` on the stow's end), `watch.log` says why the stow
failed, and `winvm status` names `winvm files mount -i NAME`. The app mounts
them again by itself, in your session, with `winvm files remount -i NAME`,
which mounts what a command took down under the instance's lease, and not
while the guest is paused or the Mac is shutting down. It stops at once if
the Mac begins shutting down meanwhile. It exits 1 when it mounted nothing
that was waiting (busy, paused, shutting down, or a failed mount), and 0 when
nothing was waiting.

```sh
winvm config -i default                        # current settings and defaults
winvm config -i default stow.idleMinutes=120 autosave.keep=5
winvm config -i default watch.enabled=false    # no watcher for this instance
winvm watch  -i default                        # turn it on, as start does
winvm watch  -i default --status               # or --stop, until the next start
```

`winvm watch` used to run the watcher in the foreground until QEMU exited. It
now asks the instance's service to turn its watcher on and returns at once;
`--interval` is gone. Like the other commands that use the guest, it first
brings an out-of-date service up to this build. If no current service runs,
it says so, names `winvm reconcile`, and exits 1. `--status` says `stopped`
unless what last published the state is the instance's service or watcher.

Settings are stored in `instances/<name>/config.json`. A running watcher picks
up changes within a minute.

The same file holds the instance's `title`, which the Mac app shows for it (its
window, Terminal and Files) in place of the instance's name. It is one line of
up to 80 characters; an empty title goes back to the name. The app sets it when
you double-click the title in its toolbar, or choose Window > Rename Window….

```sh
winvm config -i default title="Build box"
winvm config -i default title=                 # back to "default"
```
