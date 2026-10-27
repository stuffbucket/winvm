# Release runbook

winvm releases through one protected PR merge: the generated release PR. CI
builds and verifies the release before publishing it. The one asset, a signed
and notarized `.dmg`, comes from `stuffbucket/macos-builder`.

## Release checklist

1. Review the `chore(main): release X.Y.Z` PR, wait for its required `check`
   (dispatched against the PR's exact head SHA), and confirm it is current with
   `main`.
2. Merge the release PR. Do not create or move a tag during the normal flow.
3. Open the resulting `release.yml` run and wait for every publish-gating job.
4. Confirm the GitHub release changes from draft to published.

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
| `macos-dmg` | `winvm-vX.Y.Z-darwin-arm64.dmg` and its `.sha256`: signed, notarized and stapled Apple Silicon DMG from `stuffbucket/macos-builder` |
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
records that release's acceptance (40 reboots, the cage check, a save and load)
and the Mac it ran on. A new QEMU version or patch set makes existing saves
refuse to load, so golden and baseline saves need rebuilding.

## Recovery

| Failure | Action |
|---|---|
| A publish-gating job failed | Use **Re-run failed jobs** on the original `release.yml` run. |
| The release workflow was not dispatched | Run `gh workflow run release.yml --ref vX.Y.Z -f tag=vX.Y.Z`. |
| The macOS builder failed or was unavailable | Rerun `macos-dmg`, or run `gh workflow run macos-build.yml --ref main -f tag=vX.Y.Z`. |
| `MACOS_BUILDER_PAT` expired | Replace the secret, then rerun `macos-dmg`. |
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
- The `MACOS_BUILDER_PAT` secret on winvm (fine-grained, Actions: write on
  `stuffbucket/macos-builder` only). Note its expiry.
