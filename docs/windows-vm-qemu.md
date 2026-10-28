# How the VM is configured

winvm runs a scriptable Windows guest on a Mac, for bugs that only appear on
Windows. Everything is driven from the shell. For setup and day-to-day use,
start with the [README](../README.md). This file records why the tool is built
the way it is.

```sh
winvm setup                          # install prerequisites, fetch pinned media
winvm doctor                         # check prerequisites without changing anything

# once: build the golden base image (~20 min)
winvm build --iso ~/vm/Win11_25H2_English_Arm64.iso --bun 1.3.14

winvm start                          # boot an instance (creates it if absent)
winvm smoke --expect 1.3.14          # assert the staged bun is that version
winvm exec -- bun --version          # run anything in the guest

# rewind to a known-good guest without rebooting
winvm rewind                         # back to "fresh"
winvm snapshot ready                 # or take your own checkpoint

winvm reset                          # discard everything, back to the base image
winvm stop

winvm ls                             # images, instances and media, with a total
winvm prune                          # remove leftover build scratch instances
winvm rmi <image>                    # remove a base image
```

## Dependencies

| | |
|---|---|
| QEMU, `swtpm`, `zstd` | the winvm runtime, fetched by `winvm setup` |
| UEFI firmware | **vendored** in `packages/core/firmware/`, gzipped, expanded into the state directory on first use |
| UTM guest tools | **downloaded and pinned by SHA-256**, not vendored |
| viofs (virtio-win) and WinFsp, for the shared folder | **downloaded and pinned by SHA-256** when an image is built or `winvm share install` runs (`sharemedia.ts`) |

The runtime is a tarball from
[stuffbucket/winvm-runtime](https://github.com/stuffbucket/winvm-runtime),
pinned by version, URL and SHA-256 in `packages/core/runtime.json`. It carries
QEMU 11.1.2, built from source with an HVF patch, plus `swtpm` and `zstd`.
Homebrew QEMU is not used. `winvm setup` unpacks it into
`~/.local/share/winvm/runtime/<version>` and checks every file against the
runtime's `manifest.json`. `WINVM_RUNTIME` points winvm at a different runtime
directory.

The two firmware images are 64 MiB each and almost all zero padding, so they
take 1.6 MB gzipped. They are vendored so the harness does not depend on how a
particular QEMU package lays out its data files. `WINVM_QEMU_DATA` overrides
the vendored copy, and `doctor` prints the path it resolved.

The guest-tools ISO is not vendored. It is about 121 MB and does not compress.
Its installer also bundles `qemu-ga`, which is GPL-2.0, so shipping it would
oblige this project to keep the corresponding source available. `build`
downloads it from a versioned UTM release (`TOOLS_URL` in `host.ts`) and
verifies it against `TOOLS_SHA256`. To move to a new guest-tools build, review
the new ISO and update both constants. Licences for both live in
[`THIRD-PARTY-LICENSE.md`](../THIRD-PARTY-LICENSE.md).

## Why this exists

Before winvm, the only Windows available was CI's `windows` job. Each Windows
defect cost a push and a CI round trip. Examples: a `prepare` script Bun's
Windows shell could not parse, a Windows-only secrets-loader bug, a SQLite
handle leak that shows up as `EBUSY` only where an open handle locks the file,
a shebang fixture, and a `RegExp` built from an interpolated `os.tmpdir()` with
the `u` flag. That last one is harmless on POSIX and a `SyntaxError` on
Windows.

## The tool is not part of any project

This repo is self-contained and works for any project. It reads no manifest,
version file or other file from the project that uses it. Project-specific
inputs are passed in:

- `--payload <dir>`: files to stage inside the guest
- `--bun <version>`: fetches that exact Bun release asset
- `--expect-file <path>` / `--expect <v>`: what `smoke` should assert

The caller supplies its own pin. For example, from a Maximal checkout:
`winvm smoke --expect-file .bun-version`.

## One base image, many thin instances

A Windows install is about 15 GB, so a copy per consumer is not practical. The
base image is built once and never written again. Each instance is a qcow2
**overlay** backed by it, holding only its own changes.

Measured on this machine:

| | |
|---|---|
| base image | 15 GB, read-only |
| build, from an empty state dir | **~8 min** |
| first boot to a usable guest | **~35 s** (audit mode; no OOBE) |
| instance after first boot | ~200 MB, plus ~3 GB once it holds snapshots |
| `reset` (back to the base) | **1.3 s** |
| `snapshot` | **1.4 s** |
| `rewind` (back to a snapshot) | **~10 s, no reboot** |

`rewind` returns only after the guest agent answers again, so it takes longer
than `loadvm` itself. See the warning about sleeping after a restore, below.

This design gives three properties:

- **Reset** deletes the overlay and creates a new one with `qemu-img create`.
  It is instant, returns exactly the base state, and needs no reinstall. Reset
  also discards firmware variables and TPM state, which live outside the disk
  image and would otherwise survive.
- **Concurrency.** Instances share one base and never touch each other. Each
  gets its own overlay, firmware variables, TPM state, sockets and VNC display,
  allocated at creation. This was verified by running two guests at once and
  confirming that a file written in one is absent in the other.
- **Debugging.** An instance persists across stop and start, so you can inspect
  a broken guest and reset it only when you are finished.

`--ephemeral` adds QEMU's `-snapshot`, so even the overlay is left untouched and
the run is discarded on exit.

## Rewinding

`reset` returns an instance to the base image, which means a full boot
afterwards. A **snapshot** is cheaper. It captures the running machine,
including RAM, and restoring it is not a reboot. The guest resumes from the
point where the snapshot was taken.

```sh
winvm start
winvm snapshot                  # capture "fresh" once the guest is how you want it
winvm exec -- <break things>
winvm rewind                    # the guest is clean and running again
```

**Take the snapshot yourself, once the guest is settled.** `start` does not take
a snapshot. Snapshotting a Windows guest that is still booting **livelocks it**:
four vCPUs at 100%, no disk I/O, and no recovery except `kill` and `reset`. A
snapshot taken that early would also capture a machine that had not finished
starting.

For the same reason, `winvm snapshot` refuses to run against a guest that is
not ready. Take `fresh` again whenever the guest reaches a new state worth
returning to, or keep several tags and rewind between them. `start` does take
one automatic checkpoint, the file save `baseline`, on an instance's first boot.
It does so only after `waitReady` has seen the real account log on. See *Saves*.

`rewind` also works on a stopped instance. It starts QEMU directly into the
saved state (`-loadvm`) and skips the boot.

Snapshots required three device changes. Without each one, `savevm` refuses and
names the device:

| device | refusal | fix |
|---|---|---|
| NVMe boot disk | `non-migratable` | virtio-blk (see *Design decisions*) |
| raw pflash NVRAM | `writable but does not support snapshots` | qcow2 NVRAM |
| writable result volume | same | not attached to a running instance |

**After a rewind, wait for the guest. Do not sleep.** `loadvm` returns as soon
as QEMU has restored the state, which is *before* the guest agent can serve a
command. If a fixed sleep is slightly too short, a command can be answered from
before the restore. A rewind that worked then looks like one that changed
nothing. `winvm rewind` polls the agent instead.

The base image is `chmod 444` after it is built. Writing to a backing file while
overlays reference it corrupts all of them, and the damage shows up later and
elsewhere.

## Saves: the machine as files

The verbs are `winvm save` / `load` / `saves` / `stow` / `pause` / `resume`.
See `saves.ts` for the format and `savecmds.ts` for the verbs. A save is a
directory under `$WINVM_HOME/saves/<instance>/<name>/`:

| file | what |
|---|---|
| `manifest.json` | `{name, instance, kind: manual\|auto\|baseline\|stow\|golden, createdAt, bytes, compat, image, note?}` plus `compatParts`, `ramFile`, `ramBytes`, `saveMs`, `format` |
| `vmstate.zst` | RAM and device state: a QEMU **migration stream**, `zstd -T0 -3` (`vmstate.mapped` or `vmstate.bin` for the other RAM formats in `saves.ts`) |
| `overlay.qcow2`, `efi-vars.qcow2` | the instance's disk and NVRAM at that moment, as APFS clones (`cp -c`) |

**Why a migration stream.** QEMU 11.1 cannot `savevm` to a path. A migration to
an `exec:` or `file:` URI is the only whole-machine state that can be written
outside the qcow2. It needs the same devices as `savevm` (virtio-blk and qcow2
NVRAM; the result volume is not attached to a running guest), so every image
that can `snapshot` can `save`. TPM state needs no separate file. The
tpm-emulator backend carries swtpm's state in the stream and pushes it back on
load. This was verified: `Win32_Tpm` reads enabled, owned and ready after
loading into a re-created instance.

**Consistency.** A save runs QMP `stop` first, which drains and flushes every
block device, including qcow2 caches. It then migrates, clones the disks while
the guest is still stopped, and runs `cont`. A stream can only be fed to a QEMU
started with `-incoming`, so a load always restarts QEMU. Loading into a
running guest quits QEMU, clones the save's disks back, starts QEMU with
`-incoming "exec:zstd -dc …"`, and runs `cont`. The stream records that the
source was paused, so the destination comes up paused and is continued
explicitly.

**Compatibility.** `compat` hashes four things: the base image's identity
(name, size, mtime and recorded build time, never its 14 GB of content); the
QEMU arguments with paths, ports, `-snapshot` and `-rtc` removed; the firmware
code image; and the runtime's QEMU version and patch set. `load` refuses a
mismatch and names the part that changed.

**Baseline.** The first `start` of an instance saves `baseline`, but only after
`qga.waitReady`, never during boot or OOBE, because of the livelock described
under *Rewinding*. It is skipped with `--no-autosave` or `--ephemeral`, for an
image that cannot boot on virtio-blk, and when a compatible `baseline` already
exists. A reset instance keeps its baseline. `build` does not take one: its
guest is the throwaway install VM on non-migratable NVMe, and it is deleted when
the image is sealed.

**`rewind` and saves.** `rewind [tag]` uses an internal snapshot of that tag
when one exists (default `fresh`). Otherwise it loads the save of that name, or
`baseline` when no tag is given. So `rewind` works on a new instance with no
snapshots.

**Stow.** `stow` saves as `stow` and quits QEMU. The next `start` loads it
instead of booting, then deletes it. Any other `load`, a `rewind` or a `reset`
discards it, so an old stow never overrides newer state. `start --boot`
discards it and boots cold.

Measured on this host (load average 30-120 throughout, 4 GiB guest):

| | |
|---|---|
| save, zstd | 5-9 s guest stopped; RAM stream 3.0-3.8 GB -> 1.2-1.6 GB |
| save, raw (`file:`) | 3.8 s guest stopped; 3.4 GB |
| ready check before a manual `save` | ~22 s (`--force` skips it; a paused guest skips it) |
| load, running | 4-11 s (zstd); raw no faster here (6.8 s vs 8.5 s back to back) |
| load, stopped | 12-16 s |
| stow | 6.2 s |
| recall (`start` with a stow) | 8.5 s, vs ~2 min cold boot to ready on this host |

## The guest clock

The guest clock had two separate faults. Both are fixed:

- **Cold boot was hours off.** The answer file sets the guest's time zone to
  UTC, and Windows reads the RTC as local time. QEMU was started with
  `-rtc base=localtime`, which gave the guest the host's wall clock labelled as
  UTC. Measured on a Pacific host: **-7h 0m 1s**. QEMU now runs with
  `-rtc base=utc,clock=host`: **-0.85 s** on a cold boot.
- **Every freeze leaves the clock behind.** Windows keeps time from the virtual
  counter, which stops while the machine is stopped. It reads the RTC only at
  boot. The PL031 RTC is correct after a restore, but nothing reads it. So after
  `load`, `resume`, a save, a stow recall and `rewind`, `clock.ts` sets the time
  through the agent (`guest-set-time` with UTC nanoseconds; qemu-ga on Windows
  requires the value). `winvm clock` does this on demand; `--check` only reports
  the offset.

Time zone: the first boot (and `winvm clock`) sets the guest's time zone to the
host's. The IANA name is mapped by the host's own ICU
(`ucal_getWindowsTimeZoneID` in libicucore). It also sets
`RealTimeIsUniversal=1` so the UTC RTC stays correct in any zone.

| event | before | after |
|---|---|---|
| cold boot (old `-rtc base=localtime`) | -7h 0m 1s | n/a |
| cold boot (`base=utc`) | -853 ms | +40 ms |
| `pause`, 2 min, `resume` | -2m 4s | +149 ms |
| `load` of a 9-minute-old save, running | -9m 17s | -1 ms |
| `load` of a 12-minute-old save, stopped | -12m 25s | -12 ms |
| recall after stow | -24.2 s | +50 ms |
| `rewind` to an internal snapshot | -10.7 s | +76 ms |

The remaining error is about ±100 ms. qemu-ga is an emulated x64 binary, and its
latency on a loaded host dominates.

## The idle watcher

`start` launches `winvm watch` detached, one per instance. It holds `watch.pid`,
created with O_EXCL. A pidfile whose process is gone, or is no longer a watcher,
is treated as stale and replaced. The watcher samples every 15 s. The decisions
are in `idle.ts`, which is pure and unit-tested; `watch.ts` does the I/O. Its
rules, and why:

- **CPU is read from the host**, as QEMU's process CPU time (`ps -o time=`)
  over wall time, divided by the `-smp` count. QMP's `query-cpus-fast` reports
  no time, and asking the guest costs a PowerShell launch (~20 s here).
  Measured on this guest (4 vCPUs, host at load average ~90): an idle desktop
  uses 0.2-1% per 15 s sample, with background bursts of 3-17% for a single
  sample and a worst idle 1-minute average of ~5.5%. One busy thread is 25%;
  four are 97-101%. The threshold is 10% of a **1-minute average**, so a burst
  does not restart the idle clock, and half a minute of one busy thread does.
- **Commands are activity.** `exec` touches `instances/<name>/activity` when it
  starts, every 15 s while it runs, and when it ends. `smoke`, `snapshot` and
  `rewind` touch it too.
- **A VNC client is activity.** `query-vnc` lists connected clients but not
  whether anyone is typing. Saving or stowing during a live session is the
  wrong default, so any connected client blocks idleness. Measuring input idle
  inside the guest (`GetLastInputInfo`) would need a process in the user's
  session, and qemu-ga runs as SYSTEM in session 0.
- **The watcher's own saves are not activity.** CPU is ignored for a minute
  after any action the watcher takes. Otherwise each autosave would trigger the
  next one.
- **Host sleep is detected as a wall-clock jump.** Between ticks the watcher
  compares the `Date.now()` delta to the interval it slept. A gap of 45 s or
  more beyond that is a sleep; a loaded host delays timers by seconds, not
  minutes. Timer counts and monotonic clocks are not used, because whether they
  advance during sleep differs by clock. On wake, the watcher resyncs the guest
  clock and restarts the idle timer, so time with the lid shut never counts
  towards stowing.
- **Drift is measured with `measureOffset`** (`clock.ts`; `guest-get-time`,
  native, a few ms) every 30 min, and resynced with `syncGuestClock` when it
  exceeds 2 s. A paused guest is skipped, because its agent cannot answer.
- **A paused or asleep guest is left alone.** Its CPU reads as idle, but only
  the user resumes it: while QEMU's run state is `paused`, `suspended` or
  `postmigrate` (a save of a paused guest ends there), the watcher neither
  autosaves nor stows it, and the time does not count as idle. The idle clock
  starts again on resume, so a guest paused for hours is not stowed the moment
  it runs again.
- **Autosave is an in-process `saves.createSave`** (kind `auto`) under
  `saves.withLock`, followed by a clock sync, because the guest was stopped
  while it was saved. If another save or load holds the lock, the round is
  skipped. Rotation deletes only kind `auto`, oldest first, down to
  `autosave.keep`.
- **Stow runs `winvm stow`** as a child process. `stow` and `stop` end the
  watcher first, except when the watcher is the caller.
- **A `load` replaces QEMU.** The watcher follows the new process and restarts
  its idle clock instead of exiting. It exits only once QEMU is gone and no save
  or load holds the instance. `load` and `rewind` count as activity. A save does
  not, or every autosave would trigger the next.
- **`start` launches the watcher after the first-boot baseline save**, so that
  save is not counted as use. An `--ephemeral` guest cannot be saved, so its
  watcher only keeps the clock.

## Selecting an image and instance

| | flag | env | default |
|---|---|---|---|
| state dir | n/a | `WINVM_HOME` | `~/.local/state/winvm` |
| instance | `-i` | `WINVM_INSTANCE` | `default` |
| image | `--image` | `WINVM_IMAGE` | `win11-arm64` |

Give each concurrent consumer its own instance name. They share the base image
automatically.

## Host dependencies

| Dependency | Install | Why |
|---|---|---|
| Apple Silicon, macOS 15 or later | n/a | `doctor` refuses anything else |
| winvm runtime | `winvm setup` | `qemu-system-aarch64`, `qemu-img`, `swtpm`, `zstd`, pinned in `runtime.json` (see *Dependencies*) |
| | | `WINVM_RUNTIME` overrides the runtime directory. Firmware is looked up in `WINVM_QEMU_DATA`, then the vendored copy, then the directories the runtime's QEMU reports with `-L help`. `doctor` prints the firmware path it found. |
| `swtpm` | in the runtime | **Required.** Windows 11 requires TPM 2.0. Without one, the only way past Setup is the LabConfig bypass, which is an unsupported configuration. |
| `hdiutil`, `newfs_msdos` | macOS built-in | Seed ISO and FAT result volume. No `xorriso`/`mkisofs` needed. |

`winvm doctor` checks the macOS version and architecture, the runtime, the
firmware and `hdiutil`, and names what is missing.

## Getting the ISO

You are asked for the ISO once. `build` looks in this order: `--iso`,
`$WINVM_ISO`, the ISO a previous build recorded, then `~/vm`, `~/isos` and the
media directory in the state directory for a file whose name contains `arm64`.
Only then does it prompt, and only when a terminal is attached. A scripted
build fails and says what it needs instead of waiting for input.

It never looks in `~/Downloads` or `~/Desktop`. Those folders are TCC-protected,
and reading them raises a consent dialog against whichever terminal runs the
build. Keep the ISO anywhere you like and name it with `WINVM_ISO`; you can set
that once in a shell profile.

The ISO is **symlinked** into the state directory, never copied and never
committed. At about 8 GB, it stays your file wherever you keep it.

The media is checked for `\efi\boot\bootaa64.efi` before anything starts, so an
x64 ISO fails in a second instead of twelve minutes into the install.

Download it from
<https://www.microsoft.com/en-us/software-download/windows11arm64>: multi-edition
ARM64, no Microsoft account needed. **The generated link expires after 24
hours**, so it cannot be written into a script.

The guest installs **Windows 11 Pro**, selected by name (`/IMAGE/NAME`) instead
of WIM index, because index order can differ between ISO builds. It runs
unactivated, which is permitted indefinitely and suits a disposable fixture.

## Design decisions, and the evidence

Most of these choices come from UTM's source, which is the best available record
of what works for this guest on this hardware.

**The boot disk uses NVMe while installing and virtio-blk while running.** The
two reasons are unrelated.

*Installing on NVMe.* Windows 11 ARM64 has an in-box NVMe driver
(`stornvme.sys`), so Setup sees the disk with nothing injected. UTM's wizard
uses NVMe for aarch64 Windows guests, instead of the virtio default it uses for
every other guest. WinPE has no virtio-blk driver, so installing onto virtio
would mean injecting `viostor` at `windowsPE`. A `<DriverPaths>` entry names a
*drive letter*, and WinPE assigns letters by device enumeration order, so the
letter is not reliable.

*Running on virtio-blk.* QEMU's `nvme` device model has **no migration
support**, so `savevm` refuses: `Device '0000:00:01.0/nvme' is non-migratable`.
Snapshots are impossible while the disk is NVMe. This is a property of the
device model, not of HVF: the same machine with a `virtio-blk-pci` disk
snapshots fine.

The build attaches a scratch virtio-blk disk (`prime.qcow2`) for the duration of
the build only. Its presence makes Windows install `viostor` from the
DriverStore and mark it boot-start (`Start=0`). That is what lets the finished
image boot on virtio-blk. WinPE cannot see a virtio disk, so the scratch disk
cannot interfere with the answer file's `DiskID 0` during Setup.

After provisioning, `build` asks the guest whether `viostor` is boot-start and
records the answer as `virtioBoot` in the image's `image.json`. Images built
before this change have no such record. They keep booting on NVMe, which avoids
an `INACCESSIBLE_BOOT_DEVICE` bluescreen, and `winvm snapshot` tells you to
rebuild.

**A running instance attaches no USB storage.** The install ISO, guest tools,
seed and writable result volume are attached only while building. EDK2 hung
enumerating the result volume when it was attached to an instance. The firmware
console stopped on `UsbBootExecCmd: Success to Exec 0x0 Cmd (Result = 1)` with a
core at 100% and no boot target chosen. This happened on an instance with only
that one USB disk, so the number of disks is not the cause. The CD-ROM device
lines follow [Linaro's published reference][linaro] for this guest:
`usb-storage` with `media=cdrom` on a `qemu-xhci` bus, and no `removable=` flag.

The USB controller is `qemu-xhci`, not `nec-usb-xhci`. QEMU's documentation
recommends XHCI and names the device `qemu-xhci` ([USB emulation][qemuusb]). The
NEC model has an open upstream bug, "[usb3: nec-usb-xhci broken][necbug]",
reported since QEMU 5.2.

[linaro]: https://linaro.atlassian.net/wiki/spaces/WOAR/pages/28914909194/windows-arm64+VM+using+qemu-system
[qemuusb]: https://qemu-project.gitlab.io/qemu/system/devices/usb.html
[necbug]: https://gitlab.com/qemu-project/qemu/-/issues/3241

**swtpm with `tpm-tis-device`.** UTM uses `tpm-crb-device`, which winvm's QEMU
doesn't build for aarch64. Its aarch64 TPM devices are `tpm-tis-device` and
`tpm-tis-i2c`, which needs an I2C bus (`qemu-system-aarch64 -M virt -device
help`, QEMU 11.1.2). With swtpm attached, the firmware log goes from
`Tpm2SubmitCommand - Tcg2 - Not Found` to enumerating all four PCR banks.

**Secure Boot is absent.** The vendored firmware is `edk2-aarch64-code.fd`,
which has no Secure Boot. UTM pairs its TPM with `edk2-aarch64-secure-code.fd`,
which winvm does not ship. This is why the answer file sets
`BypassSecureBootCheck` even though the TPM is real.

**The guest boots to audit mode, not OOBE.** This one setting makes the VM
predictable. It is Microsoft's documented mechanism:
`Microsoft-Windows-Deployment | Reseal | Mode = Audit` in the `oobeSystem` pass.
Audit mode "starts the computer in the built-in administrator account", and the
machine "will continue to boot to audit mode by default until you configure the
computer to boot to OOBE"
([Boot Windows to Audit Mode or OOBE][audit]).

The out-of-box experience is slow, and the host cannot tell when it has ended.
With OOBE, a fresh instance logs on a temporary account called `defaultuser0`,
shows "Just a moment, checking for updates" for minutes, then reboots. During
all of that, the guest looks ready by every available measure: `qemu-ga` runs
as SYSTEM and answers `guest-ping`, `guest-exec` works, and Windows reports
`OOBEInProgress = 0`, `SystemSetupInProgress = 0` and a running `explorer.exe`
while the OOBE screen is still displayed. No probe returns "not yet".
Snapshotting during that period **livelocks the guest**: every vCPU at 100%, no
disk I/O, recoverable only by killing it. The post-OOBE reboot can also fail;
one guest hung at the firmware splash indefinitely.

Audit mode removes the OOBE phase instead of trying to detect its end. Every
boot lands on a logged-on desktop. Two consequences:

- The **Sysprep dialog** appears on the desktop in audit mode. `logon.ps1`
  closes it at every logon (see below).
- The **screen saver is disabled** during provisioning and again at each logon.
  Microsoft: "If a password-protected screen saver starts when you are in audit
  mode, you cannot log back on to the system", because the built-in
  administrator is disabled immediately after logon.

Provisioning runs from the `auditUser` pass, which Microsoft documents for this
purpose: "run a script that runs when the PC enters audit mode … helpful for
tasks like automated app installation or testing" ([Add a custom
script][script]). `SetupComplete.cmd` runs the same script. The script is
idempotent, so whichever hook runs first does the work.

**The `oobeSystem` pass must contain only `Reseal`.** The documentation says
oobeSystem settings "do not appear in audit mode". That does not mean they have
no effect. With `UserAccounts` and `AutoLogon` in that pass, Windows created an
account and signed it in. The audit-mode logon that `audit.exe` had arranged
(`audit.exe /user`) never happened, so the `auditUser` pass never ran. The guest
sat on a desktop with no agent and no error. Audit mode signs in the built-in
Administrator by itself, so give it no other account. The deprecated
`SkipMachineOOBE` and `SkipUserOOBE` settings are also absent; on 25H2 they
silently suppress `FirstLogonCommands`.

**Provisioning does not power the guest off.** Microsoft warns against this in a
Setup script: "You should not reboot the system by adding a command such as
`shutdown -r`. This will put the system in a bad state" ([Add a custom
script][script]). A guest powering itself off is also an ambiguous signal,
because a crash and a kill look the same from the host. Instead, `build` waits
for provisioning to write its completion marker, asks the guest whether
`viostor` is boot-start, and shuts the guest down through the guest agent.

[audit]: https://learn.microsoft.com/en-us/windows-hardware/manufacture/desktop/boot-windows-to-audit-mode-or-oobe
[script]: https://learn.microsoft.com/en-us/windows-hardware/manufacture/desktop/add-a-custom-script-to-windows-setup

**UAC is disabled in the guest** (`EnableLUA=0`, set in the `specialize` pass).
With UAC on, an unelevated guest-tools installer raises a consent dialog that
nobody can answer (`The operation was canceled by the user`). The UAC dialog
focuses **No**, so sending Enter denies it. GitHub's Windows runners also run
with UAC disabled.

## The display

**New instances use `virtio-gpu-pci`, with no size on the command line.**
The screen is resized while the guest runs, so the size never enters the save
compatibility hash (`saves.ts` hashes the QEMU arguments). A save restores at
the size it was taken at, and the app asks for its window's size again after.
Builds always use `ramfb`, because WinPE has no virtio-gpu driver. Instances
created before this keep `ramfb` (EDK2 fixes it at 800x600, and QEMU cannot
resize it) until switched with `winvm display virtio-gpu` while stopped. An
instance switched by an earlier winvm has `xres`/`yres` in its `display.json`;
it keeps them on the command line, so its saves still load.

**A resize takes two steps, in this order** (`guestdisplay.ts`):

1. **VNC SetDesktopSize.** QEMU 11.1 (`ui/vnc.c`) passes the width and height
   to virtio-gpu (`qemu_console_set_ui_info`, no delay) and answers at once
   with ExtendedDesktopSize status 4, "forwarded". virtio-gpu raises a
   display-change event. The guest's viogpudo driver (UTM's build, 22.7.38.43)
   then adds exactly that size to its mode list, in one "custom" slot that the
   next request replaces. It does **not** switch to it. The app sends this
   over its own noVNC connection; `winvm display WxH` opens a short shared VNC
   connection (`desktopsize.ts`).
2. **The agent sets the mode.** `winvm-display.exe` (`assets/winvm-display.cs`,
   compiled at agent install, behind the agent's `POST /display`) polls the
   mode list until the size appears, then calls `ChangeDisplaySettingsEx` in
   the logged-on session. Through qemu-ga (session 0), the same call returns
   success and changes nothing. The agent keeps one helper running (`serve`,
   a request per line): starting a .NET program costs 0.55–0.85 s in the
   guest, which used to be most of every resize.

Measured on win11-arm64: about 80 ms from the VNC request to QEMU's new
framebuffer, of which the guest helper takes 60–160 ms including its wait.
Through the CLI as a separate process it was 0.6–1 s: the helper's .NET
start-up (0.55–0.85 s, gone now it is kept running), then bun's.

**How the app resizes.** It asks the CLI once per machine for the agent's
address and token (`winvm agent connect --json`, which also brings an older
agent up to date), then calls `POST /display` itself, from Rust
(`agent_fetch`), on every resize. While the window's edge is dragged it
holds the last picture stretched over the view and asks nothing, unless the
size has been still for 250 ms; it asks the moment the mouse is let go
(AppKit's end-of-live-resize notification), one request at a time with only
the latest size queued, and draws 1:1 again once a frame has arrived at that
size (or after 1.5 s, with whatever arrived). Release to 1:1, measured on
win11-arm64 through the app's own controller (`resize.ts`) with VNC and the
agent as the app uses them: median 137 ms, at most 188 ms over 8 drags. The
old path, a 300 ms wait then the CLI and a fresh helper, took a median of
880 ms to the new size's first pixels (up to 1.06 s).

**Display scaling is set live too.** `DisplayConfigSetDeviceInfo` with the
undocumented `DISPLAYCONFIG_DEVICE_INFO_SET_DPI_SCALE` (-4), which is what the
Settings app uses. It takes effect without signing out; the shell finishes
re-laying out in about 5 s. Windows stores it per monitor
(`HKCU\Control Panel\Desktop\PerMonitorSettings\NOEDID_1AF4_1050_…\DpiValue`)
as steps from the recommended scale. The recommended scale is always 100%
here, because QEMU sends no physical size over VNC. Windows clamps it for
small sizes (1280x800 allows 125%) and restores it when the size grows. The
app asks for its window's size in device pixels, at DPR×100% scale.

**Limits** (`displayfit.ts`), all measured:

| Limit | Why |
|---|---|
| at most 30 MiB of framebuffer (W×H×4) | viogpudo cannot back more. 3840x2048 and 4096x1920 work; 3840x2050 and larger are accepted by Windows (`ChangeDisplaySettingsEx` returns 0) but QEMU shows "Display output is not active". A QEMU trace shows `res_create_2d` with no `res_back_attach`. A larger `xres`/`yres` at boot does not raise it. A save taken in that state restores to a dead screen. |
| at most 5120x2160 | QEMU's VNC server (`ui/vnc.h` `VNC_MAX_WIDTH`/`VNC_MAX_HEIGHT`) crops anything larger. |
| at least 1024x768 | The driver's fixed modes start there. |
| width a multiple of 16 | QEMU's VNC server pads other widths in ServerInit (1500 shows as 1504). |

The host clamps every request. The guest helper refuses over 30 MiB as well.
The app draws a clamped guest scaled up to fill its window, up to 5120x2880
device pixels (`drawSize` in `displayfit.ts`); below the limits it draws one
guest pixel per device pixel.
A Windows that saved a too-big mode falls back to a fixed mode at the next
boot (seen: 3456x2234).

**How UTM does it, for comparison.** UTM uses its own `virtio-ramfb` device
and sends the size as a SPICE monitors-config message. spice-server turns
that into the same `qemu_console_set_ui_info` call, and its viogpudo fork
reconnects the display itself. Its "Retina" mode requests points × backing
scale and draws 1:1, with the Windows scale left to the user.

## The shared folder and the clipboard

How to use them is in [Getting files in and out](files.md#shared-folder).
This is why they are built the way they are (`share.ts`, `sharecmds.ts`).

**Three devices, on every virtio-gpu instance, always.** On a runtime that
has them (winvm-runtime with `virtiofsd`, `vhost-user-fs-pci` and
`qemu-vdagent`; `share.runtimeSupport` asks QEMU):

```
-machine virt,accel=hvf,memory-backend=mem
-object memory-backend-shm,id=mem,size=4096M,share=on
-chardev socket,id=vfs0,path=<instance>/virtiofsd.sock
-device vhost-user-fs-pci,chardev=vfs0,tag=winvm,queue-size=1024,addr=0x10
-chardev qemu-vdagent,id=vdagent,clipboard=on,mouse=off
-device virtserialport,chardev=vdagent,name=com.redhat.spice.0
```

- Guest RAM comes from a **shared memory backend** because virtiofsd, another
  process, reads and writes the guest's buffers directly.
- The virtio-fs tag is fixed (`winvm`) and the device sits in a **fixed PCI
  slot** (`addr=0x10`, clear of the slots QEMU hands out in order), so
  Windows sees one device whatever the display: see the bugcheck below.
- The clipboard port joins the guest agent's virtio-serial bus. QEMU bridges
  the SPICE agent protocol to the VNC extended clipboard that noVNC speaks;
  Windows' side is the SPICE agent from the UTM guest tools (`vdservice`,
  ARM64).

**Sharing never changes the save hash.** Everything above is fixed: the
socket path is per instance, and `hardwareArgs` blanks `path=` values.
virtiofsd serves the chosen folder, or `<instance>/share-empty` (read-only)
when none is chosen, so adding, changing or removing a share leaves the hash
alone. The devices themselves changed it **once**: saves of virtio-gpu
instances taken before them do not load. `start`, `saves` ("no (before the
shared folder)"), `load` and the stow recall name those saves
(`saves.strandedByDevices`), as `display` names the saves a device switch
strands. A stowed machine whose stow predates the devices boots instead,
from its disk. ramfb instances get none of the devices and keep their saves.
The new runtime's patch set changes the hash's `qemu` part too, so in
practice every save made on the old runtime stops loading with it.

**One virtiofsd per QEMU, started before it.** virtiofsd exits when its QEMU
disconnects, so `qemu.launch` starts a fresh one before every boot, load and
recall (`--sandbox none --cache auto --migration-on-error guest-error`, plus
`--readonly` for a read-only share), waits for its socket, and records what
it serves in `virtiofsd.json`. Every teardown path stops what is left, with
swtpm (`qemu.stopSidecars`). It is found by its `--socket-path`, so one
instance never touches another's. The launch owns it rather than the control
service: the daemon's life is QEMU's, it must exist before QEMU starts, and
the service may be the previous QEMU's, about to exit.

**QEMU does not survive its daemon.** Killing virtiofsd under a running guest
ended QEMU ("vhost_set_vring_call failed 22"): vhost-user-fs has no reconnect.
So the folder cannot be swapped live (stop VirtioFsSvc, swap the daemon,
start it again does not work), and a new folder or read-only setting takes
effect at the next QEMU start. A stow and start does it in seconds and keeps
the session: the save carries virtiofsd's state, and with
`--migration-on-error guest-error` the handles the new folder lacks become
errors in the guest instead of a failed load (measured: the guest listed the
new folder at once). The drive letter changes live (the registry value and
`VirtioFsSvc` restarted through the agent).

**Saves.** zstd, mapped-ram and the stow round trip all load with the
devices attached; virtiofsd's state travels in the stream ("migration through
qemu"), and `qemu-vdagent` does not block migration.

**The bugcheck, and why `share install` boots on ramfb.** Binding viofs to
the device while the virtio-gpu driver runs bugchecks Windows: `0x7E` in
`viogpudo.sys+0x1180`. It happened live (`pnputil /install` with the device
present) and at the next boot after staging the driver with no device
present, which then hung at "Display output is not active". Binding it while
the display is **ramfb**, with the device present, does not; and once bound,
boots on virtio-gpu find the device already installed (same slot, same
instance ID) and start normally. So:

- **New images**: a build always runs on ramfb, and gets the virtio-fs device
  alone (no clipboard port) with a daemon serving an empty folder.
  `provision.ps1` runs `viofs-install.ps1` from the seed, which installs
  WinFsp, binds viofs and creates the service. Untested end to end: no build
  has been run with it yet.
- **Existing machines**: `winvm share install` shuts Windows down (with
  `--restart`, or refuses), switches the display to ramfb, boots with all the
  devices and no watcher or autosave, stages the files through the agent and
  runs the same script, shuts down, puts the display back (also on failure),
  and starts again if it was running. A stowed machine is refused, as
  `display` refuses it.

`viofs-install.ps1` installs WinFsp, binds viofs, copies `winfsp-a64.dll`
beside `virtiofs.exe` (WinFsp's own lookup reads the 64-bit registry view,
where an ARM64 WinFsp has no `InstallDir`), creates `VirtioFsSvc` (auto,
depending on `VirtioFsDrv` and `WinFsp.Launcher`, restarting on failure), and
sets `HKLM\Software\VirtIO-FS\MountPoint`. The volume's label is the tag
(viofs reports it and cannot set another), so Explorer's name, **Mac**, is
the per-user `MountPoints2\<letter>\_LabelFromReg`, which the script sets for
the user it runs as and `logon.ps1` sets for whoever logs on.
`DriveIcons\<letter>\DefaultLabel` does not override a volume label.

**Where the guest's files come from**, pinned by SHA-256 like the guest tools
(`sharemedia.ts`): viofs 0.1.302 (`viofs/w11/ARM64`: `viofs.inf`, `.sys`,
`.cat`, `virtiofs.exe`) read out of virtio-win's 840 MB ISO with HTTP range
requests (four files, 300 KB), and WinFsp 2.1 (`winfsp-2.1.25156.msi`) from
its GitHub release. virtio-win 0.1.285 is the first with ARM64 viofs; UTM's
guest tools have none. Licences: [THIRD-PARTY-LICENSE.md](../THIRD-PARTY-LICENSE.md).

**Change notices** are in [files.md](files.md#for-developers). Two findings:
writing a file's time back unchanged makes WinFsp report nothing (it skips a
no-op), so the agent moves the time forward a millisecond and back; and a
read-only share cannot be touched, so it gets no notices.

**Measured** (Windows 11 ARM64, M-series Mac): 850-880 MiB/s writing and
1250-1370 MiB/s reading 1 GiB in 1 MiB blocks; a Mac change visible in the
guest at once; watchers firing about a second after a Mac change. Clipboard
both ways through a VNC client speaking the extended clipboard. Copying from
PowerShell's `Set-Clipboard` makes the guest's SPICE agent send an empty
clipboard and restart; `clip.exe` and ordinary copies work.

## The command channel

`winvm exec` runs a command in the guest and returns stdout, stderr and the exit
code. It uses winvm's in-guest agent when the instance has one, and otherwise
**qemu-ga** over virtio-serial. qemu-ga needs no SSH, no listening port and no
guest networking.

UTM's `utmctl` has the same verbs and is *not* used. It drives UTM.app over
Apple Events, so it needs a logged-in Aqua session and an interactive TCC grant.
Upstream's own error text says "utmctl does not work from SSH sessions or before
logging in"; in practice it hangs silently or fails with `OSStatus -1712`.
Apple's Virtualization.framework cannot run Windows at all, because it has no
virtual TPM.

`qemu-ga` on Windows ARM64 is the **x64 build, running under emulation**. UTM's
installer has no ARM64 build of it. It works, but it is not native.

## Networking

The guest gets outbound internet through QEMU's user-mode network stack, using
`virtio-net-pci`. Windows 11 ARM64 has **no in-box virtio-net driver**, so the
NIC does not work until the guest tools install `NetKVM`. Verified: DNS, TLS,
and `bun install` against the npm registry.

`ping` does not work. User-mode networking does not carry ICMP. Test
reachability with HTTP.

## Guest tools

`build` downloads UTM's guest-tools ISO (`TOOLS_URL` in `host.ts`, a versioned
`utm-guest-tools` release). It is the practical source of **WHQL-signed ARM64
virtio drivers**. They chain to `Microsoft Windows Hardware Compatibility
Publisher`, so they load without test-signing, which matters because Windows
ARM64 enforces kernel-mode driver signing. The drivers are Fedora's virtio-win
ARM64 builds. Fedora publishes only x64 and x86 *MSIs*, so the ISO is the useful
artifact.

## What the image carries, and why it is quiet

Besides Windows and the guest tools, provisioning (`assets/provision.ps1`)
installs and configures what makes the guest a fast, steady test fixture. Each
item was measured:

- **.NET native images, compiled.** Windows ships with the NGEN queue full and
  leaves it to scheduled tasks. Audit mode keeps `OOBEInProgress=1`, and while
  that is set **Task Scheduler runs nothing**. The queue was never drained, so
  every Windows PowerShell start JIT-compiled `System.Management.Automation`.
  The build runs `ngen executeQueuedItems` for `Framework64` and
  `FrameworkArm64`.
- **PowerShell 7** (native ARM64, a pinned MSI shipped on the seed), at
  `C:\Program Files\PowerShell\7\pwsh.exe` and on PATH.
- **Background work off.** Windows Update (and its medic service), Delivery
  Optimization, Search indexing, SysMain, telemetry, WER, automatic
  maintenance, Store auto-updates, consumer features, Edge background and
  updates, OneDrive, Widgets and the lock screen are all off. The power plan is
  High performance.
- **Defender stays on, with exclusions** for `C:\work` (created for test
  workspaces), `C:\payload`, `C:\ProgramData\winvm`, and the `bun.exe` and
  `node.exe` processes. The exclusions are in a separate script,
  `assets/defender.ps1`. Tamper Protection and AMSI block scripts that touch
  Defender, so the same lines inside `provision.ps1` would make all of
  provisioning fail.
- **A logon script** (`C:\ProgramData\winvm\logon.ps1`), started from an HKLM
  `Run` entry under `conhost --headless`. It is not a scheduled task, for the
  Task Scheduler reason above. It applies per-user (HKCU) settings and **closes
  the System Preparation Tool dialog** that audit mode opens at every logon. The
  dialog takes focus, and its default action on a stray Enter is "Enter System
  Out-of-Box Experience (OOBE)", which takes the guest out of audit mode. The
  script also closes the Start menu, which Windows opens by itself at an
  instance's first logon.

Not done: a Dev Drive (a ReFS VHDX inside the qcow2 would have to be re-attached
every boot), and anything about **Prism**. `qemu-ga` is the x64 build, so
processes it starts inherit an x64-emulated environment
(`PROCESSOR_ARCHITECTURE=AMD64`). This is known and out of scope here.

Measured 2026-10-22, on the same host on the same day, on a fresh `--ephemeral`
instance of each image (4 vCPUs, 4 GB). Other VMs were running on the host, so
treat the small numbers as approximate. Idle is QEMU's own CPU time over 180 s,
after 120 s to settle. Start times are host wall clock for `winvm exec`, which
adds about 0.14 s (the `cmd /c echo` row), median of 5 warm runs:

| | `win11-arm64` (before) | `win11-arm64-v2` (after) |
|---|---|---|
| idle CPU, % of 4 vCPUs | 2.6 % | **0.6 %** |
| `winvm exec cmd /c echo` | 0.16 s | 0.28 s |
| `winvm exec powershell -NoProfile -c 1` | 3.4 s (cold 3.0 s) | **0.94 s** (cold 0.88 s) |
| `winvm exec pwsh -NoProfile -c 1` | not installed | 1.6 s (cold 1.7 s) |
| same, timed **inside** the guest from an ARM64 parent | | `powershell` 0.53 s, `pwsh` **0.17 s** |
| Sysprep dialog on screen after boot | yes | **no** (closed ~1 s after logon) |
| `winvm build`, end to end | | 13 min |

The "inside the guest" row shows the Prism cost: `pwsh` started by the x64
`qemu-ga` takes about 1.4 s longer than the same `pwsh` started by an ARM64
process. Harnesses that care about start time should launch through a native
ARM64 parent.

## Fidelity limits — read before trusting a result

This guest is **ARM64**. CI's `windows-latest` is **x64**. They are not
interchangeable:

- **`bun:ffi` is disabled** on Windows ARM64 (oven-sh/bun#28055).
- **JIT and WebAssembly were disabled** in the port PR (oven-sh/bun#26215).
  Whether 1.3.14 re-enabled them is *unverified*.
- x64-on-ARM emulation is binary translation, not identical execution, so
  **timing-sensitive questions cannot be settled here**. This includes the
  intermittent ~5016 ms `windows` failures seen in maximal-core #90.

The guest is good for the bugs that caused most past Windows failures: shell
parsing, file locking, path separators, regex escaping and POSIX mode bits.
Those do not depend on the architecture.

For real x64 parity, attach to the real runner (`action-tmate` on the `windows`
job) or use a cloud Windows machine.

## Troubleshooting

**Start with `winvm diagnose [-i name]`.** It reads what a guest left behind:
the firmware console, QEMU's stderr, the provisioning transcript, and image and
instance metadata. It reports the known failures, each with its fix. It needs no
running guest. From outside, these failures all look the same: the QEMU process
is alive and the monitor answers "running". `build` runs `diagnose`
automatically when it fails.

It reports nothing on a healthy instance. If it finds nothing and the guest is
still wrong, add the new failure to `diagnose.ts`.

Its checks are tested against recorded artifacts from guests that actually
failed, kept in `packages/core/tests/traces.zip` and exercised by `pnpm test`.
The archive also holds the long-form write-up (`notes/diagnostic-notes.md`) and
an `index.md`. The traces are kept in a zip because they show broken
configurations; as loose files next to the working code, they would mislead
anyone reading the tree to learn how it works. Open the archive when you are
diagnosing something.

About half the traces are of guests that were fine. Several of the signatures
are transient states that a healthy guest passes through, so the archive keeps
a working example beside each failing one.

**Watch a boot.** `winvm open -i <name>` shows the screen in Screen Sharing.
`--web` opens it in the browser, and `winvm screenshot` saves a PNG without a
window. The VNC server needs the password in `<instance>/vncpassword`. A plain
`open vnc://127.0.0.1:590<n>` asks for it; `winvm open --print` prints a URL
that includes it. Firmware output goes to the instance's `serial.log`, and the
previous boot's output to `serial.prev.log`. The previous log is kept because
the usual response to a bad boot is another boot, which would otherwise
overwrite it. QEMU's own stderr goes to `qemu.log`.

**A build failed.** `build` says why, and it does not produce an image. It
promotes the disk only after the guest agent sees provisioning's completion
marker (`C:\winvm-provisioned.txt`). On failure it prints the last lines of the
provisioning transcript, runs `diagnose`, and keeps the scratch instance for
inspection. `provision.ps1` also writes its result to `status.txt` on the result
volume. Read the whole transcript with:

```sh
hdiutil attach "$HOME/.local/state/winvm/instances/build-<image>/result.img"
cat /Volumes/MAXRESULT/provision.log
hdiutil detach /Volumes/MAXRESULT
```

**A build says one is already running.** The build VM runs detached, so a build
that ended badly can leave the guest alive. Run `winvm kill -i build-<image>`,
then build again. Interrupting a build with Ctrl-C kills the guest.

**The guest agent never answers during a build.** The guest tools did not
install. Watch the build over VNC and read the provisioning transcript. The
tools volume is attached only during a build, so the fix is to rebuild.

**A build falls through to a UEFI shell.** `startup.nsh` on the result volume is
the boot selector during a build. It prefers an installed Windows over the
installer, so Setup's reboots during the install do not restart the install.

**A guest is wedged.** Try `winvm rewind -i <name>` first. It is faster than a
reset and keeps the instance. If the guest cannot be restored, run
`winvm kill -i <name>` and then `winvm reset -i <name>`.

**`snapshot` says the image predates virtio boot.** That image's guest has no
boot-start `viostor`, so it runs on NVMe, which QEMU cannot snapshot. Rebuild it
with `winvm build --image <name>`. `winvm build` reports whether snapshots are
available when it finishes. `reset` deletes the overlay and every internal
snapshot in it. `start` does not take a new `fresh`, but `rewind` with no tag
falls back to the `baseline` save, which a reset keeps.
