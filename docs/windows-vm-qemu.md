# Windows 11 ARM64 test VM (QEMU) — design notes

A scriptable Windows guest on this Mac, for the class of bug that only appears
on Windows. Driven entirely from the shell — no GUI, no clicking. For setup and
day-to-day use, start with the [README](../README.md); this file records why the
tool is built the way it is.

Commands below are written as `winvm <verb>`; from a checkout that is
`bun winvm.ts <verb>`.

```sh
winvm setup                          # install prerequisites, fetch pinned media
winvm doctor                         # or just check, and change nothing

# once: build the golden base image (~20 min)
winvm build --iso ~/vm/Win11_25H2_English_Arm64.iso --bun 1.3.14

winvm start                          # boot an instance (creates it if absent)
winvm smoke --expect 1.3.14          # assert the staged bun is that version
winvm exec -- bun --version          # run anything in the guest

# rewind: back to a known-good guest in about a second, without rebooting
winvm rewind                         # back to "fresh"
winvm snapshot ready                 # or checkpoint your own

winvm reset                          # discard everything, back to the base image
winvm stop

winvm ls                             # images, instances and media, with a total
winvm prune                          # drop leftover build scratch instances
winvm rmi <image>                    # remove a base image
```

## Dependencies

| | |
|---|---|
| `qemu`, `swtpm` | installed by `winvm setup`, or `brew install` them yourself |
| UEFI firmware | **vendored** in `firmware/`, gzipped (128 MiB of mostly zero padding is 1.6 MB), expanded into the state directory on first use |
| UTM guest tools | **downloaded and pinned by SHA-256**, not vendored — see below |

The firmware is vendored so the harness does not care how a particular QEMU
packaging laid out its data files; `WINVM_QEMU_DATA` overrides it, and `doctor`
prints whichever copy it resolved.

The guest-tools ISO is deliberately *not* vendored: it is ~121 MB, does not
compress, and its installer bundles `qemu-ga` under **GPL-2.0**, which would
oblige this project to keep corresponding source available for as long as it
shipped the binary. It is fetched from upstream and verified against
`TOOLS_SHA256`. The URL says "latest", so upstream *will* eventually publish a
new build and the digest will stop matching — that is the pin doing its job.
Review the new ISO and update the constant. Licences for both live in
[`THIRD-PARTY-LICENSE.md`](../THIRD-PARTY-LICENSE.md).

## Why this exists

It was written inside `maximal-core` (later vendored into the `monimal`
monorepo, and now this standalone repo). There, CI's `windows` job was the only
Windows available, and it is a batch loop: push, wait, read a log. Every
Windows defect was found that way — a `prepare` script Bun's Windows shell could
not parse, a Windows-only secrets-loader bug, a SQLite handle leak that surfaces
as `EBUSY` only where an open handle locks the file, a shebang fixture, and a
`RegExp` built from an interpolated `os.tmpdir()` with the `u` flag — harmless
on POSIX, a hard `SyntaxError` on Windows. Each cost a push/CI round trip.

## The tool is not part of any project

This repo is self-contained and project-agnostic. Copy it anywhere and it
works. It reads no manifest, no version file, nothing belonging to whatever
consumes it. Project-specific inputs are passed in:

- `--payload <dir>` — files to stage inside the guest
- `--bun <version>` — convenience that fetches that exact Bun release asset
- `--expect-file <path>` / `--expect <v>` — what `smoke` should assert

So a consumer pins its own expectation, e.g. from a Maximal checkout:
`winvm smoke --expect-file .bun-version` — the *caller* supplies the pin.

## One base image, many thin instances

A Windows install is ~15 GB, so a copy per consumer is not viable. The base is
built once and never written again; each instance is a qcow2 **overlay** backed
by it, holding only its own deltas.

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

`loadvm` itself takes well under a second; `rewind` spends the rest confirming
the guest answers again before it returns. That is deliberate — see the warning
about sleeping through a restore, below.

Three properties follow, which is why it is the design and not an optimisation:

- **Reset** is `rm overlay && qemu-img create` — instant, exactly the base
  state, no reinstall. Reset also discards firmware variables and TPM state,
  which live outside the disk image and would otherwise survive.
- **Concurrency** is free. Instances share one base and never touch each other;
  each gets its own overlay, firmware vars, TPM state, sockets and VNC display,
  allocated at creation. Verified by running two guests at once and confirming a
  file written in one is absent in the other.
- **Debugging survives.** An instance persists across stop/start, so you can
  inspect a broken guest and reset only when you are finished with it.

`--ephemeral` adds QEMU's `-snapshot`, so even the overlay is untouched and the
run is discarded on exit.

## Rewinding

`reset` returns an instance to the base image, which costs a full boot
afterwards. A **snapshot** is cheaper and more useful: it captures the running
machine — RAM included — and restoring one is not a reboot at all. The guest
resumes mid-instruction from where it was taken.

```sh
winvm start
winvm snapshot                  # capture "fresh" once the guest is how you want it
winvm exec -- <break things>
winvm rewind                    # ~0.7 s later the guest is clean and running
```

**Take the snapshot yourself, when the guest is settled.** `start` deliberately
does not do it for you. An earlier version snapshotted automatically on first
boot and it was wrong twice over: `fresh` captured a machine that was still
starting, and freezing a half-booted Windows **livelocks it** — four vCPUs at
100%, no disk I/O, no way back but `kill` and `reset`. A convenience that can
destroy an instance on the ordinary path is not a convenience.

`winvm snapshot` refuses to run against a guest that is not ready for the same
reason. Re-take `fresh` whenever the guest reaches a new state worth returning
to, or keep several tags and rewind between them. (`start` does now take one
automatic checkpoint — the file save `baseline`, on an instance's first boot —
but only after `waitReady` has seen the real account log on; see *Saves*.)

`rewind` works on a stopped instance too — it starts QEMU directly into the
saved state (`-loadvm`), skipping the boot entirely.

Three devices had to change before any of this worked, and each announced itself
as a flat refusal from `savevm` naming the offender:

| device | refusal | fix |
|---|---|---|
| NVMe boot disk | `non-migratable` | virtio-blk (above) |
| raw pflash NVRAM | `writable but does not support snapshots` | qcow2 NVRAM |
| writable result volume | same | read-only once installed |

**After a rewind, wait for the guest — do not sleep.** `loadvm` returns as soon
as QEMU has restored the state, which is *before* the guest agent can serve a
command. A fixed sleep that is slightly too short gives the worst possible
result: a command answered from across the restore, which makes a rewind that
did work look like one that changed nothing. That cost a debugging cycle here;
`winvm rewind` polls the agent instead.

The base is `chmod 444` after it is built. That is not ceremony: writing to a
backing file while overlays reference it corrupts every one of them, and the
damage surfaces later and elsewhere.

## Saves: the machine as files

`winvm save` / `load` / `saves` / `stow` / `pause` / `resume` — see `saves.ts`
for the format and `savecmds.ts` for the verbs. A save is a directory under
`$WINVM_HOME/saves/<instance>/<name>/`:

| file | what |
|---|---|
| `manifest.json` | `{name, instance, kind: manual\|auto\|baseline\|stow, createdAt, bytes, compat, image, note?}` plus `compatParts`, `ramFile`, `ramBytes`, `saveMs` |
| `vmstate.zst` | RAM and device state: a QEMU **migration stream**, `zstd -T0 -3` |
| `overlay.qcow2`, `efi-vars.qcow2` | the instance's disk and NVRAM at that instant, as APFS clones (`cp -c`) |

**Why a migration stream.** QEMU 11.1 cannot `savevm` to a path; a
migration to `exec:`/`file:` is the only whole-machine state that leaves the
qcow2. It needs exactly what `savevm` needs (virtio-blk, qcow2 NVRAM; the
result volume is no longer attached to a running guest), so every image that
can `snapshot` can `save`. TPM state needs no file: the tpm-emulator backend
carries swtpm's blobs in the stream and pushes them back on load (verified:
`Win32_Tpm` reads enabled/owned/ready after loading into a re-created
instance).

**Consistency.** `stop` first (it drains and flushes every block device,
qcow2 caches included), migrate, clone the disks while still stopped, then
`cont`. A load always restarts QEMU — a stream can only be fed to one started
with `-incoming` — so loading into a running guest is quit, clone the save's
disks back, `-incoming "exec:zstd -dc …"`, `cont`. The stream records that
the source was paused, so the destination comes up paused and is continued
explicitly.

**Compatibility.** `compat` hashes the base image's identity (name, size,
mtime, `image.json` — never its 14 GB of content), the QEMU arguments with
paths, ports, `-snapshot` and `-rtc` stripped, the firmware code image, and
the QEMU version. `load` refuses a mismatch naming the part that changed.

**Baseline.** The first `start` of an instance (and the first after `reset`)
saves `baseline` — but only after `qga.waitReady`, never mid-boot or
mid-OOBE, for the livelock reason under *Rewinding*. `--no-autosave` skips
it. `build` does not take one: its guest is the throwaway install VM on
non-migratable NVMe, and it is deleted when the image is sealed.

**`rewind` and saves.** `rewind [tag]` uses an internal snapshot of that tag
when one exists (default `fresh`, unchanged); otherwise the save of that name,
and with no tag the `baseline`. So on a new instance `rewind` "just works".

**Stow.** `stow` = save as `stow` + quit QEMU. The next `start` recalls it
instead of booting, then deletes it. Any other `load`, a `rewind` or a `reset`
discards it, so a stale stow never overrides newer state; `start --boot`
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

Two separate faults, both fixed:

- **Cold boot was hours off.** The answer file pins the guest's zone to UTC,
  and Windows reads the RTC as local time, but QEMU ran `-rtc base=localtime`
  — the host's wall clock, labelled UTC. Measured on a Pacific host:
  **-7h 0m 1s**. Now `-rtc base=utc,clock=host`: **-0.85 s** on a cold boot.
- **Every freeze leaves it in the past.** Windows keeps time from the
  virtual counter, which stops while the machine is stopped, and reads the RTC
  only at boot (the PL031 itself is right after a restore; nothing looks at
  it). So after `load`, `resume`, a save, recall and `rewind`, `clock.ts`
  sets the time over the agent (`guest-set-time`, UTC ns — qemu-ga on Windows
  requires the value). `winvm clock` does it on demand; `--check` only looks.

And the zone: the first boot (and `winvm clock`) sets the guest's time zone to
the host's — mapped from the IANA name by the host's own ICU
(`ucal_getWindowsTimeZoneID` in libicucore) — and sets `RealTimeIsUniversal=1`
so the UTC RTC stays right in any zone.

| event | before | after |
|---|---|---|
| cold boot (old `-rtc base=localtime`) | -7h 0m 1s | — |
| cold boot (`base=utc`) | -853 ms | +40 ms |
| `pause`, 2 min, `resume` | -2m 4s | +149 ms |
| `load` of a 9-minute-old save, running | -9m 17s | -1 ms |
| `load` of a 12-minute-old save, stopped | -12m 25s | -12 ms |
| recall after stow | -24.2 s | +50 ms |
| `rewind` to an internal snapshot | -10.7 s | +76 ms |

The residual is about ±100 ms: the agent is emulated x86 and its latency on a
loaded host dominates.

## The idle watcher

`start` launches `winvm watch` detached, one per instance (`watch.pid`, taken
with O_EXCL; a pidfile whose process is gone, or is no longer a watcher, is
stale and replaced). It samples every 15 s and decides in `idle.ts`, which is
pure and unit-tested; `watch.ts` does the I/O. Its choices, and why:

- **CPU is read from the host**, as QEMU's process CPU time (`ps -o time=`)
  over wall time, divided by the `-smp` count. QMP's `query-cpus-fast` has no
  time, and asking the guest costs a PowerShell launch (~20 s here). Measured
  on this guest (4 vCPUs, host at load average ~90): idle desktop 0.2-1% per
  15 s sample, background bursts of 3-17% for a single sample, worst idle
  1-minute average ~5.5%; one busy thread 25%, four 97-101%. The threshold is
  10% of a **1-minute average**, so a burst does not restart the idle clock and
  half a minute of one busy thread does.
- **Commands are activity.** `exec` touches `instances/<name>/activity` when
  it starts, every 15 s while it runs, and when it ends; `smoke`, `snapshot`
  and `rewind` touch it too.
- **A VNC client is activity.** `query-vnc` lists connected clients but not
  whether anyone is typing; saving or stowing under a live session is the wrong
  default, so any client blocks idleness. Guest-side input idle
  (`GetLastInputInfo`) would need a process in the user's session, which
  qemu-ga (SYSTEM, session 0) is not.
- **Its own saves are not activity.** CPU is ignored for a minute after any
  action it took; otherwise each autosave would re-arm the next one.
- **Host sleep is a wall-clock jump.** Between ticks the watcher compares
  `Date.now()` deltas to the interval it slept; a gap of 45 s or more beyond it
  is a sleep (a loaded host delays timers by seconds, not minutes). Timer counts
  and monotonic clocks are not used: whether they advance during sleep differs
  by clock. A wake resyncs the guest clock and restarts the idle timer, so the
  hours the lid was shut never count towards stowing.
- **Drift is measured with `measureOffset`** (clock.ts; `guest-get-time`,
  native, a few ms) every 30 min, and resynced with `syncGuestClock` above
  2 s. A paused guest is skipped: its agent cannot answer.
- **Autosave is an in-process `saves.createSave`** (kind `auto`) under
  `saves.withLock`, then a clock sync, since the guest stood still while it was
  saved. A lock held by someone else's save or load skips the round. Rotation
  deletes only kind `auto`, oldest first, down to `autosave.keep`.
- **Stow is `winvm stow`**, run as a child. `stow` and `stop` end the watcher
  first, except when the watcher is the caller.
- **A `load` replaces QEMU**; the watcher follows the new process (and restarts
  its idle clock) instead of exiting, and exits only once QEMU is gone with no
  save or load holding the instance. `load` and `rewind` count as activity; a
  save does not, or every autosave would re-arm the next.
- **`start` launches it after the first-boot baseline save**, so that save is
  not counted as use. An `--ephemeral` guest cannot be saved, so its watcher
  only keeps the clock.

## Selecting an image and instance

| | flag | env | default |
|---|---|---|---|
| state dir | — | `WINVM_HOME` | `~/.local/state/winvm` |
| instance | `-i` | `WINVM_INSTANCE` | `default` |
| image | `--image` | `WINVM_IMAGE` | `win11-arm64` |

Give each concurrent consumer its own instance name; they will share the base
image automatically.

## Host dependencies

| Dependency | Install | Why |
|---|---|---|
| `qemu` | `brew install qemu` | `qemu-system-aarch64`, `qemu-img`, and the EDK2 AArch64 firmware |
| | | Binaries come from `PATH`; the firmware images are located by asking QEMU (`-L help`) rather than assuming a prefix, so an Intel Mac, MacPorts, Nix or a source build works without editing anything. `WINVM_QEMU_DATA` overrides. `doctor` prints the path it found. |
| `swtpm` | `brew install swtpm` | **Required.** Windows 11 hard-requires TPM 2.0; without it the only way past Setup is the LabConfig bypass, an unsupported configuration |
| `hdiutil`, `newfs_msdos` | macOS built-in | Seed ISO and FAT result volume. No `xorriso`/`mkisofs` needed |

`winvm doctor` checks all of them and names what is missing. macOS-only.

## Getting the ISO

You are asked for it once, and never again. `build` looks, in order, at
`--iso`, `$WINVM_ISO`, whatever a previous build recorded, then `~/vm`, `~/isos`
and the state directory for a file whose name says `arm64` — and only then
prompts, and only when a terminal is attached, so a scripted build fails saying
what it needed instead of blocking forever on input nobody can give.

It deliberately never looks in `~/Downloads` or `~/Desktop`. Those are
TCC-protected, and merely *reading* them raises a consent dialog against
whichever terminal is running the build. Keep the ISO anywhere you like and name
it with `WINVM_ISO`.

Whatever it resolves to is **symlinked** into the state directory, never copied
and never committed: at ~8 GB it stays your file, wherever you keep it. Set
`WINVM_ISO` in a shell profile if you would rather declare it once.

The media is checked for `\efi\boot\bootaa64.efi` before anything starts, so
handing it the x64 ISO fails in a second rather than twelve minutes in.


<https://www.microsoft.com/en-us/software-download/windows11arm64> — multi-edition
ARM64, no Microsoft account. **The generated link expires after 24 hours**, so it
cannot be baked into a script. `build --iso` symlinks rather than copies it.

The guest installs **Windows 11 Pro**, selected by name (`/IMAGE/NAME`) rather
than WIM index, because index order is a property of one ISO build. It runs
unactivated, which is permitted indefinitely and correct for a disposable
fixture.

## Design decisions, and the evidence

Most were derived from UTM's source, the best available record of what works for
this guest on this hardware.

**The boot disk changes bus between installing and running.** Both halves are
load-bearing, and the reasons are unrelated to each other.

*Installing on NVMe.* Windows 11 ARM64 has an in-box NVMe driver
(`stornvme.sys`), so Setup sees the disk with nothing injected. UTM's wizard
hard-codes this for aarch64 + Windows, overriding the virtio default it uses for
every other guest. Installing onto virtio would mean injecting `viostor` at
`windowsPE`, and a `<DriverPaths>` entry names a *drive letter* — which WinPE
assigns by device enumeration order.

*Running on virtio-blk.* QEMU's `nvme` device model has **no migration
support**, so `savevm` refuses outright — `Device '0000:00:01.0/nvme' is
non-migratable`. Snapshots are impossible while the disk is NVMe, and this is a
property of the device model, not of HVF: the identical machine with a
`virtio-blk-pci` disk snapshots fine.

The bridge is a scratch virtio-blk disk attached **during the build only**. Its
sole job is to exist, so Windows installs `viostor` from the DriverStore and
marks it boot-start (`Start=0`) — which is what lets the finished image boot
with its real disk on virtio-blk. WinPE cannot see a virtio disk at all, so it
cannot disturb the answer file's `DiskID 0` while Setup is running.

`provision.ps1` checks the result and writes it to the image's `image.json`.
Images built before this change say nothing, and keep booting on NVMe rather
than bluescreening with `INACCESSIBLE_BOOT_DEVICE`; `winvm snapshot` tells you
to rebuild.

**A running instance attaches no USB storage at all.** The install ISO, guest
tools and seed are attached only while building, and the writable result volume
now goes with them. EDK2 hung enumerating that volume — the firmware console
stopping dead on `UsbBootExecCmd: Success to Exec 0x0 Cmd (Result = 1)` with a
core pegged and no boot target ever chosen — and it did so on an instance that
carried only that one USB disk, so this is not about how many are attached. The
device lines that remain follow [Linaro's published reference][linaro] for this
guest: `usb-storage` with `media=cdrom` on a `qemu-xhci` bus, and no
`removable=` flag.

`qemu-xhci`, not `nec-usb-xhci`: QEMU's documentation recommends XHCI and spells
the device `qemu-xhci` ([USB emulation][qemuusb]), while the NEC model carries an
open upstream bug, "[usb3: nec-usb-xhci broken][necbug]", reported as unwell
since QEMU 5.2.

[linaro]: https://linaro.atlassian.net/wiki/spaces/WOAR/pages/28914909194/windows-arm64+VM+using+qemu-system
[qemuusb]: https://qemu-project.gitlab.io/qemu/system/devices/usb.html
[necbug]: https://gitlab.com/qemu-project/qemu/-/issues/3241

**swtpm with `tpm-tis-device`.** UTM uses `tpm-crb-device`; Homebrew's QEMU
builds only the TIS model for aarch64. Verified equivalent — with swtpm attached
the firmware log goes from `Tpm2SubmitCommand - Tcg2 - Not Found` to enumerating
all four PCR banks.

**Secure Boot is absent.** Homebrew ships `edk2-aarch64-code.fd` but not the
`edk2-aarch64-secure-code.fd` UTM pairs with its TPM. Hence
`BypassSecureBootCheck` in the answer file even though the TPM is real.

**The guest boots to audit mode, not OOBE.** This is the single setting that
makes the VM predictable, and it is Microsoft's documented mechanism rather than
a trick: `Microsoft-Windows-Deployment | Reseal | Mode = Audit` in the
`oobeSystem` pass. Audit mode "starts the computer in the built-in administrator
account", and the machine "will continue to boot to audit mode by default until
you configure the computer to boot to OOBE"
([Boot Windows to Audit Mode or OOBE][audit]).

The out-of-box experience is not merely slow, it is *unobservable*. With OOBE,
a fresh instance logs on a temporary account called `defaultuser0`, sits on
"Just a moment, checking for updates" for minutes, then reboots. During all of
it the guest looks ready by every available measure: `qemu-ga` runs as SYSTEM
and answers `guest-ping`; `guest-exec` works; and Windows reports
`OOBEInProgress = 0`, `SystemSetupInProgress = 0` and a running `explorer.exe`
while the OOBE screen is still on the display. There is no probe that returns
"not yet". Snapshotting in that window **livelocks the guest** — every vCPU at
100%, no disk I/O, recoverable only by killing it — and the post-OOBE reboot is
its own failure point (one hung at the firmware splash indefinitely).

Audit mode deletes the phase instead of trying to detect the end of it. Every
boot lands on a logged-on desktop. Two consequences worth knowing:

- The **Sysprep dialog** appears on the desktop in audit mode. Harmless here —
  nothing drives this guest through its GUI.
- The **screen saver is disabled deliberately** during provisioning. Microsoft:
  "If a password-protected screen saver starts when you are in audit mode, you
  cannot log back on to the system", because the built-in administrator is
  disabled immediately after logon.

Provisioning runs from the `auditUser` pass, which is what Microsoft names it
for — "run a script that runs when the PC enters audit mode … helpful for tasks
like automated app installation or testing" ([Add a custom script][script]).
`SetupComplete.cmd` invokes the same script, and the script is idempotent, so
whichever hook fires first does the work.

**The `oobeSystem` pass must contain nothing but `Reseal`.** The documentation
says oobeSystem settings "do not appear in audit mode", and that sentence is
easy to read as "they are harmless". They are not. Left in place, `UserAccounts`
and `AutoLogon` still created an account and signed *it* in — so the audit-mode
logon that `audit.exe` had arranged to be re-called on (`audit.exe /user`) never
happened, the `auditUser` pass never ran, and the guest sat on a finished
desktop with no agent and nothing anywhere explaining why. Audit mode signs in
the built-in Administrator by itself; give it no other account to prefer.

**Provisioning does not power the guest off.** It used to, so that `build` could
treat the VM vanishing as success. Microsoft warns against exactly that from a
Setup script — "You should not reboot the system by adding a command such as
`shutdown -r`. This will put the system in a bad state" ([Add a custom
script][script]) — and the signal was ambiguous regardless, since a crash and a
kill look identical. The host now waits for provisioning to declare itself
finished, asks the guest what it is, and shuts it down through the guest agent.

[audit]: https://learn.microsoft.com/en-us/windows-hardware/manufacture/desktop/boot-windows-to-audit-mode-or-oobe
[script]: https://learn.microsoft.com/en-us/windows-hardware/manufacture/desktop/add-a-custom-script-to-windows-setup

**UAC is disabled in the guest.** `FirstLogonCommands` run as the auto-logged-on
administrator but *unelevated*, so the guest-tools installer raises a consent
dialog nobody can answer (`The operation was canceled by the user`). Note the
UAC dialog focuses **No**, so blindly sending Enter *denies* it. This also
matches GitHub's Windows runners, which run with UAC disabled.

**`SkipMachineOOBE`/`SkipUserOOBE` are deliberately absent.** Microsoft
deprecated both, and on 25H2 they silently suppress `FirstLogonCommands` — the
desktop comes up, provisioning never runs, nothing says why.

## The command channel

`winvm exec` talks to **qemu-ga** over virtio-serial: it runs a command in the
guest and returns stdout, stderr and the exit code. No SSH, no listening port,
no dependency on guest networking.

UTM's `utmctl` has the same verbs and is *not* used: it drives UTM.app over
Apple Events, so it needs a logged-in Aqua session and an interactive TCC grant.
Upstream's own error text says "utmctl does not work from SSH sessions or before
logging in"; it reproduces as a silent hang and `OSStatus -1712`. Apple's
Virtualization.framework cannot run Windows at all — no virtual TPM.

`qemu-ga` on Windows ARM64 is the **x86 build under emulation**; UTM's installer
has no ARM64 branch for it. It works, but is not native.

## Networking

The guest gets outbound internet through QEMU's user-mode stack via
`virtio-net-pci`. Windows 11 ARM64 has **no in-box virtio-net driver** — the NIC
does not work until the guest tools install `NetKVM`. Verified: DNS, TLS, and
`bun install` against the npm registry.

`ping` will never work — ICMP is a user-mode-networking limitation, not a fault.
Test reachability with HTTP.

## Guest tools

`build` downloads UTM's guest-tools ISO
(`https://getutm.app/downloads/utm-guest-tools-latest.iso`), the practical source
of **WHQL-signed ARM64 virtio drivers** — they chain to `Microsoft Windows
Hardware Compatibility Publisher`, so they load with no test-signing, which
matters because Windows ARM64 enforces kernel-mode driver signing. The drivers
are Fedora's virtio-win ARM64 builds; Fedora publishes only x64/x86 *MSIs*,
which is why the ISO is the useful artifact.

## Fidelity limits — read before trusting a result

This guest is **ARM64**; CI's `windows-latest` is **x64**. Not interchangeable:

- **`bun:ffi` is unconditionally disabled** on Windows ARM64 (oven-sh/bun#28055).
- **JIT and WebAssembly were disabled** in the port PR (oven-sh/bun#26215).
  Whether 1.3.14 re-enabled them is *unverified*.
- x64-on-ARM emulation is binary translation, not identical execution, so
  **timing-sensitive questions cannot be settled here** — including the
  intermittent ~5016 ms `windows` failures seen in maximal-core #90.

It *is* good for the class that caused most historical bugs: shell parsing, file
locking, path separators, regex escaping, POSIX mode bits. Those are
architecture-independent.

For genuine x64 parity, attach to the real runner (`action-tmate` on the
`windows` job) or use a cloud Windows box.

## Troubleshooting

**Start here: `winvm diagnose [-i name]`.** It reads what a guest left behind —
firmware console, QEMU's stderr, the provisioning transcript, image and instance
metadata — and reports the failures this tool has actually had, with the way out
of each. It needs no running guest, which is the point: every failure here looks
identical from outside, because the QEMU process is alive and the monitor
answers "running" in all of them. `build` runs it automatically when it fails.

It reports nothing on a healthy instance. If it finds nothing and the guest is
still wrong, that is a new failure mode worth adding to `diagnose.ts`.

Its checks are held to recorded artifacts of guests that actually failed, kept
in `tests/traces.zip` and exercised by `pnpm test`.
The archive also carries the long-form write-up (`notes/diagnostic-notes.md`)
and an `index.md`. It is a zip rather than loose files on purpose: those traces
are pictures of BROKEN configurations, and next to the working code they are a
trap for anyone reading the tree to learn how this is supposed to work. Open it
when you are diagnosing something; ignore it otherwise.

Half the traces are of guests that were FINE. That is the point — several
signatures here are transient states a healthy guest passes straight through,
and the archive keeps a working example beside each failing one.

**Watch a boot.** `winvm ls` prints each instance's VNC display; connect with
`open vnc://127.0.0.1:590<n>`. Firmware output goes to the instance's
`serial.log`, and the boot before it to `serial.prev.log` — kept because the
usual response to a bad boot is another boot, which would otherwise overwrite
the evidence. QEMU's own stderr goes to `qemu.log`.

**A build failed.** It says why, and it does not produce an image. `build`
promotes the disk only when the guest reports success: `provision.ps1` writes
`status.txt` to the result volume, and anything other than `ok` prints the tail
of the transcript and keeps the scratch instance for inspection. Read the whole
transcript with:

```sh
hdiutil attach "$HOME/.local/state/winvm/instances/build-<image>/result.img"
cat /Volumes/MAXRESULT/provision.log
hdiutil detach /Volumes/MAXRESULT
```

**A build says one is already running.** It is — `build` detaches its VM, so an
interrupted build leaves the guest alive. `winvm kill -i build-<image>`, then
build again. Interrupting with Ctrl-C now kills the guest on the way out.

**Guest agent never answers.** The tools did not install. Boot it, look over
VNC, and re-run the installer from the mounted tools volume.

**Boot falls through to a UEFI shell.** `startup.nsh` on the result volume is the
selector; it prefers an installed Windows over the installer, which is what stops
Setup's mid-install reboots from restarting the install forever.

**A guest is wedged.** `winvm rewind -i <name>` first — it is faster than a reset
and keeps the instance. `winvm kill -i <name>` then `winvm reset -i <name>` if
the guest is too far gone to restore.

**`snapshot` says the image predates virtio boot.** That image's guest has no
boot-start `viostor`, so it runs on NVMe, which QEMU cannot snapshot. Rebuild it
(`winvm build --image <name>`); `winvm build` reports whether snapshots are
available when it finishes. `reset` deletes the overlay and therefore every
snapshot with it — the next `start` takes a new `fresh`.
