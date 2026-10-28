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

- `GET /events` streams server-sent events: QEMU state changes (`paused`,
  `running`, `stopped`, `reset`, `migration`) and the service starting and
  stopping.
- `GET /status` returns the last known state, QEMU's process ID, and whether
  the service is connected to QEMU.

```sh
curl -N --unix-socket ~/.local/state/winvm/instances/NAME/control.sock http://localhost/events
```

The same events are appended to `events.jsonl` in the instance folder.
`winvm status` shows the service. `winvm kill` and `winvm destroy` stop it.

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
