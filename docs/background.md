# Background processes

A running instance has three helper processes besides QEMU: the keeper, the
control service and the idle watcher.

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
  again, before it stops the watcher or takes the Finder drives down; the
  watcher stops trying idle stows until QEMU restarts, and `winvm status`
  says so; the app's close stays open with the same words. When QEMU does
  not say which version it runs, `winvm stow` exits 5 instead, and the
  watcher tries again later. A stow that fails once it has begun puts the
  watcher it stopped back while Windows still runs.

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
it; a CLI-only install gets it from `winvm setup` once a release pins one.
`WINVM_KEEPER=<path>` uses another build, for development.
`WINVM_KEEPER=off` turns the keeper off: QEMU then starts detached, as it did
before, and so does every VM when no keeper is installed. `winvm status` has a
`keeper` row:

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
- `not protected: WINVM_KEEPER=off`, or `no winvm-keeper installed`.
- `confused`: the keeper and `qemu.pid` name different processes; `winvm kill`
  clears it.

`winvm doctor` says which keeper it would use.

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

`pause`, `resume`, `wake`, `sleep`, `lock`, `reboot` and `kill` run inside the
control service. The CLI, and the app, which runs the CLI, sends the command to
the service, prints what the service records for it, and exits with its exit
code. What they print and their exit codes are as before.

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
  `--id ID`, a given one. It ends a command still waiting for its turn, and a
  `reboot` that has not yet asked Windows to restart. Any other command, and a
  reboot after its request, is refused with the reason. A CLI interrupted
  while its command still waited prints the `--id` to use.
- **`reboot` counts the restart once QEMU reports that Windows reset**, then
  waits for someone to log on, as before.
- **When the service can't take it.** When no service answers (QEMU is not
  running, or the service is restarting), or the service comes from an older
  winvm that runs no commands, the CLI runs the command itself, as before. If
  the service took the command but gave no answer within 5 seconds, the CLI
  says so and does not run it again, because it may already be running. The
  exception is `kill`, which then kills QEMU itself.

The requests, on `control.sock`:

- `POST /ops` with `{"protocol": 1, "op": "pause", "args": [], "wait": false}`
  answers `202` with `{id, cursor, pid, queued}`, or `409` with `{busy}` naming
  the lease holder. A protocol or command the service doesn't have gets `400`
  or `501`, with the protocol it speaks, so the caller can run the command
  itself.
- `POST /ops/cancel` with `{"protocol": 1}` and an optional `id` answers `200`
  with `{cancelled}`, `409` with `{refused}` and the reason, or `404` when
  nothing runs.

Between a command's `begin` and `end` lines in `events.jsonl`, each piece it
prints is a line `{"kind": "op", "phase": "output", "id", "operation",
"stream": "out" | "err", "text"}`. Older readers skip these lines.

## Keeping them current

`winvm status` only reads. Before this release it also replaced an
out-of-date service and watcher and unmounted drives a gone guest left; it no
longer does, so scripts that ran `winvm status` to repair an instance should
run `winvm reconcile` instead. When the service or watcher is missing or was
started by another build of winvm, or a guest that is gone left its drives
mounted, `status` says so (`"management": "repair"` in `--json`) and leaves
them be. `winvm reconcile [-i name]` repairs them and leaves Windows running.
So do `winvm start` on a running instance, and the other commands that use the
guest (`exec`, `info`, `save` and the rest). The app runs
`winvm reconcile -i NAME` when a status it reads says a repair is due, one at a
time per instance: a minute after a repair that finished (or was put off
because the watcher was saving), and after one that failed it waits 1, 2, 4
minutes and so on, up to 30. If a repair is cut short after it stopped the
watcher, the service restarts the watcher within about 30 seconds.

`winvm status` also no longer looks at the folder the Windows ISO links to
when it reports Time Machine: if that is on another disk, macOS would ask for
permission and the status would wait. `winvm doctor` and `winvm timemachine`
still check it.

## The idle watcher

`start` also starts an idle watcher, unless you pass `--no-watch`. `load` and
`rewind` into a stopped instance start one too. It logs to
`instances/<name>/watch.log` and exits when QEMU does.

The guest counts as idle when QEMU's CPU use stays below a threshold, no
`winvm` command is using the guest, and no VNC client is connected. When it
has been idle long enough, the watcher:

- **autosaves**: one save named `auto-<time>`, then another only after the
  guest has been used and gone idle again. It keeps the newest three
  (`autosave.keep`) and never touches other saves.
- **stows**: after a longer idle time, runs `winvm stow`, which saves the
  guest and shuts QEMU down. `winvm start` brings it back.
- **fixes the clock**: after the Mac sleeps, or when the guest's clock has
  drifted, it resyncs it.

```sh
winvm config -i default                        # current settings and defaults
winvm config -i default stow.idleMinutes=120 autosave.keep=5
winvm config -i default watch.enabled=false    # no watcher for this instance
winvm watch  -i default                        # run it in the foreground
winvm watch  -i default --status               # or --stop
```

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
