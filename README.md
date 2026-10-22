# winvm

A scriptable Windows 11 ARM64 guest on a Mac (Apple Silicon), on plain QEMU +
Hypervisor.framework. Driven entirely from the shell: build a golden image
once, then boot thin copy-on-write instances, run commands in them over the
QEMU guest agent, snapshot them, and rewind a running guest in ~10-20 seconds
(no reboot; ~35 s from stopped).

Built for reproducing Windows-only bugs locally (e.g. testing a
[Maximal](https://github.com/stuffbucket/maximal) build) instead of
pushing and waiting on CI.

The reasoning behind every device and answer-file choice is in
[`docs/windows-vm-qemu.md`](docs/windows-vm-qemu.md). Read it before changing
anything in `qemu.ts` or `assets/`.

## Prerequisites

| | |
|---|---|
| Host | macOS on Apple Silicon (uses `-accel hvf`, `hdiutil`, `newfs_msdos`) |
| [mise](https://mise.jdx.dev) | pins Bun 1.3.14 and pnpm 12.3.4 (`mise.toml`) |
| `qemu`, `swtpm` | `bun winvm.ts setup` installs them with Homebrew, or `brew install qemu swtpm` |
| UEFI firmware | vendored in `firmware/` (gzipped EDK2), expanded into the state dir on first use |
| UTM guest tools ISO | downloaded by `setup`/`build` from getutm.app (~121 MB), pinned by SHA-256 |
| Windows 11 ARM64 ISO | you supply it — see below |
| Disk | ~15 GB for the base image, plus a few hundred MB to a few GB per instance |

UTM.app itself is **not** needed — only its guest-tools ISO (virtio drivers +
`qemu-ga`).

```sh
mise install          # bun + pnpm
pnpm install          # typecheck-only dev deps (registry/auth from ~/.npmrc)
bun winvm.ts doctor   # check the host; changes nothing
```

`pnpm run check` runs the typecheck and the tests (the tests replay recorded
failure traces through `winvm diagnose`; no VM needed).

## The ISO

- **Windows 11, ARM64, multi-edition retail ISO, English (United States).**
  Download it from <https://www.microsoft.com/en-us/software-download/windows11arm64>
  (no sign-in; the generated link expires after 24 h). Microsoft names it like
  `Win11_25H2_English_Arm64_v2.iso`; the tool was developed against 25H2.
- The answer file installs **Windows 11 Pro** (selected by image name, using
  Microsoft's generic, non-activating Pro key) with `en-US` locale. The guest
  stays unactivated, which is fine for a disposable test fixture.
- An x64 ISO is rejected up front (no `\efi\boot\bootaa64.efi`).

Where to put it — any one of:

1. `bun winvm.ts build --iso /path/to/Win11_..._Arm64.iso`
2. `export WINVM_ISO=/path/to/Win11_..._Arm64.iso`
3. Drop it in `~/vm/` or `~/isos/` (or one subfolder below) with `arm64` in the
   file name; `build` finds it if it is the only match.

Avoid `~/Downloads` and `~/Desktop`: they are TCC-protected, so reading from
them pops a macOS permission dialog. The ISO is **symlinked**, never copied, to
`~/.local/state/winvm/media/windows-arm64.iso`; later builds reuse that link.

## Using it

All state lives in `~/.local/state/winvm` (`WINVM_HOME` overrides), never in
this repo. Run from the repo root (or use the `pnpm run <verb>` aliases in
`package.json`).

```sh
bun winvm.ts setup                       # brew install qemu swtpm; fetch guest tools
bun winvm.ts build --iso ~/vm/Win11_25H2_English_Arm64.iso --bun 1.3.14
                                         # once: unattended install, ~10-20 min
bun winvm.ts start                       # boot instance "default" (~35 s to desktop)
bun winvm.ts snapshot                    # checkpoint "fresh" once it is settled
bun winvm.ts exec -- cmd /c ver          # run anything in the guest
bun winvm.ts smoke --expect 1.3.14       # guest arch + staged bun version
bun winvm.ts rewind                      # back to "fresh", no reboot
bun winvm.ts stop                        # orderly shutdown via the guest agent
bun winvm.ts reset                       # discard all changes, back to the base image
bun winvm.ts ls                          # images, instances, VNC ports, disk usage
bun winvm.ts diagnose                    # explain a guest that misbehaved
bun winvm.ts config                      # idle watcher settings (see below)
```

`--bun <version>` is optional; it stages that Bun release in the image at
`C:\payload\bun-windows-aarch64\bun.exe` (on PATH). Use `-i <name>` for
additional, independent instances backed by the same image, and
`--ephemeral` on `start` to discard everything on exit.

To see the desktop: `bun winvm.ts ls` prints each instance's VNC display;
`open vnc://127.0.0.1:5901` for display `:1`.

The guest boots to **audit mode** as the built-in Administrator, with UAC off.
Do not use it for anything but testing.

## The idle watcher

`start` also launches a small background process per instance that watches
for the guest going idle (`--no-watch` skips it). It logs to
`instances/<name>/watch.log`, publishes its state in `watch.json`, and exits
when QEMU does; `stop` ends it first.

- **Idle** means all of these, continuously: QEMU's CPU time below
  `watch.idleCpuPercent` (default 10%) of the guest's vCPUs, averaged over a
  minute; no `winvm exec`/`smoke`/`snapshot` activity; no VNC client
  connected. An idle desktop measures 0.2-1% here, with background bursts
  that one sample can't push over the threshold; one busy thread is 25%.
- **Autosave**: after `autosave.idleMinutes` (10) idle, one `winvm save
  --kind auto`; another only once the guest has been used and gone idle
  again. The newest `autosave.keep` (3) are kept; manual, baseline and stow
  saves are never touched.
- **Stow**: after `stow.idleMinutes` (60) idle, `winvm stow`, which saves the
  guest and shuts QEMU down. `winvm start` brings it back.
- **Clock**: after host sleep (the wall clock jumping between ticks) and
  whenever a 30-minute check finds the guest more than 2 s off, the guest
  clock is resynced.

```sh
bun winvm.ts config -i default                         # effective settings
bun winvm.ts config -i default stow.idleMinutes=120 autosave.keep=5
bun winvm.ts config -i default watch.enabled=false     # no watcher for this instance
bun winvm.ts watch  -i default                         # run it in the foreground instead
bun winvm.ts watch  -i default --status                # or --stop
```

Settings live in `instances/<name>/config.json` (overrides only); a running
watcher picks up changes on its next tick.

## Getting files into the guest (e.g. a Maximal build)

There is no shared folder. Three ways, from most to least convenient:

**1. Over the network, into a running instance.** The guest has outbound
networking through QEMU user-mode NAT, where the host is reachable as
`10.0.2.2`. Serve a directory on the host and pull from the guest:

```sh
# host, in the directory holding the build (e.g. maximal's Windows artifacts)
python3 -m http.server 8000 --bind 127.0.0.1

# guest
PS='C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe'
bun winvm.ts exec -- "$PS" -NoProfile -Command \
  "Invoke-WebRequest http://10.0.2.2:8000/maximal-setup.msi -OutFile C:\maximal-setup.msi"
bun winvm.ts exec -- msiexec /i 'C:\maximal-setup.msi' /qn /l*v 'C:\maximal-install.log'
```

The guest can equally download a release straight from GitHub. Take a
`snapshot` before installing so `rewind` gets you a clean guest again.

**2. Baked into the base image, at build time.** `build --payload <dir>` copies
the directory onto the seed ISO; provisioning expands every `.zip` into
`C:\payload`, copies everything else there, adds every directory containing an
`.exe` to the machine PATH, and runs `C:\payload\setup.ps1` if present. Good for
tools you want in every instance; a rebuild costs a full install.

**3. Small text via the agent.** `exec` passes arguments verbatim, so a short
file can be written with a PowerShell `Set-Content` one-liner.

Fidelity note: this guest is **ARM64**. Maximal's Windows build targets x64,
which runs under Windows' x64 emulation — fine for path, shell, file-locking
and installer bugs, not for timing-sensitive ones. See
[`docs/windows-vm-qemu.md`](docs/windows-vm-qemu.md#fidelity-limits--read-before-trusting-a-result).

## Time Machine

The VM disks are large and change constantly. Keep them out of backups:

```sh
bun winvm.ts timemachine          # report, and offer to exclude each folder
bun winvm.ts timemachine --yes    # exclude without asking
```

It adds Time Machine's sticky exclusion (`tmutil addexclusion`, no sudo) to the
state directory and to the folder holding the ISO; `winvm doctor` reports
whether that's in place. Undo with `tmutil removeexclusion <path>`.

Local Time Machine snapshots are a different thing: they cover the whole APFS
volume and ignore exclusions, so each one keeps disk blocks the VM has since
overwritten until macOS removes it (usually within 24 hours). The command lists
them and prints how to remove them; it doesn't remove them itself.

## Troubleshooting

Start with `bun winvm.ts diagnose [-i name]`; see the troubleshooting section of
the design notes. If you get stuck, Linaro's reference is the closest upstream
match for this setup:
<https://linaro.atlassian.net/wiki/spaces/WOAR/pages/28914909194/windows-arm64+VM+using+qemu-system>

If the QEMU process is still running and QMP `info status` reports `running`,
but the OS intermittently fails to boot after a long wait, watch the guest with
`top -pid $(cat ~/.local/state/winvm/instances/<name>/qemu.pid)` — a square
wave, CPU spiking and then settling back down, means it stopped early; check
whether the serial output stopped prematurely and check hardware device
firmware in the VM.

If `setup` or `build` reports that the guest-tools ISO does not match its pin,
upstream has published a new build: review it, then update `TOOLS_SHA256` in
`host.ts`.

## Provenance

Extracted from `stuffbucket/monimal`
(`packages/maximal-core/scripts/dev/win11/`, design notes from
`packages/maximal-core/docs/dev/windows-vm-qemu.md`) with `git subtree split`,
so the history of that directory is preserved. MIT licensed (see `LICENSE`);
third-party notices in `THIRD-PARTY-LICENSE.md`.
