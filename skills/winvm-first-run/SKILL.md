---
name: winvm-first-run
description: Use when winvm has never been set up on this Mac, or setup is half done or failing. Checks the host (winvm doctor), installs prerequisites (winvm setup), finds the Windows 11 ARM64 ISO, builds the Windows image (winvm build, about 20 minutes), starts the first Windows machine, and explains failures with winvm diagnose.
compatibility: macOS 15+ on Apple Silicon only. Needs about 15 GB free plus space per machine.
---

# First run

Read the winvm skill first for names and safety rules.

## 1. Is it set up already?

```sh
winvm doctor --json        # host prerequisites; exit 1 if any is missing. Changes nothing.
winvm ls --json            # images and machines that already exist
```

If `ls` shows an image, skip to step 4. If `winvm` is not found: in the Mac app,
choose **winvm > Install Command Line Tool…** (links `~/.local/bin/winvm`); or
from a source checkout run `mise install && pnpm install`, then
`mise exec -C <repo> -- winvm ...`.

## 2. Prerequisites

```sh
winvm setup                # QEMU runtime (source checkouts only), guest tools, PowerShell 7 installer
```

Ask first: it downloads a few hundred MB.

## 3. The ISO and the image

Windows 11 **ARM64**, English (United States), from
<https://www.microsoft.com/en-us/software-download/windows11arm64> (no sign-in;
the link lasts 24 hours). x64 ISOs are refused. The user downloads it; keep it
out of `~/Downloads` and `~/Desktop` (macOS privacy prompts). winvm finds it
from `--iso`, then `WINVM_ISO`, then a single `*arm64*` ISO in `~/vm/` or `~/isos/`.

```sh
winvm build --iso ~/vm/Win11_25H2_English_Arm64.iso                  # once, ~20 min, unattended
winvm build --iso PATH --image NAME --payload DIR --bun 1.3.14       # options; see below
```

- Run it in the background and wait; don't interrupt it. It refuses to replace an
  existing image, or one a machine uses.
- `--payload DIR` copies DIR into `C:\payload` of every machine made from the
  image (`.zip`s expanded, `C:\payload\setup.ps1` run). `--bun VER` adds that Bun.
- `winvm rmi NAME [--force]` removes an image (ask first).

## 4. First machine

```sh
winvm start -i NAME                 # creates it if absent; ~35 s to the desktop
winvm agent status -i NAME          # "no agent" or "not answering"? then:
winvm agent install -i NAME         # images without the in-guest agent (~15 s, once)
winvm exec -i NAME -- cmd /c ver    # proves it works
winvm open -i NAME                  # show the user the screen (Screen Sharing; --web for a browser)
```

The first `start` takes the `baseline` checkpoint once Windows has logged on.
Pick a new name rather than using `default` unless the user wants that one.

## Optional, ask first

```sh
winvm timemachine --yes             # keep the big VM files out of Time Machine
winvm mcp install claude-code -i NAME   # see winvm-gui
```

## When something fails

```sh
winvm diagnose -i NAME     # reads the machine's own files and explains known failures; exit 1 on errors
winvm status -i NAME       # running?, agent?, clock, saves, watcher
```

- `doctor` failing: run `winvm setup`, then `doctor` again.
- Guest tools checksum mismatch in `setup` or `build`: UTM published a new build;
  report it, don't work around it.
- After updating winvm, stop and start running machines and run `winvm web --stop`.
- Logs: `$WINVM_HOME/instances/NAME/` (`watch.log`, `events.jsonl`).
