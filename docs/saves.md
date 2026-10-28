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
winvm saves note before-install --title "Clean install" --tags win11,clean
winvm pause / resume             # freeze the guest / carry on
winvm stow                       # save and shut QEMU down; the next start recalls it
winvm clock                      # the guest's clock offset, and fix it
```

- **Baseline.** The first `start` of an instance saves `baseline` once
  Windows is logged on. `rewind` with no
  snapshot named `fresh` goes back to it. `start --no-autosave` skips it.
- **Where.** `~/.local/state/winvm/saves/<instance>/<name>/`. The disk copies
  are APFS clones, so they take little space until the instance changes the
  blocks they share. `destroy` removes an instance's saves, unless you pass
  `--keep-saves`. `load` can recreate a destroyed instance from a kept save.
- **Formats.** The default is compressed with zstd. `--fast` uses QEMU's
  mapped-ram format: larger, but much faster to load. Use it
  for a save you load over and over. `load` reads either.
- **Compatibility.** A save loads only into the same virtual hardware, image,
  firmware and QEMU version. `saves` shows which ones still load, and `load`
  says what changed when it refuses.
- **Clock.** Loading, resuming or recalling a stow sets the guest's clock to
  the host's.

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

`saves --json` reports, for each save, `format`, `screenshot` and `thumbnail`
(absolute paths, or `null`), `screenSize`, `title` and `notes` (the whole note,
or `null`). For a save that won't load, `incompatible` lists what changed:
`base`, `hardware`, `display` (only the display device differs), `firmware` or
`qemu`.

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
