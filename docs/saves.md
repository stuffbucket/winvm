# Saves and goldens

## Saves

A save holds the whole running machine: memory, devices, disk and firmware
variables. You can list saves, keep them across restarts, and load one whether
or not the guest is running.

```sh
winvm save before-install        # the name defaults to a timestamp
winvm load before-install        # running or stopped
winvm save --fast clean          # larger, but faster to load
winvm saves                      # name, kind, format, created, size, compatible
winvm saves rm before-install    # deletes its note too
winvm saves path before-install  # the save's folder (--json: {"path": …}); the app's Show in Finder
winvm saves protect before-install    # never rotated, swept or replaced; unprotect to undo
winvm saves note before-install --title "Clean install" --tags win11,clean
winvm pause / resume             # freeze the guest / carry on
winvm sleep / wake               # lock Windows and freeze it / carry on at the lock screen
winvm lock                       # Windows back to its lock screen
winvm stow                       # save and shut QEMU down; the next start recalls it
winvm clock                      # the guest's clock offset, and fix it
```

- **Baseline.** The first `start` of an instance saves `baseline` once
  Windows is logged on. `rewind` with no
  snapshot named `fresh` goes back to it. `start --no-autosave` skips it.
- **Where.** `~/.local/state/winvm/saves/<instance>/<name>/`. The disk copies
  are APFS clones, so they take little space until the instance changes the
  blocks they share. `destroy` removes an instance's saves, unless you pass
  `--keep-saves` or one of them is protected. `load` can recreate a destroyed
  instance from a kept save.
- **Protected.** `saves protect <name>` keeps a save from autosave rotation,
  `destroy`, `prune` and being replaced by a save of the same name.
  `saves rm` refuses it until you `unprotect` it, or pass `--force`. The
  `stow` save is a one-shot resume slot and can't be protected.
- **Formats.** The default is compressed with zstd. `--fast` uses QEMU's
  mapped-ram format: larger, but much faster to load. Use it
  for a save you load over and over. `load` reads either.
- **Compatibility.** A save loads only into the same virtual hardware, image,
  firmware and QEMU version. `saves` shows which ones still load, and `load`
  says what changed when it refuses.
- **Display.** New file saves record the display device the running VM was
  launched with (`ramfb`, or `virtio-gpu`), not the preference waiting for the
  next cold boot. Loading a save, or recalling a stow, restarts QEMU with that
  captured device: a ramfb save restores on ramfb even after you switch the
  instance to virtio-gpu, and a virtio-gpu save restores on virtio-gpu even
  after you switch to ramfb. Loading never rewrites your configured preference
  (`winvm display`); it still decides what an ordinary cold boot launches
  (`start --boot` skips a stow). `winvm display` shows the configured and the
  running device, and `status` reports the running one. A save made after a
  restore records the restored device again. `saves`, stow recall, golden
  cloning, and saves kept by `destroy --keep-saves` all use the same
  display-aware check. The screen's size is not part of this: a restored guest
  comes back at the size it had, and live resizing works as before. A save is
  refused, with nothing stopped or written, when the running QEMU's display or
  shared-folder devices are not what restoring that display would launch: during
  `share install` (a temporary ramfb boot with the shared-folder devices), or
  with a hand-edited virtio-gpu size outside 640x480 to 7680x4320. Save after
  the install finishes, or reset the display with `winvm display`.
- **Older checkpoints.** File saves made before the display was recorded, and
  internal `snapshot`/`rewind` checkpoints, still load only while the instance's
  display is the device they were taken on. Switch the preference back with
  `winvm display` (while stopped) before loading one; an old compatibility hash
  cannot reveal which device it came from. Other hardware, image, firmware and
  QEMU checks stay strict for every save.
- **Clock.** Loading, resuming or recalling a stow sets the guest's clock to
  the host's.
- **Loading replaces this machine.** `load` never makes a new machine. It
  quits the instance's QEMU if one is running (running or paused: what it was
  doing is thrown away, with no copy made), puts the save's disk and firmware
  back, and starts QEMU again from the save's memory. Windows ends up running
  at that moment, even if it was paused. A stopped machine is simply started
  from the save. Nothing keeps the present first: do that with `save`. (The
  app's Restore confirmation offers "Save Current First", which takes a
  checkpoint of the running machine and then loads.) Loading also discards a
  waiting `stow`, since the next `start` would otherwise replace what you loaded.
- **Size.** `saves` shows `bytes`: the memory file plus the disk copy's
  allocated blocks plus the firmware variables. That is what the save takes on
  your Mac's disk, but the disk copies are APFS clones that share blocks with
  the machine and with other saves, so it overstates what deleting one frees. It
  is an upper bound. The screenshots aren't counted.
- **How many machines.** There is no limit in winvm. Each instance is its own
  QEMU with its own memory (4 GiB to half the Mac's RAM, 8 GiB by default for a
  new one) and processors, and its own VNC display (`:1` to `:99`, so at most 99
  instances). In practice the Mac's memory is the limit.
- **Paused stays paused.** Only `resume` (or `wake`) starts a paused or asleep
  guest again. Nothing else calls into it meanwhile: `status` reports it at once
  without asking its agent, the agent verbs refuse it (`agent connect` exits 3),
  and the watcher neither autosaves nor stows it. A save taken while it is
  paused leaves it paused.
- **Sleep.** This guest has no ACPI sleep (QEMU's `virt` machine reports no
  wakeup support, and `powercfg /a` lists no sleep states), so `sleep` locks
  Windows, then pauses it marked asleep. `lock` and `sleep` first enable the
  signed-in account if Windows has it disabled, as audit mode's built-in
  Administrator is; otherwise the lock screen would refuse it. Sign back in
  with Enter.

`snapshot` and `rewind <tag>` also work. They keep their state inside the
instance's disk file instead.

## Screenshots and notes

Every save keeps a picture of the screen at the moment it was taken, next to
its other files:

- `screen.png`: the whole screen, at the guest's resolution.
- `thumb.png`: the same picture, shrunk to fit inside 480x300.

The picture is taken while the guest is paused for the save, so it shows
exactly what the save holds. If no picture can be taken, for example because
the guest has no screen, the save still works and simply has none. Saves made
before this feature have no picture. The pictures don't count towards a save's
size in `saves`.

You can also add a note to a save: a title, some text and tags.

```sh
winvm saves note before-install                      # show it
winvm saves note before-install --title "Clean install" --tags win11,clean
echo "Office not installed yet" | winvm saves note before-install --text -
winvm saves note before-install --clear              # delete it
winvm saves note before-install --json               # the note as JSON, or null
```

`--title`, `--text` and `--tags` change only what you pass and keep the rest.
An empty value clears that field (`--title=`). `--clear` starts again from an
empty note.

In scripts, write each value as `--text=<value>`, joined with `=`. That form
takes any text, including text that starts with `-`, like a Markdown list:
`--text="- first item"`. Written as two words, `--text - item` would be misread.

Notes aren't stored with the save. They live in your data folder, so clearing
out machine state never touches them:

- `~/.local/share/winvm/notes/<instance>/<save>.json`, or under
  `$XDG_DATA_HOME/winvm/` when that's set.

A note still belongs to its save:

- Deleting the save (`saves rm`, autosave rotation, `destroy`) deletes its note.
  `destroy --keep-saves` keeps both.
- Saving again under the same name drops the old note, because it described the
  old moment.
- A save copied to another instance (a test pool) brings its note with it.

A machine has a note of its own, for whatever you want to remember about that
Windows install. The app shows it on a suspended machine's screen and saves it
as you type:

```sh
winvm note -i dev                       # show it
winvm note -i dev --text="Office is not installed yet"
echo "Licence key is in the drawer" | winvm note -i dev --text -
winvm note -i dev --clear               # delete it
winvm note -i dev --json                # {"text", "updatedAt"}, or null
```

It lives at `~/.local/share/winvm/machine-notes/<instance>.json` (or under
`$XDG_DATA_HOME/winvm/`), not with the notes on saves, and goes with the machine:
`destroy` deletes it, with or without `--keep-saves`. It holds at most 20,000
characters.

`saves --json` reports, for each save, `format`, `screenshot` and `thumbnail`
(absolute paths, or `null`), `screenSize`, `title` and `notes` (the whole note,
or `null`). For a save that won't load, `incompatible` lists what changed:
`base`, `hardware`, `display` (only the display device differs: a save without
a recorded display), `firmware` or `qemu`.

## Goldens

A golden is a `--fast` save taken once Windows has gone quiet. Test jobs reset
to it before each run.

```sh
winvm golden create -i ci-1     # boot (or --from <save>), wait until quiet, save "golden"
winvm golden reset  -i ci-1     # load it and wait until the guest answers
```

`create` waits until QEMU's CPU use stays low for a while (`--settle-cpu`,
`--settle-for`), but no longer than `--max-wait`; then it saves anyway and
says so. A save taken right after boot would replay Windows' post-boot work
on every load. From code, use `createGolden` and `resetToGolden` in
`packages/core/src/golden.ts`.

Measured on an M-series Mac, 4 vCPU and 4 GiB guest, median of five resets:

| Save | Restored | Answering | Clock set | Total | Guest CPU, next 20 s | Memory on disk |
|---|--:|--:|--:|--:|--:|--:|
| golden (fast, quiet) | 602 ms | 206 ms | 459 ms | 1.28 s | 0.6–2.1% | 3.9 GB |
| same state, zstd | 2734 ms | 206 ms | 556 ms | 3.50 s | 0.8–2.1% | 1.8 GB |
| fast, just after boot | 862 ms | 207 ms | 368 ms | 1.40 s | 1.7–3.1% | 3.8 GB |
| zstd, just after boot | 2545 ms | 125 ms | 663 ms | 3.41 s | 6.9–8.2% | 1.6 GB |
