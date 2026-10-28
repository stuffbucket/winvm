---
name: winvm-inside-windows
description: Use to do things inside a running winvm Windows machine from the Mac - run commands (winvm exec), run a PowerShell or cmd script (winvm script), copy files in and out (put, get, dir, mkdir, mv, cp, rm), share a Mac folder as a Windows drive, open Windows drives in Finder, and install software or change settings silently with the ready-made Windows PowerShell templates (msi/exe/zip, winget with fallback, environment variables and PATH, registry, Windows features).
compatibility: Host side needs winvm on an Apple Silicon Mac. Guest templates are Windows PowerShell 5.1 (ARM64); they never need PowerShell 7.
---

# Inside Windows

Read the winvm skill first. Every command takes `-i NAME`; the machine must be running.

## Two channels

Commands go through the **in-guest agent** when it answers (fast; runs as the
logged-on Administrator on the desktop, elevated) and otherwise through
**qemu-ga** (slow; runs as SYSTEM in session 0, so `HKCU`, `%LOCALAPPDATA%` and
launched windows are SYSTEM's, invisible).

```sh
winvm agent status -i NAME     # "no agent" / "not answering"? -> winvm agent install -i NAME
winvm exec -i NAME -- whoami   # winvm\administrator through the agent; nt authority\system through qemu-ga
```

## Run commands

```sh
winvm exec -i NAME -- cmd /c "dir C:\work && ver"
winvm exec -i NAME -- powershell -NoProfile -Command "Get-Service sshd | Select Status"
winvm exec -i NAME --timeout 1800 -- msiexec /i C:\work\app.msi /qn /norestart
winvm launch -i NAME -- notepad.exe C:\work\notes.txt    # GUI program, detached, on the desktop
```

- `exec` takes a program and its arguments, not a shell line. For pipes, `&&`,
  `%VAR%` or `$env:` use `cmd /c "..."` or `powershell -NoProfile -Command "..."`.
- Output and the exit code come back as the program's; 124 means `--timeout`
  (default 900 s) killed it and its children.
- Shells: `powershell` (Windows PowerShell 5.1) is always there. `pwsh` (7) may not
  be: `winvm terminal -i NAME --shells --json`. `cmd` always.
- Programs started by `exec`, `script` or a terminal (through either channel)
  keep the environment Windows had when the agent started: after changing PATH or
  a variable, read it from the registry, or `winvm reboot -i NAME` first.
- `$env:PROCESSOR_ARCHITECTURE` says AMD64 under qemu-ga; Windows is ARM64. x64
  programs run under emulation; prefer ARM64 installers.
- `winvm terminal -i NAME` is an interactive shell for a person; agents use `exec`.

## Run a script file

```sh
winvm script -i NAME setup.ps1 -- -Name value -Flag    # copies to C:\winvm\scripts\ and runs it
winvm script -i NAME build.cmd -- arg1
```

`.ps1` runs in Windows PowerShell 5.1 with `-ExecutionPolicy Bypass`; `.cmd`/`.bat`
in cmd. Arguments after `--` go to the script. Exit code and output as `exec`.
Save `.ps1` files as ASCII or UTF-8 with BOM: 5.1 misreads UTF-8 without one.

## Templates: installs and settings

In [templates/](templates/), Windows PowerShell 5.1, idempotent (a second run
changes nothing), each verifying its own change. Exit codes: 0 done or already
so, 1 failed, 2 bad arguments, 3010 done but Windows must restart
(`winvm reboot`, then run it again to check).

| Template | Does |
|---|---|
| `install-package.ps1` | `.msi`/`.exe`/`.msix`/`.zip` from `-Path` or `-Url`, silently, checked by `-TestPath`, `-TestCommand` or `-ProductName` |
| `winget-install.ps1` | `winget install --id`, else `-FallbackUrl` through install-package.ps1 (put it in `C:\winvm\scripts\` too) |
| `set-env.ps1` | `-Name`/`-Value` or `-AddToPath DIR`, `-Scope Machine|User` |
| `set-registry.ps1` | one value: `-Path HKLM:\... -Name -Value -Type DWord|String|...`, or `-Remove` |
| `enable-feature.ps1` | `-Feature NAME` (optional feature) or `-Capability NAME` |

```sh
T=<this skill's folder>/templates
winvm script -i NAME $T/install-package.ps1 -- -Url https://nodejs.org/dist/v22.11.0/node-v22.11.0-arm64.msi -ProductName Node.js -TestCommand "node --version"
winvm script -i NAME $T/set-registry.ps1 -- -Path 'HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem' -Name LongPathsEnabled -Type DWord -Value 1
```

winget is usually missing on winvm images: always give a fallback. Each template's
header documents every parameter. For several steps, use winvm-build-environment.

## Files

```sh
winvm put -i NAME ./app.msi 'C:\work\app.msi'     # a file, or a folder and all in it (folders need the agent)
winvm get -i NAME 'C:\work\logs' ./logs
winvm dir -i NAME 'C:\work' [--all] [--json]      # no path = the Desktop; --places = known folders
winvm mkdir -i NAME 'C:\work\out'
winvm mv -i NAME 'C:\work\a.txt' 'C:\work\b.txt'  # mkdir/mv/cp/rm need the agent and never overwrite
winvm cp -i NAME 'C:\work\out' 'C:\work\out-old'
winvm rm -i NAME 'C:\work\b.txt' [--permanently]  # to the Recycle Bin unless --permanently
```

Quote Windows paths in single quotes. The guest reaches the Mac at `10.0.2.2`
(serve big files with `python3 -m http.server 8000 --bind 127.0.0.1`, fetch with
`curl.exe`), and has internet access.

## Shared folder and Finder

```sh
winvm share -i NAME set ~/Projects [--letter Y] [--readonly]   # Mac folder as Z: (default); applies at next start
winvm share -i NAME status [--json]
winvm share -i NAME clear
winvm share -i NAME install --restart     # once, on machines made before shared folders (restarts Windows twice)
winvm files -i NAME open [c|home] [--path 'C:\work']   # Windows' home folder or C:\ in Finder, for the user
winvm files -i NAME status [--json]       # mount, unmount: same targets
```

One shared folder per machine; it needs the virtio-gpu display. Changing which
folder needs a restart (`winvm stow` then `winvm start` keeps open windows).
Finder drives mount at `~/winvm/NAME/{C,Home}`. Text clipboard sharing works in
the Mac app only.
