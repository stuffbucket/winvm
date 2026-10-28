---
name: winvm
description: Start here for any task involving winvm, the tool that runs Windows 11 ARM64 virtual machines on an Apple Silicon Mac. Use when a user wants to run, test, reproduce or set something up in Windows from a Mac, mentions winvm, a Windows VM, Windows image, Windows machine, instance, checkpoint or save. Covers the vocabulary, how to target the right machine (-i, WINVM_INSTANCE, WINVM_HOME), --json and exit codes, the safety rules, and which winvm-* skill handles each job.
compatibility: winvm runs only on macOS 15+ on Apple Silicon. Agents on other systems must run winvm commands on that Mac (for example over ssh).
---

# winvm

winvm runs Windows 11 ARM64 virtual machines on an Apple Silicon Mac, from the
`winvm` command or the winvm Mac app (which shares the same state). The guest
logs on by itself as the built-in Administrator with UAC off, so it is for
testing, not for anything private.

## Words

| Say to the user | The CLI says | What it is |
|---|---|---|
| Windows image | image (`--image`, default `win11-arm64`) | A read-only installed Windows, built once (~20 min). |
| Windows machine | instance (`-i NAME`, default `default`) | A copy-on-write machine on an image. Many per image. |
| checkpoint | save (`save`, `load`, `saves`) | The whole running machine (RAM, disk, firmware) in files. Survives restarts. |
| snapshot | snapshot (`snapshot`, `rewind`) | A quicker checkpoint kept inside the machine's own disk file. |
| baseline | the save named `baseline` | Taken automatically the first time a machine starts. |
| golden | a `--fast` save, usually `golden` | A settled checkpoint that CI jobs reset to in about a second. |

## Target the right machine

- Pass `-i NAME` on every command. Without it winvm uses `WINVM_INSTANCE`, else
  `default`, which is usually the user's own machine.
- `WINVM_HOME` picks the state folder (default `~/.local/state/winvm`); the app
  uses the default. Images, machines and checkpoints live there.
- `winvm ls --json` lists images and machines; `winvm status -i NAME --json`
  says what one is doing. Never guess a name.
- Other variables: `WINVM_IMAGE`, `WINVM_ISO`, `WINVM_RUNTIME` (QEMU runtime
  folder), `WINVM_NO_AGENT=1` (force the slower qemu-ga channel).

## Output and exit codes

- `--json` gives machine-readable output on `ls`, `status`, `doctor`, `saves`,
  `agent status|connect`, `dir`/`mkdir`/`mv`/`cp`/`rm`, `ocr`, `toasts`, `ui`,
  `mcp`, `terminal --shells`, `files status`, `share`, `settings`, `skills`.
- 0 is success. 1 is a failure, explained on stderr as `::error::...`. 2 is a
  usage error (unknown command or missing argument).
- `exec` and `script` exit with the Windows program's own code; 124 means it
  hit `--timeout` (default 900 s) and was killed with its children.
- `ocr --find`, `toasts` with a filter, and `ui find|wait` exit 1 when nothing
  matches: use that as an assertion.

## Safety rules

1. Never run `destroy`, `reset`, `rmi`, `prune`, `saves rm` or `kill` without
   the user's say-so for that machine. They throw work away.
2. Checkpoint before a risky change (`winvm save before-X -i NAME --note "..."`),
   and roll back with `winvm load before-X -i NAME` if it goes wrong.
3. Don't start, stop, change or load checkpoints into `default` (or any machine
   the user did not name) unless the user says so. Make your own machine instead.
4. Don't run `setup`, `build`, `mcp install`, `timemachine`, `skills install`
   or `share set` without asking: they download gigabytes or change the user's
   Mac settings.

## MCP tools

If tools named like `winvm-<machine>` (`screenshot`, `click`, `type`, `key`,
`run`, `list_files`, `copy_to_windows`, `copy_from_windows`, `status`, ...) are
available, prefer them for looking at the screen, clicking and quick commands.
They cannot start, stop or checkpoint a machine: use the CLI for that.
Set them up with the winvm-gui skill.

## Which skill

| Job | Skill |
|---|---|
| Nothing installed yet, first image, first start, something fails | winvm-first-run |
| List, create, start, stop, pause, sleep, restart, remove, resize machines | winvm-machines |
| Checkpoints, snapshots, baseline, golden, rolling back | winvm-checkpoints |
| Commands, scripts, files, installs and settings inside Windows | winvm-inside-windows |
| Screenshots, clicking, typing, UI Automation, OCR, computer use, MCP | winvm-gui |
| "Set up Windows with X, Y and Z" and keep it reproducible | winvm-build-environment |
| CI jobs: `winvm run`, `winvm test`, `--pool` | winvm-ci-jobs |

Every command and flag: [references/commands.md](references/commands.md)
(generated from winvm's own usage text), or `winvm help`.
