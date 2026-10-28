---
name: winvm-build-environment
description: Use when a user wants a Windows machine set up with particular software, settings, files or features ("I need Windows with Node, Git and long paths on", "give me a Windows box like CI's"), and wants it repeatable. Writes a declarative environment spec, applies it step by step to a winvm machine with verification (scripts/apply-env.sh on macOS/Linux, scripts/apply-env.ps1 in PowerShell), checkpoints the result with a name and a note, and restores or rebuilds it later.
compatibility: Applies through winvm on an Apple Silicon Mac. Host helper in POSIX sh (macOS, Linux) and PowerShell 5.1/7 (Windows, or pwsh anywhere); guest steps in Windows PowerShell 5.1.
---

# Building an environment

The workflow that ties the other skills together. Read the winvm skill first
(names, targeting, safety). Commands for each part live in the skills named below.

## 1. Pin down what is wanted

List every install (with the exact version or URL), setting, file and check.
Ask about anything unclear: ARM64 or x64 build, licence keys, which machine.

## 2. Write the spec

Copy [templates/environment.yml](templates/environment.yml) next to the user's
project (e.g. `winvm-env/environment.yml`) and edit it. It is a `winvm run` job
file with `reset: false`: `files:` stages the guest templates and installers,
`steps:` run in order, and the first failing step stops the run.

- One step per change, each calling a template from winvm-inside-windows
  (`install-package`, `winget-install`, `set-env`, `set-registry`,
  `enable-feature`); see their headers for parameters. Each one verifies itself
  and does nothing if already done, so the spec can be applied again.
- Give installers as `url:` files (downloaded once on the Mac, cached) and
  install from `C:\winvm\downloads\`.
- End with a check step that tests everything the user asked for.
- A step that needs a restart: a `shell: winvm` step with `run: reboot`, then the
  steps that depend on it. The job format is in winvm-ci-jobs.

## 3. Pick the machine and checkpoint it

From winvm-machines: a fresh machine is the most reproducible.

```sh
winvm ls --json
winvm create -i devbox && winvm start -i devbox      # or the machine the user named
winvm agent status -i devbox                         # install the agent if missing (winvm-inside-windows)
winvm save -i devbox before-env --note "before applying environment.yml"   # skip on a fresh machine: it has baseline
```

## 4. Apply and checkpoint

On macOS or Linux shells:

```sh
<skill>/scripts/apply-env.sh -i devbox --save devbox-ready --note "Node 22, 7-Zip, long paths; spec winvm-env/environment.yml" winvm-env/environment.yml
```

On Windows or in PowerShell:

```powershell
<skill>/scripts/apply-env.ps1 -i devbox --save devbox-ready --note "..." winvm-env/environment.yml
```

Both run `winvm run SPEC -i NAME --keep` with `WINVM_TEMPLATES` set, then, only if
every step passed, `winvm save -i NAME CHECKPOINT --note TEXT`. Exit codes: 0 done;
1 a step failed (no checkpoint); 2 usage; 3 applied but the checkpoint failed;
127 winvm not found. `--json` prints one object:
`{"ok":true,"instance":"devbox","spec":"...","checkpoint":"devbox-ready","stage":"done","exit":0}`.
winvm runs only on the Mac: from another computer, run the helper on the Mac (e.g. over ssh).

On failure: read the failing step's output, fix the spec, apply again. To start
over instead: `winvm load -i devbox before-env` (or `baseline`).

## 5. Verify, then hand over

Check independently of the spec: `winvm exec` the tools, a screenshot for GUI
apps (winvm-gui). Then tell the user the machine, the checkpoint and the spec path.

## Reuse

- Back to it: `winvm load -i devbox devbox-ready` (winvm-checkpoints).
- Another machine, or after a winvm update makes the checkpoint incompatible:
  create a machine and apply the same spec. The spec, not the checkpoint, is the
  reproducible record: keep it in version control.
- Small one-off change: `winvm script` a template directly, then `winvm save` (winvm-inside-windows).

## Pitfalls

- `winvm run` stops the machine's idle watcher; `winvm start -i NAME` on the
  running machine turns it back on.
- Without `--keep`, `winvm run` shuts the machine down afterwards; the helpers
  always pass it.
- New PATH entries and variables reach new processes only after `winvm reboot`;
  check steps read them from the registry (as the template's last step does).
- `reset: true` (the default for jobs) would load a golden and wipe the machine:
  keep `reset: false` in environment specs.
