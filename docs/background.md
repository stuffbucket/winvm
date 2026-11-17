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

These children ignore SIGTERM, SIGHUP and SIGINT, so a stray SIGTERM can't
end Windows abruptly. Activity Monitor's Quit does nothing to a kept QEMU;
Force Quit does. `winvm kill` is the supported hard stop, and it asks the
keeper to do it.

When the keeper itself is told to stop, because the Mac is shutting down,
restarting or logging out, or because someone ran `launchctl bootout` on it,
it asks Windows to shut down through a QMP monitor of its own
(`keeper/qmp.sock`). It first lets a save that is still running finish, or
cancels it if there isn't time. It quits QEMU 5 seconds before launchd's limit
and kills it 2 seconds before. Stowing Windows at that moment, instead of
shutting it down, comes in a later release.

The keeper isn't a login item and doesn't outlive a restart. The app carries
it; a CLI-only install gets it from `winvm setup` once a release pins one.
`WINVM_KEEPER=<path>` uses another build, for development.
`WINVM_KEEPER=off` turns the keeper off: QEMU then starts detached, as it did
before, and so does every VM when no keeper is installed. `winvm status` has a
`keeper` row:

- `protected`: QEMU runs under the keeper.
- `not protected: started without winvm's keeper`: QEMU was started detached,
  for example before this update. It keeps working, and `winvm stop`, `kill`
  and `status` treat it as before. It is protected from its next start;
  `winvm stow -i NAME && winvm start -i NAME` does that now.
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
