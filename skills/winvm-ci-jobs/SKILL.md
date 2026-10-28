---
name: winvm-ci-jobs
description: Use to run automated tests on winvm Windows machines the way CI would - write GitHub-Actions-shaped job YAML, run one job (winvm run) or a folder of them (winvm test), reset to a golden checkpoint before each, run several machines in parallel (--pool), and collect JUnit/JSON reports, screenshots and artifacts.
---

# CI jobs

Read the winvm skill first. Jobs reset a machine to a golden checkpoint before
each run (winvm-checkpoints), so use a dedicated machine: the default is `ci`.

## Run

```sh
winvm run  job.yml [more.yml] -i ci [--golden golden] [--keep] [--junit out.xml] [--json out.json] [--artifacts DIR]
winvm test jobs/ -i ci [same flags]           # every *.yml in the folder, in order
winvm test jobs/ --pool 3 [--pool-prefix ci] [--image IMAGE]   # on ci-1..ci-3 at once (1-16)
```

- The golden (`golden` unless `--golden` or the job's `golden:`) is created on first
  use: boot, settle, `--fast` save. A few minutes, once.
- The machine is shut down afterwards unless `--keep`. Exit code is non-zero if any
  job failed.
- Failures leave a screenshot and the job's `artifacts` in
  `$WINVM_HOME/runs/<machine>/<time>/` (or `--artifacts DIR`).
- `--pool N`: each machine has 4 vCPUs and 4 GiB; keep N x 4 within the Mac's
  cores and N x 4 GiB within half its memory. Jobs with `reset: false` are refused.
  `WINVM_POOL_GRACE` (default 5 min) is the extra time before a stuck job's machine is killed.
- Steps run as the logged-on user through the in-guest agent; without it, as SYSTEM
  (`WINVM_CHANNEL=qga` forces that).

## Job file

Start from [templates/job.yml](templates/job.yml). The fields:

```yaml
name: MSI install and uninstall
golden: golden                 # checkpoint to reset to (optional)
reset: true                    # false: run on the machine as it is (no golden; not with --pool)
timeout: 10m                   # whole job (seconds, or 90s/10m/1h)
env: { VERSION: v1.2.3 }       # every step; ${{ env.NAME }} or ${{ env.NAME || 'default' }} in run and files
files:                         # staged before the first step; also served at $env:WINVM_FILES/<name>
  - src: ./fixtures/app.msi    # host path, relative to the job file
    dest: C:\work\app.msi
  - url: https://example.com/x.zip     # fetched on the host and cached
    dest: C:\work\
  - release: owner/repo        # gh release download, cached
    tag: latest
    pattern: "*arm64.msi"
    dest: C:\work\
steps:
  - name: install
    shell: powershell          # powershell (5.1, default) | pwsh (falls back to 5.1) | cmd | winvm
    run: Start-Process msiexec -ArgumentList '/i','C:\work\app.msi','/qn' -Wait
    timeout: 300
    continue-on-error: false
    if: success()              # success() | failure() | always()
    background: false          # true: start it and move on (a server, a tray app)
artifacts:
  when: failure                # failure | always
  paths: [C:\work\*.log]
screenshot: failure            # failure | always | never
```

- PowerShell steps run with `$ErrorActionPreference = 'Stop'` and exit with the last
  native command's exit code.
- `shell: winvm` runs each line as a winvm command on the Mac against the job's
  machine (`ui click ...`, `webview text ... --expect ...`, `ocr --find ...`,
  `toasts --find ... --wait 30`, `reboot`); the commands are in winvm-gui.
- Inside steps: `$env:WINVM_FILES` (staged files over HTTP), `$env:WINVM_UPLOAD`,
  `$env:WINVM_WORK` (`C:\work`), `$env:WINVM_JOB`, `$env:CI`.
