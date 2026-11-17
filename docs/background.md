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

### Status polling

A stopped or stowed machine's status reads its CPU and memory settings directly
from `hardware.json` (or the legacy defaults). It does not construct a QEMU
command line, discover firmware, or run capability probes. A running machine's
uptime and actual CPU/memory allocation come from one `ps` invocation rather
than two; changing the next-boot settings does not change those live values.

`mise exec -- bun scripts/bench-status.ts` measures stopped-status gathering in
fresh Bun processes against a temporary instance, without starting a guest.
It reports gathering time separately from process startup and module loading.
On the development Mac, nine samples before/after this change measured median
gathering time of **52.6 ms → 0.48 ms**. This is host-side status overhead, not
a measurement of guest throughput or input latency.

## The idle watcher

`start` also starts an idle watcher, unless you pass `--no-watch`. `load` and
`rewind` into a stopped instance start one too. It logs to
`instances/<name>/watch.log` and exits when QEMU does.

Its run-state and VNC checks start together and use the short-deadline QMP
client: a five-second timeout applies while waiting for broker admission and
to each negotiation/command phase. They do not use the boot client's long
connection retries or its extra 20-second capability wait. A failed or
incomplete sample is unknown, not idle: no autosave, stow or drift check is
scheduled until the monitor is available again, and the quiet period restarts.
The failure alone does not re-arm an autosave already taken; known command or
viewer activity still does.

The guest counts as idle when QEMU's CPU use stays below a threshold, no
`winvm` command is using the guest, and no VNC client is connected. When it
has been idle long enough, the watcher:

- **autosaves**: one save named `auto-<time>`, then another only after the
  guest has been used and gone idle again. It keeps the newest three
  (`autosave.keep`) and never touches other saves. A save stops the guest
  for about 1.5 s (`events.jsonl` shows it as paused, then running), so the
  watcher only saves when no viewer has been connected for the whole idle
  period and the Mac's keyboard and mouse have been untouched for 20 s;
  otherwise it waits for a quiet moment.
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

**A Mac that sleeps freezes the guest.** QEMU stops with the rest of the Mac,
and Windows' clock is behind by the length of the sleep until the watcher
resyncs it on wake. Nothing in winvm holds the Mac awake, so a long job in the
guest stops while you are away from the keyboard. `power.keepAwake=true` makes
the watcher run `caffeinate -i` for as long as QEMU runs (the display may still
turn off; it is off by default because it costs battery on a laptop):

```sh
winvm config -i default power.keepAwake=true
```

The same file holds the instance's `title`, which the Mac app shows for it (its
window, Terminal and Files) in place of the instance's name. It is one line of
up to 80 characters; an empty title goes back to the name. The app sets it when
you double-click the title in its toolbar, or choose Window > Rename Window….

```sh
winvm config -i default title="Build box"
winvm config -i default title=                 # back to "default"
```
