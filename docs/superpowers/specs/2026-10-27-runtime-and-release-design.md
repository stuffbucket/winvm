# winvm runtime and release

Date: 2026-10-27. Status: design, for review before planning. Plan 5 of the
sequence in `2026-10-27-monorepo-service-viewer-design.md`; this document
replaces that design's "Build, CI and release" section where they differ.

## Why

On 2026-10-27 a Windows 11 ARM64 guest stopped in edk2's "Start boot option"
countdown after about one guest-initiated reboot in ten. The cause was
Homebrew's QEMU moving to 11.0.3, which carries QEMU `b5f8f77271` without its
fix `a86024eb2d` (in 11.1.0): an HVF vCPU halted in `wfi` could miss its
virtual-timer interrupt for good. Nothing in winvm changed; the host did.
Seen live: vCPU 0 in `wfi`, `CNTV_CTL_EL0 = 5`, QEMU at 99% CPU, and a host
`system_reset` did not recover it. On 11.1.2, 40 of 40 reboots passed.
Evidence: `~/Claude/winvm-hang-2026-10-27/`.

winvm takes QEMU, swtpm and zstd from whatever the machine has. That makes
every machine, the cage check and any future app user a different
configuration, and a Homebrew upgrade can break all of them at once.

## Goals

- Every winvm, whether a developer checkout, the app or the cage check, runs
  byte-identical QEMU, swtpm and zstd, chosen by one pin.
- Changing that pin is deliberate: build, test on a real Mac, then pin.
- A signed, notarized `.dmg` built by `stuffbucket/macos-builder`, as maximal
  and bladerunner are.
- From the `.dmg` alone, a user can turn a Windows 11 ARM64 ISO they
  downloaded into a base image and boot it.

## Non-goals

- Mac App Store, App Sandbox, Intel Macs, macOS 14 and older.
- An auto-updater (the builder's Tauri updater key is shared by all its
  clients).
- SPICE, x86 guests, GPU acceleration.

## Anti-goals

- winvm running a `qemu-system-aarch64`, `swtpm` or `zstd` it found on `PATH`.
- winvm moving, modifying or offering to delete the user's ISO (user's
  decision). It reads the ISO and records its checksum; what happens to the
  file afterwards is the user's business.
- Shipping or hosting any Microsoft file.

## Decisions

The user's:

- The runtime is bundled and pinned, not taken from Homebrew.
- It lives in its own repository, `stuffbucket/winvm-runtime`, following
  Rancher Desktop's `rancher-sandbox/rancher-desktop-qemu`.
- The ISO is never offered for deletion.

Mine (the builder may revisit with reason):

- QEMU runs as an executable. UTM's library-plus-launcher design exists for
  the App Store sandbox, which a Developer ID app does not need.
- One pin, in winvm, read by everything: `packages/core/runtime.json`.
- Minimum host: macOS 15 on Apple Silicon. QEMU 11.x's HVF backend needs the
  macOS 15 SDK (Homebrew's 11.1.2 formula disables HVF on Sonoma and older).
- The base-image build moves into the app's first run. The earlier design kept
  it a CLI job; from a `.dmg` it is most of the product.

## 1. `stuffbucket/winvm-runtime`

**What a release is.** Version `<qemu>-<revision>`, e.g. `11.1.2-1`. Assets:

- `winvm-runtime-11.1.2-1-darwin-arm64.tar.gz`: `bin/qemu-system-aarch64`,
  `bin/qemu-img`, `bin/swtpm`, `bin/zstd`, `lib/` (every dylib they load, as
  regular files, no symlinks), and `share/qemu/` (only the data files QEMU
  opens for winvm's machine, e.g. `efi-virtio.rom`).
- `….tar.gz.sha256`.
- `winvm-runtime-11.1.2-1-sources.tar.gz`: every source tarball used, the
  formulae, patches and packaging script. This is the GPL-2.0 source for QEMU
  and the LGPL libraries.
- `manifest.json`: component versions, source checksums, and the SHA-256 of
  every file in the runtime tarball.

**The recipe.** Homebrew formulae in the repository, derived from
homebrew-core as the qemu-spice tap is, each pinning its source by SHA-256:

- `qemu`: `--target-list=aarch64-softmmu`, no SPICE, no GTK/SDL/cocoa (winvm
  runs `-display none` with VNC), plus core's flags.
- `swtpm` and `libtpms`.
- `zstd`.
- Patches in `patches/`, each with a note saying why and when it can go
  (Rancher carries UTM's "hvf: arm: disable SME" this way).

**CI** (`.github/workflows/build.yml`, manual and on tags), modelled on
Rancher's `build.yaml`:

1. On a GitHub-hosted macOS 15 arm64 runner, uninstall every Homebrew
   package, then `brew install --build-from-source` the repository's formulae
   and their whole dependency tree.
2. Package: find the files QEMU, swtpm and zstd load and open, copy them, and
   rewrite library references to `@executable_path/../lib` with
   `install_name_tool`, flattening symlinks (Rancher's
   `lima-and-qemu.pl`).
3. Sign ad hoc: `qemu-system-aarch64` with `com.apple.security.hypervisor`,
   the rest without entitlements, so the tarball runs as downloaded.
4. Check: every binary runs `--version` from an unpacked copy in a
   different directory, `otool -L` shows no absolute Homebrew paths, and
   `qemu-system-aarch64 -M virt -device help` lists the devices winvm uses.
   Hosted runners cannot run HVF guests, so no boot here.
5. Publish the assets above to a draft release.

**Acceptance, before winvm pins a release** (on a real Mac, recorded in the
winvm PR that changes the pin):

- 40 guest-initiated reboots with no firmware stall
  (the reboot loop used on 2026-10-27);
- the cage ARM64 check passes;
- save and load round-trip.

## 2. winvm uses only the runtime

- `packages/core/runtime.json` holds the pinned version, the tarball URL and
  its SHA-256.
- The runtime is unpacked into a cache shared by every `WINVM_HOME`:
  `~/.local/share/winvm/runtime/<version>/`, verified against the pin, with
  `manifest.json` kept beside it. One copy per version, however many homes.
- winvm finds its binaries in this order and nowhere else:
  1. `WINVM_RUNTIME` (a directory, for experiments; `doctor` says it is in
     use);
  2. the runtime inside the app bundle, when running from the app;
  3. the cached pinned runtime.
- Fetching it: `mise install` runs a postinstall hook that fetches and
  verifies the pinned runtime (it replaces today's `scripts/check-host.ts`
  hook), and `winvm setup` does the same. Neither needs Homebrew.
- `winvm doctor` reports the runtime version, where it came from, and whether
  its files match `manifest.json`. `requireHost` refuses to start without a
  verified runtime, or on macOS older than 15.
- Saves already record the QEMU version in `compatParts.qemu` and refuse to
  load where it differs, so a pin change is visible to saves without new
  code. Image metadata gains the runtime version and the ISO and guest-tools
  checksums it was built from.
- `winvm setup` stops installing Homebrew formulae; the README's prerequisites
  become mise and the runtime. winvm#8's "QEMU 11.1 or later" check is the
  stopgap until this lands.

## 3. The app and the `.dmg`

**Bundle.**

```
winvm.app/Contents/
  MacOS/winvm-viewer       Tauri app
  MacOS/winvm              Bun-compiled CLI and service (the sidecar)
  Resources/runtime/       the pinned runtime, unpacked
```

The app offers "Install command-line tool", which links `Contents/MacOS/winvm`
into `~/.local/bin`.

**`.macos-builder/build.sh`** (unsigned output, as maximal's):

1. Stamp the version into `tauri.conf.json` and check it.
2. `mise install` from `.bun-version`; `pnpm install --frozen-lockfile`.
3. Build the sidecar (`bun build --compile`, aarch64-apple-darwin triple).
4. Fetch the runtime named by `runtime.json`, verify it, unpack it into
   `Resources/runtime/`.
5. Delete the previous bundle, `tauri build --bundles app`.
6. Assert the bundle's version, that every runtime file matches
   `manifest.json`, and that the files to sign match `.macos-builder/config`.

**`.macos-builder/config`.** `bundle_id=co.stuffbucket.winvm`,
`entitlements=bun-runtime`, `artifact=dmg`, and `sign_nested` listing the
sidecar (`bun-runtime`), `qemu-system-aarch64` (`qemu-hvf`), and every other
runtime binary and dylib (`default`). The list is generated from the runtime's
`manifest.json` by a script and checked in; CI fails if it is stale, so a pin
change that adds a dylib cannot reach the builder unsigned.

**macos-builder changes** (reviewed changes in that repository):

- A `qemu-hvf` entitlement profile: `com.apple.security.hypervisor`, hardened
  runtime. Nothing else unless a notarized build proves it needs more.
- Its name added wherever profiles are enumerated (`build.yml`,
  `scripts/preflight.sh`, the issue-config scripts).

**Setup only the user can do:** winvm in `ALLOWED_CLIENTS`; an approved
build-config issue creating `clients/stuffbucket/winvm.policy`
(`bundle_id_allowed=co.stuffbucket.winvm`,
`entitlements_allowed=bun-runtime,qemu-hvf,default`, `artifact_allowed=dmg`);
app-repoman installed on winvm; the `MACOS_BUILDER_PAT` secret.

**Release workflows** as in the earlier design (release-please, draft release,
`macos-dmg` job, publish once, manual `macos-build.yml`). The release notes
link the runtime release and its sources tarball. `winvm notice` prints the
licences of everything bundled, as bladerunner's `br notice` does.

**First notarized build check:** the notarized app boots a guest, reboots it
and loads a save, on a Mac that has never had Homebrew's QEMU.

## 4. First run and the ISO

1. **Host checks:** Apple Silicon, macOS 15 or later, about 25 GB free on the
   volume holding `WINVM_HOME`, the bundled runtime verified.
2. **The ISO:** "Get Windows 11 for Arm" opens Microsoft's download page. The
   user chooses the downloaded file, or drops it on the window. winvm does not
   fetch it itself: Microsoft's links are per-session and expire, and scraping
   them breaks.
3. **Checks on the ISO, read-only:** it has an ARM64 boot loader
   (`efi/boot/bootaa64.efi`) and `sources/install.wim` or `install.esd`. Its
   SHA-256 is compared with `packages/core/known-isos.json`, Microsoft's
   published checksums for the Arm64 ISO. A known ISO is accepted. An unknown
   one (Microsoft re-releases them) needs the user to confirm, or
   `--accept-unknown-iso` on the CLI.
4. **Build** the base image with progress from the service's event stream.
   The guest-tools ISO and PowerShell are fetched pinned, as today. The image
   metadata records the ISO's checksum.
5. The ISO is left exactly where it was.

## Settled after review

A builder read this design cold and asked four questions. My calls:

- **Saves across a pin change.** A save's `compatParts.qemu` becomes the QEMU
  version plus a digest of the runtime's QEMU patch set (from
  `manifest.json`), e.g. `11.1.2+patches:none`. A runtime revision that only
  rebuilds libraries keeps saves loadable; a new QEMU version or patch set
  refuses them, which is when golden and baseline saves need rebuilding. One
  runtime in the cache stays enough.
- **Hosts.** Acceptance runs on the Macs we have: today one M2 Ultra on macOS
  26. The build targets macOS 15, the README lists the hosts each pin was
  accepted on, and `doctor` says when the host's macOS or chip family is not
  among them, without refusing. M4-only problems (Rancher's SME patch) are
  untested until an M4 is available.
- **UTM guest tools.** `utm-guest-tools-latest.iso` is a redirect to an
  immutable release asset,
  `github.com/utmapp/qemu/releases/download/v10.0.2-utm/utm-guest-tools-0.1.271.iso`,
  whose GitHub digest is the one winvm already pins. winvm pins that URL
  instead of "latest", so a new UTM release cannot break first run. Nothing is
  re-hosted.
- **"Byte-identical" inside the app.** macos-builder re-signs every Mach-O
  file, so the app's copies differ from the tarball in their signatures only.
  In the app, "verified" means a valid Developer ID signature from the
  expected team on every runtime binary (macOS enforces it at launch anyway)
  and `manifest.json` hashes for the non-Mach-O files. The cached runtime on
  developer machines is checked against every hash.

## Order of work

- **5a:** `stuffbucket/winvm-runtime`: recipe, CI, release `11.1.2-1`,
  acceptance on a real Mac.
- **5b:** winvm uses only the runtime: `runtime.json`, the cache, the lookup
  order, the mise hook and `setup`, macOS 15 check, image metadata.
- **5c:** macos-builder `qemu-hvf` profile and winvm policy; `.macos-builder/`
  files; release workflows. Needs plan 4's Tauri app.
- **5d:** first-run ISO flow in the app. Needs plans 3 and 4.

5a and 5b do not depend on the app and can land first; after 5b, Homebrew is
out of winvm entirely.

## Left to the builder

- Whether mise's `github` backend can install the runtime directly instead of
  the hook fetching it (one pin either way: `runtime.json` stays the source).
- How the packaging script finds the files to bundle (`otool -L` closure,
  `fs_usage`/`filemonitor` while booting, or both).
- The exact `share/qemu` file list, and whether swtpm needs `swtpm_setup`.
- The format of `known-isos.json` and where its checksums come from.
