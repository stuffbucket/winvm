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
| `qemu`, `swtpm`, `zstd` | `bun winvm.ts setup` installs them with Homebrew, or `brew install qemu swtpm zstd` |
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
bun winvm.ts setup                       # brew install qemu swtpm zstd; fetch guest tools
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
bun winvm.ts status                      # running? guest version, clock, saves, watcher
bun winvm.ts open                        # the screen, in macOS Screen Sharing
bun winvm.ts open --web                  # the screen + status + buttons, in the browser
bun winvm.ts diagnose                    # explain a guest that misbehaved
bun winvm.ts config                      # idle watcher settings (see below)
```

`--bun <version>` is optional; it stages that Bun release in the image at
`C:\payload\bun-windows-aarch64\bun.exe` (on PATH). Use `-i <name>` for
additional, independent instances backed by the same image, and
`--ephemeral` on `start` to discard everything on exit.

An instance keeps the image it was created with; pick one for a new instance
with `--image <name>` or `WINVM_IMAGE` (default `win11-arm64`). Recommended:
`win11-arm64-v4`: the agent baked in (v3 had an older one, which `ensure`
replaces with a ~7 s install), no Start menu or firewall prompt on screen, and
`launch` able to start console programs such as PowerShell scripts.

Every image also gets PowerShell 7 (`pwsh`, native ARM64), precompiled .NET
native images (so Windows PowerShell starts fast too), Windows Update /
indexing / telemetry / maintenance switched off, Defender exclusions for
`C:\work` and `C:\payload`, and a logon task that closes audit mode's Sysprep
dialog. What and why, with measurements:
[`docs/windows-vm-qemu.md`](docs/windows-vm-qemu.md#what-the-image-carries-and-why-it-is-quiet).
`build` refuses an `--image` name that already exists or that any instance
still names, so building never replaces a base that overlays depend on.

## Seeing the screen, and driving it without one

`winvm status [-i name]` is the one-screen summary: running / paused / stopped
/ stowed, uptime, Windows version, whether the guest agent answers, the guest
clock's offset from the host, CPU/RAM, display, overlay disk use, saves, the
idle watcher, and Time Machine. It runs no PowerShell, so it takes about a
second. With no `-i` and several instances it prints a table; `--json` for
scripts.

**For a person:**

- `winvm open` opens the screen in macOS Screen Sharing.
- `winvm open --web` opens it in the browser instead, with the status and
  buttons beside it (start, stop, pause, resume, save, load, stow, Ctrl+Alt+Del,
  screenshot). Each button runs the CLI (`bun winvm.ts <verb> -i <name>`) and
  shows its output. The page is served by `winvm web`, which `open --web` starts
  in the background (`winvm web --stop` stops it); it uses a vendored copy of
  [noVNC](https://novnc.com) talking to QEMU's own websocket listener.

The VNC server has a password. **macOS Screen Sharing won't connect to a VNC
server that offers no authentication** — it asks for a password and then fails
— so QEMU runs with `password=on`, gets a random 8-character password over QMP
as soon as it starts (kept in `<instance>/vncpassword`, mode 0600), and `open`
passes it in the URL (`vnc://:<password>@127.0.0.1:5901`), so nothing prompts.
The password also keeps other pages in your browser from reaching the screen
through the websocket. To connect another VNC client by hand:
`bun winvm.ts open --print` prints the URL.

The browser view is loopback-only and needs a token that's random per server
start: `open --web` puts it in the URL's `#fragment`, and every request to the
server must carry it, so other web pages can't drive the VM. `WINVM_WEB_PORT`
changes the port (default 5690).

**For a script or an agent — no window at all:**

```sh
bun winvm.ts screenshot              # PNG under <instance>/screenshots/, prints the path
bun winvm.ts screenshot shot.png
bun winvm.ts click 412 300           # screenshot pixels; --right, --middle, --double
bun winvm.ts move 412 300
bun winvm.ts scroll 5                # wheel notches, positive is down (scroll up 5)
bun winvm.ts key win-r               # combos: ctrl-alt-delete, alt-f4, enter, f5 ...
bun winvm.ts type "notepad"          # US layout; a newline presses Enter
```

These go through QEMU's monitor (`screendump`, `input-send-event` on the USB
tablet and keyboard), so coordinates are exact and nothing needs a display.
Input goes wherever the guest's focus is — take a screenshot first.

**Reading app UI.** `ui` finds and clicks elements by their UI Automation
names — any window, the tray icon and its menu, dialogs, WebView2 content —
`webview` drives WebView2 windows (Tauri apps) over DevTools, `ocr` /
`click --text` read and click the screen's text, and `toasts` lists the
notifications apps raised; in jobs, `shell: winvm` steps run them on the host.
See [`docs/gui.md`](docs/gui.md).

```sh
bun winvm.ts ui tray Maximal --menu Settings      # tray icon by tooltip, then the menu item
bun winvm.ts ui wait --window Settings --name Account --type Text
bun winvm.ts ui click --window Settings --name Models
bun winvm.ts webview enable maximal-shell.exe     # then start the app
bun winvm.ts webview text 'h2.section__title' --target /ui/settings
bun winvm.ts click --text "Cancel"
bun winvm.ts toasts --app maximal --since 10m
```

**Screen size.** The default display is `ramfb`, a firmware framebuffer that
EDK2 fixes at 800x600. For a bigger screen, switch an instance to virtio-gpu:

```sh
bun winvm.ts display -i ui 1920x1080   # stopped or running: records the device
bun winvm.ts stop -i ui && bun winvm.ts start -i ui
bun winvm.ts display -i ui 1920x1080   # sets Windows' resolution, reboots the guest
```

The second run is needed because Windows starts a new monitor at the driver's
1024x768 and has no command-line way to change it; `display` writes the size
into Windows' saved display configuration over the guest agent and reboots.
The `viogpudo` driver comes from the guest tools already in the image, so no
rebuild. **Changing the display device makes that instance's existing snapshots
and saves unrestorable** (QEMU refuses them; nothing is damaged) — switch back
with `display ramfb`. `winvm display` alone shows the current setting.

## Saves

Like a game's save files: the whole running machine (RAM, devices, disk,
firmware variables) written to a directory you can list, keep across restarts,
and load later, whether or not the guest is running.

```sh
bun winvm.ts save before-install        # ~6 s; name defaults to a timestamp
bun winvm.ts load before-install        # ~4 s running, ~10 s stopped
bun winvm.ts save --fast clean          # mapped-ram: ~7 s to take, ~0.5 s to load
bun winvm.ts saves                      # name, kind, format, created, size, compatible
bun winvm.ts saves rm before-install
bun winvm.ts pause / resume             # freeze the vCPUs / carry on
bun winvm.ts stow                       # save and shut QEMU down, freeing the host
bun winvm.ts start                      # ...then this recalls the stow in seconds
bun winvm.ts clock                      # guest-vs-host offset, and fix it
```

- **Baseline.** An instance's first `start` (and the first after `reset`) saves
  `baseline` once the guest is logged on. `rewind` with no snapshot named
  "fresh" goes back to it. `--no-autosave` skips it — only it: the watcher's
  idle autosaves are `config autosave.enabled=false`.
- **Storage.** `~/.local/state/winvm/saves/<instance>/<name>/`: `manifest.json`,
  `vmstate.zst` (zstd'd QEMU migration stream), plus APFS clones of the overlay
  and NVRAM, which cost little until the instance overwrites what they share.
  `destroy` removes an instance's saves with it; `destroy --keep-saves` keeps
  them, and `load` then recreates the instance from one.
- **Formats.** `--format zstd` (default) is ~5x smaller and loads in ~2.5 s.
  `--fast` (`--format mapped`: QEMU mapped-ram + multifd, `vmstate.mapped`) is
  uncompressed and slower to write, but restores in ~0.5 s — for a save loaded
  over and over (goldens, test resets). The manifest records the format; `load`
  reads either.
- **Compatibility.** A save loads only into the same virtual hardware, base
  image, firmware and QEMU version. `saves` shows which still do, and `load`
  says what changed when it refuses.
- **Clock.** Restoring, resuming or recalling puts the guest's clock back on
  the host's (it stood still while frozen), and the first boot sets the guest's
  time zone to the host's.
- `snapshot`/`rewind <tag>` still work as before, inside the instance's qcow2.

`zstd` is required (`setup` installs it; `doctor` checks).

The guest boots to **audit mode** as the built-in Administrator, with UAC off.
Do not use it for anything but testing.

## Goldens: resets in about a second

A golden is the state every test job starts from: a `--fast` (mapped-ram) save
taken only once Windows has gone quiet.

```sh
bun winvm.ts golden create -i ci-1     # boot (or --from <save>), settle, save "golden"
bun winvm.ts golden reset  -i ci-1     # back to it: ~1.3 s to a responsive guest
```

`create` waits until QEMU's CPU time stays at or under `--settle-cpu` (3% of
all vCPUs) for every 5 s sample across `--settle-for` (60 s), at most
`--max-wait` (10 min — then it saves anyway and says so). A save taken right
after boot carries Windows' post-boot work with it and replays it on every
load. `reset` loads the golden, waits for a `cmd /c echo` round trip through
the agent, and sets the clock. From code: `createGolden(instance, opts)` and
`resetToGolden(instance, name)` in `golden.ts`, which return per-phase
timings and print nothing.

Measured on an M-series host, 4 vCPU / 4 GiB guest, five resets each, medians
(restored = old QEMU gone, disks cloned back, RAM loaded, running):

| save                        | restored | + responsive | + clock | total  | guest CPU, next 20 s | RAM on disk |
|-----------------------------|---------:|-------------:|--------:|-------:|---------------------:|------------:|
| golden (mapped, settled)    |   602 ms |       206 ms |  459 ms | 1.28 s |             0.6-2.1% |      3.9 GB |
| same state, zstd            |  2734 ms |       206 ms |  556 ms | 3.50 s |             0.8-2.1% |      1.8 GB |
| mapped, just after boot     |   862 ms |       207 ms |  368 ms | 1.40 s |             1.7-3.1% |      3.8 GB |
| zstd, just after boot       |  2545 ms |       125 ms |  663 ms | 3.41 s |             6.9-8.2% |      1.6 GB |

A cold boot to a settled guest took 26 s + 245 s; taking the golden, 6 s.
The clock step varies (10-900 ms) because the guest's clock answers in
~100 ms jumps for a moment after a restore; it ends within ±50 ms.

## The idle watcher

`start` also launches a small background process per instance that watches
for the guest going idle (`--no-watch` skips it; `load` and `rewind` into a
stopped instance start one too, and take `--no-watch` as well). It logs to
`instances/<name>/watch.log`, publishes its state in `watch.json`, and exits
when QEMU does; `stop` ends it first.

- **Idle** means all of these, continuously: QEMU's CPU time below
  `watch.idleCpuPercent` (default 10%) of the guest's vCPUs, averaged over a
  minute; no `winvm exec`/`smoke`/`snapshot` activity; no VNC client
  connected. An idle desktop measures 0.2-1% here, with background bursts
  that one sample can't push over the threshold; one busy thread is 25%.
- **Autosave**: after `autosave.idleMinutes` (10) idle, one save of kind
  `auto` (named `auto-<UTC timestamp>`); another only once the guest has been
  used and gone idle again. The newest `autosave.keep` (3) are kept; manual, baseline and stow
  saves are never touched.
- **Stow**: after `stow.idleMinutes` (60) idle, `winvm stow`, which saves the
  guest and shuts QEMU down. `winvm start` recalls it, and the watcher with it.
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

## CI jobs: `winvm run` / `winvm test`

Job files are GitHub-Actions-shaped YAML (the format is documented at the top
of `job.ts`; `jobs/examples/hello.yml` uses every feature):

```sh
bun winvm.ts run jobs/examples/hello.yml -i ci     # one job
bun winvm.ts test jobs/maximal/ -i ci --junit out.xml --json out.json
```

Every job starts by loading a **golden** (`golden.ts`: a mapped-ram save taken
once the guest has gone quiet; default name `golden`, created on first use with
the in-guest agent installed, the sysprep dialog closed and `C:\work`
present), so each job sees the identical machine. Files are fetched on the
host (release assets via `gh release download`, cached under
`$WINVM_HOME/cache`) and pushed through the agent, or served on loopback and
pulled with one `curl.exe` from `http://10.0.2.2:<port>`; `$env:WINVM_FILES`
is that server, for installers that download their own payload. Steps run
with timeouts, `continue-on-error`, `if: always()`, `background: true`;
failures get a screenshot and the job's `artifacts`
(`$WINVM_HOME/runs/<instance>/<time>/` unless `--artifacts`). The summary
reports reset time against test time and the reset share of the wall clock.

Use a dedicated instance (the default is `ci`): a run resets it before every
job, and quits it afterwards unless `--keep`. Steps run through the in-guest
agent, as the logged-on user in their session (a tray app shows on the
desktop); without one they fall back to qemu-ga, as SYSTEM in session 0
(`%LOCALAPPDATA%` and `HKCU` are SYSTEM's, nothing launched is visible).
`WINVM_CHANNEL=qga` forces the fallback.

`jobs/maximal/` holds end-to-end jobs for Maximal's Windows releases (MSI,
portable zip, install.ps1, NSIS tray app, MCP broker containment); each
downloads the latest release, or `MAXIMAL_TAG=vX.Y.Z`.

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
