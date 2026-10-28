# Release runbook

winvm releases through one protected PR merge: the generated release PR. CI
builds and verifies the release before publishing it. The one asset, a signed
and notarized `.dmg`, comes from `stuffbucket/macos-builder`.

## Release checklist

1. Review the `chore(main): release X.Y.Z` PR, wait for its required `check`
   (dispatched against the PR's exact head SHA), and confirm it is current with
   `main`.
2. Merge the release PR. Do not create or move a tag during the normal flow.
3. Open the resulting `release.yml` run. When `release` has made the draft,
   start the signed build; its `macos-dmg` job prints the command in its
   summary:

   ```sh
   gh workflow run build.yml --repo stuffbucket/macos-builder --ref main \
     -f repo=stuffbucket/winvm -f ref=vX.Y.Z
   ```

   winvm stores no token for macos-builder, so nothing starts this
   automatically: each signed build is a deliberate step by someone with
   access to the builder.
4. `macos-dmg` waits about 50 minutes for the DMG, attaches it, and `publish`
   publishes. Confirm the GitHub release changes from draft to published.

For an optional local check, build the app the way the builder does:

```sh
mise -C apps/viewer exec -- bun scripts/build-app.ts
```

`Release-As: X.Y.Z` in a commit body forces a version. Pre-1.0 `feat:` commits
otherwise produce patch releases.

## Expected results

| Job | Expected result |
|---|---|
| `release` | `pnpm check`, the draft release, notes (changelogithub, or generated notes for the first release), a link to the pinned winvm-runtime release, and `SBOM.cdx.json` with a license scan |
| `macos-dmg` | Prints the command that starts the signed build, then attaches `winvm-vX.Y.Z-darwin-arm64.dmg` and its `.sha256` (signed, notarized and stapled by `stuffbucket/macos-builder`) once the builder uploads it |
| `publish` | Publishes only after `release` and `macos-dmg` succeed |

The app contains the Tauri shell (`Contents/MacOS/winvm-viewer`), the compiled
CLI (`Contents/MacOS/winvm`), winvm's data files (`Contents/Resources/winvm`)
and the pinned runtime (`Contents/Resources/runtime`). The builder signs every
file in `.macos-builder/config`'s `sign_nested`: the CLI with `bun-runtime`,
QEMU with `qemu-hvf`, and every other runtime binary and library with
`default`. `build.sh` fails when that list no longer matches the bundle; run
`bun apps/viewer/scripts/sign-list.ts --write <winvm.app>` after a runtime pin
change and commit the result.

A failed publish gate leaves the release as a draft.

## Changing the runtime

QEMU, swtpm and zstd come from `packages/core/runtime.json`, which pins a
`stuffbucket/winvm-runtime` release by SHA-256. Change it only in a PR that
records that release's acceptance and the Mac it ran on:

1. `scripts/check.sh` in winvm-runtime passes on the release tarball (CI runs
   it too): every binary stands alone, the websocket handshake and a PNG
   screendump work, and `paths.py` runs the other QEMU paths winvm uses on
   TCG (qemu-img, saves in each format, snapshots, port forwards, virtio-gpu).
2. `scripts/accept-runtime.sh <instance>` passes against a fresh instance in a
   scratch `WINVM_HOME`, with `WINVM_RUNTIME` pointing at the unpacked
   release. It runs the guest under HVF through winvm itself, including
   reboots after saves, and fails on any QEMU, swtpm or zstd crash report. A
   failure leaves the guest running: inspect it before stopping it.
3. The cage check.

A new QEMU version or patch set makes existing saves refuse to load, so golden
and baseline saves need rebuilding.

## Recovery

| Failure | Action |
|---|---|
| A publish-gating job failed | Use **Re-run failed jobs** on the original `release.yml` run. |
| The release workflow was not dispatched | Run `gh workflow run release.yml --ref vX.Y.Z -f tag=vX.Y.Z`. |
| The signed build was started after `macos-dmg` stopped waiting | Once the builder has uploaded `winvm.dmg`, run `gh workflow run finish-release.yml --ref main -f tag=vX.Y.Z`: it attaches the DMG and publishes. |
| The macOS builder failed or was unavailable | Fix the cause, start the signed build again, then rerun `macos-dmg` or run `finish-release.yml`. |
| A published asset is wrong | Cut a new patch release. |

## Release safety and signing

- Published releases, tags and assets are immutable. Attach and verify every
  asset while the release is still a draft.
- Never delete, retag, replace or append assets after publication. Cut a new
  patch release for any correction.
- `publish` is the final draft-to-published transition.
- The private `stuffbucket/macos-builder` exclusively owns macOS packaging,
  signing, notarization and stapling; winvm holds no Apple credentials. Its
  `build.sh` builds the app with the keychain locked.

## One-time setup

- `stuffbucket/winvm` in macos-builder's `ALLOWED_CLIENTS`.
- An approved build-config issue in macos-builder creating
  `clients/stuffbucket/winvm.policy`: `bundle_id_allowed=co.stuffbucket.winvm`,
  `entitlements_allowed=default,bun-runtime,qemu-hvf`, `artifact_allowed=dmg`.
  It needs the `qemu-hvf` profile (stuffbucket/macos-builder#28).
- The app-repoman GitHub App installed on winvm (Contents: read and write).
  The builder checks winvm out and uploads the DMG with it.

winvm deliberately has no `MACOS_BUILDER_PAT`: a stored token would let any
workflow in this public repo start builds on the signing Mac, and it would
expire silently. Starting the build by hand costs one command per release.
