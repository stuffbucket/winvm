# Background processes

A running instance has two helper processes besides QEMU.

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

`winvm status` only reads. When the service or watcher is missing or was
started by another build of winvm, or a guest that is gone left its drives
mounted, it says so (`"management": "repair"` in `--json`) and leaves them be.
`winvm reconcile [-i name]` repairs them and leaves Windows running. So do
`winvm start` on a running instance, and the other commands that use the guest
(`exec`, `info`, `save` and the rest). The app runs `winvm reconcile -i NAME`
when a status it reads says a repair is due, at most once a minute per
instance. If a repair is cut short after it stopped the watcher, the service
restarts the watcher within about 30 seconds.

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
