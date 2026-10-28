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
winvm saves rm before-install
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
