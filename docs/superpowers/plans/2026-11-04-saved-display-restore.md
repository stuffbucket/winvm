# Saved Display Restore Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make file saves capture and replay the running QEMU display launch profile without changing the instance's cold-boot display preference.

**Architecture:** Follow the current per-save CPU/memory pattern: parse the running QEMU command line into a validated `DisplayConfig`, store it in the manifest, calculate compatibility at that saved profile, and pass the exact resolved profile into restore launch. Keep `display.json` solely as the stopped/cold-boot preference. Extend reporting and sidecar startup so all consumers use the same resolved running/saved profile.

**Tech Stack:** TypeScript, Bun tests, QEMU command-line generation, pnpm/Turborepo.

**Spec:** `docs/superpowers/specs/2026-11-04-saved-display-restore.md`

## Global Constraints

- Implement only file-save display provenance and replay.
- Preserve current live-resize behavior; framebuffer size is not part of a modern virtio-gpu save profile.
- Preserve current per-save processor/memory and share-device compatibility behavior.
- Never rewrite `display.json` during save loading.
- Legacy saves without `manifest.display` retain strict existing compatibility behavior; do not infer missing provenance from their hashes.
- Do not change internal QEMU snapshot behavior, compression/performance, runtime-key migration, or non-display hardware provenance.
- Use conventional commit messages without references to Claude or emojis.
- Never use destructive Git cleanup/reset commands.

## Review Focus

- A saved ramfb profile restored while the preference is virtio-gpu must not start virtiofsd or add share devices.
- A saved virtio-gpu profile restored while the preference is ramfb must start virtiofsd and add the matching share devices.
- A valid legacy virtio-gpu `legacySize` profile must round-trip exactly; malformed profile shapes must be rejected.
- Compatibility failures must happen before stopping QEMU or replacing disks, with the preference file unchanged.
- Running status must use the process's actual display; stopped status must use the configured preference.

---

### Task 1: Capture and replay display provenance

**Files:**
- Modify: `packages/core/src/display.ts`
- Modify: `packages/core/src/guestdisplay.ts`
- Modify: `packages/core/src/qemu.ts`
- Modify: `packages/core/src/saves.ts`
- Modify: `packages/core/src/savecmds.ts`
- Modify: `packages/core/src/status.ts`
- Modify: `packages/core/src/screen.ts`
- Create: `packages/core/tests/saved-display.test.ts`
- Modify: `packages/core/tests/display.test.ts`
- Modify: `packages/core/tests/saves.test.ts`
- Modify if needed for the display-aware memo key: `packages/core/tests/hardware.test.ts`

**Interfaces:**
- Produces: `parseDisplayConfig(value: unknown): DisplayConfig | null` in `display.ts`.
- Produces: `displayFromCommandLine(command: string): DisplayConfig | null` in `display.ts`, accepting exactly one `-device ramfb`, `-device virtio-gpu-pci`, or legacy `-device virtio-gpu-pci,xres=W,yres=H` and rejecting ambiguous/unrelated matches.
- Produces: `runningDisplay(pid: number): DisplayConfig | null` in `display.ts`, using untruncated `ps` output.
- Extends: `Manifest` with `readonly display?: DisplayConfig`.
- Extends: `compatFor(instance, meta, manifest)` so its result includes the single resolved display used for both compatibility hashing and launch.
- Extends: `ReportContext.at` so the memoization key and compatibility calculation include both saved hardware and saved display.
- Consumes: existing `LaunchOptions.display`, `currentCompat(instance, meta, display?, hardware?)`, `DisplayConfig.legacySize`, and the per-save hardware pattern.

- [ ] **Step 1: Add failing pure parser and manifest tests**

Add tests that assert:

- valid ramfb, plain virtio-gpu, and virtio-gpu with `legacySize` profiles parse and round-trip;
- `null`, arrays, unknown devices, partial/non-integer/out-of-range `legacySize`, and extra invalid launch arguments are rejected;
- command-line parsing requires exactly one `-device` display and ignores `-name` text;
- a manifest without `display` remains valid and has `display === undefined`.

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `pnpm --dir packages/core exec bun test tests/display.test.ts tests/saves.test.ts tests/saved-display.test.ts`

Expected: FAIL because the strict parser, running-profile manifest field, and replay behavior do not exist.

- [ ] **Step 3: Implement strict display profile parsing and running-process capture**

In `display.ts`, keep `readDisplay` tolerant for user preference files, but add strict manifest/command-line parsing for `DisplayConfig`. Add `runningDisplay(pid)` using `ps -ww -o command=`. Make `guestdisplay.liveDevice` and `deviceFromCommandLine` delegate to this shared parser rather than maintaining a looser regex.

- [ ] **Step 4: Add failing save/load provenance tests**

In `saved-display.test.ts`, adapt the fixtures from commit `2685adb` to current `DisplayConfig` and share-device behavior. Cover:

- create captures the running profile while the preference differs and hashes that same profile;
- unknown running display refuses before any QMP command or save directory creation;
- load ramfb under a virtio-gpu preference launches ramfb without shared-folder devices or virtiofsd and leaves `display.json` byte-identical;
- load virtio-gpu under a ramfb preference launches virtio-gpu with the matching memory backend/share devices and starts virtiofsd;
- a saved `legacySize` is replayed exactly;
- a save made after restore captures the restored profile again;
- retained-save recreation and clone preserve/replay the profile without rewriting the preference;
- malformed/incomplete saves and base/hardware/firmware/QEMU mismatches fail before quit/disk replacement;
- legacy saves without `display` retain current strict preference-based behavior.

- [ ] **Step 5: Implement manifest, compatibility, create, clone, and load changes**

In `saves.ts`:

- validate and retain optional `Manifest.display`;
- capture `runningDisplay(pid)` before stopping/migrating in `createSave`, refuse `null`, and pass it to `currentCompat`;
- write the captured profile into the manifest;
- resolve `m.display ?? readDisplay(pathsFor(instance))` once in `compatFor`, include it in `currentCompat`, and return it;
- remove the new-instance `writeDisplay` probing loop from `loadSave`;
- pass the resolved display and saved hardware to `qemu.launch`;
- make clone, report context, listing, stow recall, and baseline reuse consume the same display-aware compatibility decision;
- retain actionable legacy-save guidance without attempting inference.

- [ ] **Step 6: Make QEMU arguments and sidecar startup use one resolved display**

In `qemu.ts`, resolve the effective display from install mode / `LaunchOptions.display` / `readDisplay` once per path. Ensure `qemuArgs` and `launch` use the same value when choosing share devices and whether to start virtiofsd. Do not alter the special install-media ramfb behavior.

- [ ] **Step 7: Add failing reporting and switching tests**

Cover:

- running status reports the actual process display while stopped status reports the preference;
- `savecmds.list --json` reports profiled saves compatible under a different preference, including retained saves;
- stow recall and baseline reuse work across preference changes;
- switching devices does not claim profiled saves are stranded, while legacy saves retain strict behavior.

- [ ] **Step 8: Implement reporting and switching behavior**

Update `status.ts`, `savecmds.ts`, and `screen.ts` to use the running/saved profile. Preserve the stow switch guard. Update CLI text only where necessary to distinguish profiled file saves from legacy file saves and internal snapshots.

- [ ] **Step 9: Run focused tests and verify GREEN**

Run: `pnpm --dir packages/core exec bun test tests/display.test.ts tests/saves.test.ts tests/hardware.test.ts tests/saved-display.test.ts tests/ui.test.ts`

Expected: all selected tests pass with pristine output.

- [ ] **Step 10: Run package typecheck and full baseline**

Run: `pnpm --dir packages/core exec tsc --noEmit -p tsconfig.json`

Run: `env TURBO_FORCE=true pnpm check`

Expected: all typechecks and tests pass, with zero failed tasks.

- [ ] **Step 11: Commit Task 1**

```bash
git add packages/core/src/display.ts packages/core/src/guestdisplay.ts packages/core/src/qemu.ts packages/core/src/saves.ts packages/core/src/savecmds.ts packages/core/src/status.ts packages/core/src/screen.ts packages/core/tests/saved-display.test.ts packages/core/tests/display.test.ts packages/core/tests/saves.test.ts packages/core/tests/hardware.test.ts
git commit -m "fix(saves): restore the captured display configuration"
```

### Task 2: Document and exercise cross-device restore

**Files:**
- Modify: `docs/saves.md`
- Modify: `docs/setup.md`
- Modify: `docs/windows-vm-qemu.md`
- Modify: `packages/core/src/display.ts` (comments only, if not already updated)
- Modify: `packages/core/src/commands.ts` (help text only)
- Create: `scripts/accept-saved-display.ts`
- Modify: `docs/superpowers/specs/2026-11-04-saved-display-restore.md` only if implementation discovers a factual mismatch

**Interfaces:**
- Consumes: Task 1 manifest display profile, compatibility decision, and running-status behavior.
- Produces: a standalone disposable acceptance runner that takes an immutable image directory and never touches an existing `WINVM_HOME`.

- [ ] **Step 1: Update user and architecture documentation**

Document that new file saves replay captured display hardware while preserving the cold-boot preference; legacy file saves and internal snapshots still require their original display. Remove claims that all file saves are stranded by a display switch. Keep live resizing documentation unchanged.

- [ ] **Step 2: Add a disposable acceptance runner**

Adapt `scripts/accept-saved-display.ts` from commit `2685adb` to current device-based behavior. Use a fresh temporary `WINVM_HOME`, APFS-clone an explicitly supplied immutable image, exercise zstd and mapped saves across ramfb/virtio-gpu preference changes, and verify:

- manifest profile;
- unchanged preference;
- running status device;
- disk marker and fresh command nonce;
- guest clock within five seconds;
- nonempty screenshot;
- post-restore save compatibility;
- retained-save recreation.

Always stop disposable processes; remove temporary state only after success and retain it on failure for diagnosis.

- [ ] **Step 3: Verify documentation/script build and full suite**

Run: `bun build scripts/accept-saved-display.ts --target=bun --outfile=/tmp/winvm-accept-saved-display.js`

Run: `env TURBO_FORCE=true pnpm check`

Expected: the script builds and the full suite passes with zero failed tasks.

If a suitable immutable image directory is available, also run:

`bun scripts/accept-saved-display.ts /path/to/immutable/image-directory`

Expected: `PASS` for zstd/mapped capture, restore, provenance, status, disk, nonce, clock, screenshot, post-restore save, and recreation. Do not substitute an existing mutable user instance.

- [ ] **Step 4: Commit Task 2**

```bash
git add docs/saves.md docs/setup.md docs/windows-vm-qemu.md packages/core/src/display.ts packages/core/src/commands.ts scripts/accept-saved-display.ts docs/superpowers/specs/2026-11-04-saved-display-restore.md docs/superpowers/plans/2026-11-04-saved-display-restore.md
git commit -m "docs(saves): explain captured display restore"
```
