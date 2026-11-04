# Saved Display Restore Specification

## Goal

Adapt the behavior of commit `2685adb` to current `main`: a file save must
restore with the display hardware that was actually running when the save was
captured, even when the instance's cold-boot display preference has since
changed.

## Required behavior

- Treat `display.json` as a cold-boot preference. It may differ from the display
  hardware of the running QEMU process.
- When creating a file save, identify the running QEMU display launch profile,
  record it in the manifest, and use that same profile for the compatibility
  hash.
- Refuse to create a save when the running display profile cannot be identified;
  never stop or migrate the guest first and then discover this uncertainty.
- When loading a profiled save, validate compatibility against its recorded
  display and launch QEMU with exactly that validated display.
- Loading a save must not temporarily or permanently rewrite `display.json`.
  The next cold boot continues to use the person's configured preference.
- A save made after restoring another save captures and hashes the restored
  running display, not the pending cold-boot preference.
- Preserve the profile through clone, retained-save recreation, stow recall,
  baseline reuse, save listing, and status/viewer reporting.
- For a running instance, status reports the launch display actually in use;
  for a stopped instance it reports the configured cold-boot preference.
- QEMU argument construction and sidecar startup resolve the same display, so
  display-dependent shared-folder devices and `virtiofsd` cannot disagree.

## Compatibility

- New manifests carry an optional display profile representing current
  `DisplayConfig`: `ramfb`, `virtio-gpu`, or a legacy virtio-gpu launch with
  `legacySize`.
- Validate manifest display data defensively.
- Legacy saves without a display profile retain strict existing compatibility
  behavior and receive actionable guidance when their original display must be
  restored manually.
- Do not infer missing launch provenance from an opaque legacy compatibility
  hash.
- Preserve the current per-save processor/memory behavior and compatibility
  reporting, including share-device incompatibility explanations.

## Scope exclusions

- Internal QEMU `savevm`/`loadvm` snapshot behavior or metadata.
- Live display resizing behavior.
- Compression or save/restore performance work.
- Legacy runtime-key migration.
- General provenance for pending hardware settings other than display.
- Existing instance-creation side effects before retained-load or clone
  compatibility refusal.

## Acceptance

Automated tests must prove at least:

1. Save under display A, configure display B, load the save under A, and leave
   the configured preference B unchanged.
2. The inverse direction between ramfb and virtio-gpu.
3. A post-restore save records and hashes A again.
4. An unidentified running display is refused before migration begins.
5. Clone, retained-save recreation, stow, baseline, listing, and status use the
   saved/running profile correctly.
6. Malformed profiles and unrelated compatibility mismatches are rejected
   before disks are replaced or the guest is stopped.
7. QEMU sidecar startup uses the same resolved display as QEMU arguments.
8. Existing typechecks and tests remain clean.
