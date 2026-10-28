---
name: winvm-machines
description: Use to find, create, start, stop, pause, resume, sleep, wake, lock, restart, stow, kill, reset, destroy, retitle or resize winvm Windows machines (instances), and to pick which machine a task should run on. Also covers the idle watcher's autosave and stow settings.
---

# Machines

Read the winvm skill first for names and safety rules. Every command takes `-i NAME`.

## Pick the machine

1. `winvm ls --json` gives `{"images":[{name,snapshots}],"instances":[{name,image,running}]}`.
2. The user named one: use it. Otherwise make a new one with a descriptive name
   (`create`), rather than borrowing `default` or a machine someone else uses.
3. `winvm status -i NAME --json` before you act: running, paused, agent, saves.
   With several machines and no `-i`, `status` prints a table.

Names: letters, digits, `.`, `_`, `-`, starting with a letter or digit, at most 64.

## Lifecycle

```sh
winvm create -i NAME [--image IMAGE]   # make it, don't start it
winvm start  -i NAME                   # boot (creates if absent); returns once Windows has logged on
winvm start  -i NAME --ephemeral       # everything discarded when it stops
winvm start  -i NAME --no-autosave     # no baseline checkpoint on the first boot
winvm start  -i NAME --no-watch        # no idle watcher (no autosave, stow or clock sync)
winvm start  -i NAME --boot            # discard a stow checkpoint and boot cold
winvm stop   -i NAME                   # clean Windows shutdown (up to 3 min)
winvm reboot -i NAME [--timeout 600]   # restart Windows; returns once logged on again
winvm stow   -i NAME                   # checkpoint and quit QEMU; next start resumes it in seconds
winvm kill   -i NAME                   # pull the plug (ask first; unsaved work is lost)
```

Destructive, ask first:

```sh
winvm reset   -i NAME                  # discard every change, back to the image (checkpoints kept)
winvm destroy -i NAME [--keep-saves]   # must be stopped; removes it and, unless --keep-saves, its checkpoints
```

## Pause, sleep, lock

```sh
winvm pause  -i NAME     # freeze the CPUs; nothing else touches it until resume
winvm resume -i NAME     # carry on, and fix the guest clock
winvm sleep  -i NAME     # lock Windows, then freeze it (there is no real ACPI sleep)
winvm wake   -i NAME     # same as resume; Windows is at its lock screen (Enter signs in)
winvm lock   -i NAME     # Windows back to its lock screen
```

A paused or asleep machine refuses agent commands (`agent connect` exits 3), so
`exec`, `put` and the like fail until you `resume`.

## Title, screen size, settings

```sh
winvm config  -i NAME title="Build box"       # the name the app shows; title= resets it
winvm display -i NAME                         # device, size, scaling now
winvm display -i NAME 1920x1080 [--scale 150] # resize live (virtio-gpu only)
winvm display -i NAME virtio-gpu              # switch device; only while stopped
winvm open    -i NAME [--web]                 # show the screen to the user
winvm settings [viewer.pauseOverlay=false] [--json]   # the user's app settings, all machines
```

A machine's name can't be changed; set its title instead. Switching the display
device strands checkpoints taken on the other one until you switch back.

## Idle watcher

`start` runs a watcher that, when the machine is idle, autosaves (`auto-<time>`,
newest 3 kept), later stows it, and resyncs the clock after the Mac sleeps.

```sh
winvm config -i NAME                                  # settings and defaults
winvm config -i NAME stow.idleMinutes=120 autosave.keep=5
winvm config -i NAME watch.enabled=false
winvm watch  -i NAME --status                         # or --stop
```

## Pitfalls

- `start` on a running machine just reports it; on a stowed one it resumes the
  stow (use `--boot` to throw the stow away).
- A machine stowed by the watcher looks "stopped" in `ls`; `start` brings back
  exactly what was open.
- `stop` needs the guest agent (qemu-ga) to answer; if Windows is wedged, ask,
  then `kill`.
