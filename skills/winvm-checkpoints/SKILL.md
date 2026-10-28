---
name: winvm-checkpoints
description: Use to checkpoint a winvm Windows machine and get back to one - save, load, list and delete checkpoints (saves), notes on them, quick snapshots and rewind, the automatic baseline, goldens for one-second resets - and to explain why a checkpoint will not load. Also the pattern of checkpointing before a risky change and rolling back when it fails.
---

# Checkpoints

Read the winvm skill first. Every command takes `-i NAME`.

## Save and load

```sh
winvm save  -i NAME before-office --note "clean Windows, before installing Office"
winvm save  -i NAME                  # name defaults to a timestamp, e.g. 2026-10-28_14-03-11
winvm save  -i NAME clean --fast     # bigger, but loads several times faster: for one you reload often
winvm load  -i NAME before-office    # running or stopped; no name = the newest
winvm saves -i NAME [--json]         # name, kind, format, created, size, compatible, note
winvm saves -i NAME rm before-office # delete one, and its note (ask first)
winvm saves note -i NAME before-office --title "Clean Windows" --text="Before Office; nothing else installed" --tags office,clean
winvm saves note -i NAME before-office [--json]   # show it; --clear deletes it
```

- Checkpoint names: letters, digits, `.`, `_`, `-`, starting with a letter or
  digit, at most 64. `stow` is reserved. Use names that say what state it holds.
- `save` needs a running machine, and refuses one still starting
  (`--force` overrides; don't).
- Loading takes seconds and sets the guest clock. Loading into a stopped machine
  starts it. Anything not checkpointed is lost: save first if unsure.
- A checkpoint from before `winvm agent install` brings back a Windows without the
  agent: run `winvm agent install -i NAME` again after loading it.
- Two notes: `save --note` is one line kept inside the checkpoint (`saves` lists
  it); `saves note` is the title, text and tags the Mac app's Checkpoints view
  shows and edits (kept in `~/.local/share/winvm/notes/`). Write `--text=VALUE`
  with `=` when the value may start with `-`; `--text -` reads stdin.
- Every save also keeps a screenshot of that moment; `saves --json` gives the paths.
- Files: `$WINVM_HOME/saves/NAME/<checkpoint>/`; disks are APFS clones, so
  checkpoints are cheap until the machine changes a lot.

## Kinds you will see

- `baseline`: taken at a machine's first start. `winvm rewind -i NAME` goes back to it.
- `auto-<time>`: the idle watcher's autosaves; only the newest 3 are kept.
- `stow`: from `winvm stow`; spent when `start` resumes it.
- `golden`: a `--fast` checkpoint of a settled machine, for CI.

## Snapshots (inside the disk file)

```sh
winvm snapshot  -i NAME fresh          # capture the running machine, RAM and all
winvm rewind    -i NAME fresh          # back to it in ~10-20 s, no reboot
winvm rewind    -i NAME                # snapshot "fresh", else the save "baseline"
winvm snapshots -i NAME
winvm snapshot  -i NAME fresh --delete
```

Prefer saves: they are listed with compatibility, survive `reset`, and can be loaded
into a stopped machine. A snapshot is lost with `reset` and `destroy`.

## Goldens

```sh
winvm golden create -i NAME [--name golden] [--from SAVE] [--settle-cpu 3%] [--settle-for 60s] [--max-wait 10m]
winvm golden reset  -i NAME [--name golden]    # load it and wait until Windows answers (~1.3 s)
```

`create` waits until Windows goes quiet before saving, so every reset starts calm.

## Why a checkpoint won't load

A checkpoint loads only into the same virtual hardware, image, firmware and QEMU
version. `winvm saves -i NAME` shows `compatible`; `load` names what changed.
Common causes: winvm or its runtime was updated; the display device was switched
(`winvm display`, switch back to load); a shared folder was added or removed;
the machine was rebuilt on a different image. Images too old for virtio boot
can't checkpoint at all (rebuild the image).

`destroy --keep-saves` keeps the checkpoints, and `load` recreates the machine from one.

## Checkpoint before change, roll back on failure

```sh
winvm save -i NAME before-X --note "what is about to change"
# ... make the change, verify it ...
winvm load -i NAME before-X          # only if the change failed
winvm save -i NAME after-X --note "what now works, and how it was checked"
winvm saves note -i NAME after-X --title "X installed" --text="What works, how it was checked, how it was built"
```

Name and note every checkpoint you make: the user picks them later from the app.
