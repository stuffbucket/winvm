# CI jobs: `winvm run` and `winvm test`

```sh
winvm run jobs/examples/hello.yml -i ci                  # one job
winvm test jobs/maximal/ -i ci --junit out.xml --json out.json
winvm test jobs/maximal/ --pool 3                        # on three instances at once
```

Job files are YAML shaped like GitHub Actions workflows. The format is
described at the top of `packages/core/src/job.ts`, and
`jobs/examples/hello.yml` is a small working example.

## What a run does

1. Loads a golden save, so every job starts from the same machine. The
   default golden is named `golden` and is created on first use. See
   [Goldens](saves.md#goldens).
2. Stages the job's files: host files, URLs, or GitHub release assets
   (downloaded with `gh release download` and cached under
   `~/.local/state/winvm/cache`). Inside the guest, `$env:WINVM_FILES` is a
   URL that serves them, for installers that download their own files.
3. Runs the steps, with timeouts, `continue-on-error`, `if: always()` and
   `background: true`. A `shell: winvm` step runs winvm commands on the host,
   for example `ui click`.
4. On failure, takes a screenshot and collects the job's `artifacts` into
   `~/.local/state/winvm/runs/<instance>/<time>/` (or `--artifacts <dir>`).

Use a dedicated instance; the default is `ci`. A run resets it before every
job and stops it afterwards, unless you pass `--keep`.

Steps run through the in-guest agent, as the logged-on user on the desktop,
so a tray app shows up. Without the agent they run through the QEMU guest
agent as SYSTEM, where `%LOCALAPPDATA%` and `HKCU` are SYSTEM's and nothing
launched is visible. `WINVM_CHANNEL=qga` forces that.

`--pool N` runs jobs side by side on instances `ci-1` to `ci-N`. See
[Running jobs in parallel](pool.md).

## Maximal's jobs

`jobs/maximal/` tests Maximal's Windows releases end to end: the MSI, the
portable zip, `install.ps1`, the NSIS tray app, the Settings UI, and the MCP
broker. Each downloads the latest release, or the one named by
`MAXIMAL_TAG=vX.Y.Z`.
