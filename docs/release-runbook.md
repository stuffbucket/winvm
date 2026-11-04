# Release runbook

winvm releases by merging one PR: the release PR that release-please keeps open.
Merging it IS the decision to publish. One run of `.github/workflows/release.yml`
then tags the commit, builds and signs the app on `stuffbucket/macos-builder`,
checks everything and publishes. Nothing else needs running, and no tag is made
by hand.

## Checklist

1. **Pre-flight** (before merging the release PR)
   - `gh pr list --repo stuffbucket/winvm --label "autorelease: pending"`: one
     open PR `chore(main): release X.Y.Z`. Read its changelog.
   - The PR's `check` and `signing preflight` are green for its head commit
     (the run `release.yml` dispatched for it; see Release PR CI below).
   - If `packages/core/runtime.json` changed since the last release, the
     builder's policy already matches (Changing the runtime). `signing
     preflight` fails the PR when it can read the policy and it does not; when
     it warns that it could not, run `bun scripts/preflight-signing.ts` yourself.
2. **Merge the release PR.** The `Release` run starts on the push to main.
3. **Watch the run** (`gh run list --repo stuffbucket/winvm --workflow release.yml --limit 3`).
   About 6 minutes: `release-please` (seconds), then `check` and `build` in
   parallel (`build` is the builder, about 4 minutes), then `publish`.
   If the builder refuses, `build` fails within about 30 seconds and its
   summary shows the builder's error lines.
4. **Recovery**: fix the cause, then **Re-run failed jobs** on the same run.
   Never tag by hand, never dispatch anything.
5. **Post-verify**: the `publish` job already checks that the release is no
   longer a draft and that `latest.json` is served with the new version. For the
   signature and notarization checks on the files, see the winvm-release skill.

`Release-As: X.Y.Z` in a commit body forces a version. Pre-1.0 `feat:` and `fix:`
commits both produce patch releases.

## The run

| Job | What it does |
|---|---|
| `release-please` | The official `googleapis/release-please-action`. On a push to main it opens or updates the release PR (version, `CHANGELOG.md`). When the merged commit is a release PR it creates the tag `vX.Y.Z` and the **draft** GitHub release (`draft` and `force-tag-creation` in `release-please-config.json`; the changelog is the release notes) and moves the PR's label to `autorelease: tagged`. Outputs the tag; the jobs below run only when a release was created. |
| `release-pr-ci` | When release-please created or moved the release PR's branch (or `force_ci` is set), dispatches `ci.yml` for its exact head commit with `scripts/release-please-ci.ts` (GITHUB_TOKEN pushes trigger no `pull_request` run). |
| `check` | At the tag: lockfile policy, `pnpm check`, the SBOM and its license scan. Uploads the SBOM as a run artifact. Runs while the builder builds. |
| `build` | `release` environment. Mints an app-repoman token (Actions only, macos-builder only, one hour), then `scripts/release-builder.sh`: dispatches `build.yml` on macos-builder, takes the run id from the dispatch response, polls that run and fails with the builder's `##[error]` lines when it fails. The builder uploads `winvm-vX.Y.Z-darwin-arm64.dmg`, the update bundle `winvm-vX.Y.Z-darwin-arm64.app.tar.gz` and their `.sha256` and `.sig` files to the draft (30-minute limit; real runs about 4 minutes). |
| `publish` | `scripts/release-assets.sh`: checks the bundle's signature the way the app will (`scripts/updater-manifest.ts`), adds `latest.json`, `SBOM.cdx.json` and the signed keeper from inside the bundle (`winvm-keeper-vX.Y.Z-darwin-arm64` with its `.sha256`), and fails unless the draft holds exactly these 9 assets: the dmg, the bundle and the keeper with their `.sha256`, the bundle's `.sig`, `latest.json`, `SBOM.cdx.json`. Links the pinned winvm-runtime release in the notes, then publishes (`--latest`, or `--prerelease` for a tag with a `-`): the last change to the release. Then checks the release is not a draft and that `latest.json` serves the new version. |

Every step reuses what exists (the tag, the draft, assets already uploaded) and a
release that is already published is never modified, so Re-run failed jobs is
always safe. A failed `check` or `build` leaves the release a draft.

If a failure needs a change in this repository (not in macos-builder), the tag
cannot move: merge the fix, delete the stale draft and tag
(`gh release delete vX.Y.Z --cleanup-tag --yes`), and the fix ships in the next
patch release.

Manual tags are not a supported path: `release.yml` does not run on a tag push,
and a hand-made tag has no draft or notes from release-please. The one
exception is a rehearsal tag, below.

## Rehearsal

Exercise the pipeline end to end without a public release. After this workflow
is on main (it does nothing until a release PR merges):

```sh
git fetch origin
git tag v0.0.0-rehearsal.1 origin/main && git push origin v0.0.0-rehearsal.1
gh workflow run release.yml --ref main -f rehearse_tag=v0.0.0-rehearsal.1
gh run list --repo stuffbucket/winvm --workflow release.yml --limit 1
```

It must be a pre-release tag on a commit of main, and the run must start from
main. It makes a pre-release draft for the tag, runs `check`, `build` (a real
signed and notarized build) and the asset step, then stops: no publish. Look at
the draft's assets, then clean up:

```sh
gh release delete v0.0.0-rehearsal.1 --repo stuffbucket/winvm --cleanup-tag --yes
```

A rehearsal proves the environment access, the app token, the dispatch and the
builder's run id, the builder's output names (including `dmg_name`), the asset
list and the `check` job. It does not prove release-please's own tag and draft
creation or the publish and post-publish steps; those first run for real, so
watch the first release.

## Expected builder output

The app contains the Tauri shell (`Contents/MacOS/winvm-viewer`), the compiled
CLI (`Contents/MacOS/winvm`), the keeper (`Contents/MacOS/winvm-keeper`, built
from `native/keeper`), winvm's data files (`Contents/Resources/winvm`) and the
pinned runtime (`Contents/Resources/runtime`). The builder signs every file in
`.macos-builder/config`'s `sign_nested`: the CLI with `bun-runtime`, QEMU with
`qemu-hvf`, and the keeper and every other runtime binary and library with
`default`. The build fails when that list no longer matches the bundle, and the
builder refuses it unless it equals `sign_nested_allowed` in its policy.

For an optional local check, build the app the way the builder does:

```sh
mise -C apps/viewer exec -- bun scripts/build-app.ts
```

## App updates

The app checks
`https://github.com/stuffbucket/winvm/releases/latest/download/latest.json` at
launch and from **winvm → Check for Updates…**, and offers to install a newer
version. It installs only a bundle signed by the key in `plugins.updater` of
`apps/viewer/src-tauri/tauri.conf.json` (key id E4167998E5A196BB) for that
version. `scripts/updater-manifest.ts` runs the same check before
`latest.json` is attached.

The private key is in macos-builder's `signing` environment
(`TAURI_SIGNING_PRIVATE_KEY__WINVM` and its password, with
`updater_key_id = winvm` in winvm's policy), and is backed up outside GitHub.
Installed apps accept only that key, so losing it means every user reinstalls
from a DMG.

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
4. The signing list. `bun scripts/preflight-signing.ts` checks that
   `.macos-builder/config`'s `sign_nested` equals the runtime's Mach-O files
   and the builder's policy (it reads the policy with your `gh` login, or with
   `BUILDER_POLICY_TOKEN`). `signing preflight` in CI runs the same on every
   PR. If the runtime's files changed, run
   `bun apps/viewer/scripts/sign-list.ts --write <winvm.app>` and commit the
   result, and get the policy in macos-builder updated FIRST: a build-config
   issue approved by a maintainer, or a reviewed PR editing `sign_nested_allowed`
   in `clients/stuffbucket/winvm.policy`. The builder compares the two as exact
   strings, so order matters. Merge that before the release PR.

A new QEMU version or patch set makes existing saves refuse to load, so golden
and baseline saves need rebuilding.

## Pinning the keeper

CLI-only installs get the keeper from `packages/core/keeper.json`, which pins
one release's `winvm-keeper-vX.Y.Z-darwin-arm64` by SHA-256. A release can't
pin its own keeper, because the signed bytes exist only after macos-builder
runs. So after a release whose keeper changed (any change under
`native/keeper`), open a PR that sets:

- `version` to the tag, for example `v0.2.0`;
- `url` to
  `https://github.com/stuffbucket/winvm/releases/download/v0.2.0/winvm-keeper-v0.2.0-darwin-arm64`;
- `sha256` to the hash in that asset's `.sha256`.

Then, from a source checkout without the app and without `WINVM_KEEPER`, check
that `winvm setup` downloads it and `winvm doctor` reports
`keeper … (cache)`. While all three fields are `null`, nothing is downloaded,
and `doctor` reports the keeper as not installed. The app always uses its own
`Contents/MacOS/winvm-keeper`, whatever the pin says.

## Release PR CI

release-please opens the release PR with `GITHUB_TOKEN`, and pushes made with it
trigger no `pull_request` workflows. `release-pr-ci` therefore dispatches `ci.yml`
with `expected_sha`, which fails if the branch moved. The dispatched run's
checks attach to the PR's head commit by SHA. To make `pull_request` CI run
normally and drop `release-pr-ci`, give release-please-action an app token
instead (`actions/create-github-app-token` with Contents and Pull requests:
write on winvm) from a job that can use the `release` environment. That puts the
app key within reach of every push to main, so it is not done.

## Recovery

| Failure | Action |
|---|---|
| `build` failed: the builder refused (policy, sign list, notarization) | Read the error in the job summary. If it is in macos-builder (policy, signing), fix it there, then **Re-run failed jobs**: `build` starts a fresh builder run and `publish` follows. If it is in this repository, see above: fix forward. |
| `check` failed (tests, licenses, lockfile policy) | The tag cannot move: fix on main, delete the draft and tag, and release the fix as the next patch. |
| `build` timed out or the run was cancelled | The builder run is not cancelled. Wait for it to end, then Re-run failed jobs. |
| `publish` failed before publishing | Re-run failed jobs (every step is repeatable). |
| `publish` failed after publishing (the post-publish check) | The release is live. Look at what the check reports; do not modify the release. |
| The release PR's `check` never ran, or needs running again | `gh workflow run release.yml --ref main -f force_ci=true` dispatches CI for its current head. |
| `release-please` created no release after the merge | Run `release.yml` with no input (`gh workflow run release.yml --ref main`); it finds the merged, unreleased PR. |
| A published asset is wrong | Cut a new patch release. |

## Release safety and signing

- Published releases, tags and assets are immutable by rule (GitHub's
  `immutable` flag is off). Attach and verify every asset while the release is
  still a draft; never delete, retag, replace or append assets after publishing.
  Cut a new patch release for any correction.
- Publishing is the last step of `publish`, in the same run, on merge of the
  release PR. Do not publish a draft by hand unless the maintainer has told you,
  for that tag, to.
- The private `stuffbucket/macos-builder` exclusively owns macOS packaging,
  signing, notarization and stapling; winvm holds no Apple credentials. Its
  `build.sh` builds the app with the keychain locked.

## One-time setup

- `stuffbucket/winvm` in macos-builder's `ALLOWED_CLIENTS`.
- An approved build-config issue in macos-builder creating
  `clients/stuffbucket/winvm.policy`: `bundle_id_allowed=co.stuffbucket.winvm`,
  `entitlements_allowed=default,bun-runtime,qemu-hvf`, `artifact_allowed=dmg`.
  It needs the `qemu-hvf` profile (stuffbucket/macos-builder#28). A reviewed
  PR then added `updater` and `updater_key_id = winvm`
  (stuffbucket/macos-builder#33).
- The app-repoman GitHub App installed on winvm (Contents: read and write).
  The builder checks winvm out and uploads the DMG with it.
- app-repoman with Actions: read and write on `stuffbucket/macos-builder`, and
  a `release` environment in winvm holding the variable `APP_ID` (3892691) and
  the secret `APP_PRIVATE_KEY` (an app-repoman private key; maximal's `release`
  environment holds the same one). `build` mints a token from them that can
  only run workflows on macos-builder, for an hour. App keys don't expire,
  unlike a PAT; revoke one on the app's settings page.
- **The `release` environment's deployment branches must allow `main`** (the run
  starts on a push to main now; `v*` tags no longer run anything):
  `gh api -X POST repos/stuffbucket/winvm/environments/release/deployment-branch-policies -f name=main -f type=branch`.
  Only reviewed code on main can reach the key, because main requires a PR.
- Actions can create pull requests (Settings, Actions, General; on as of
  2026-11-03).
- Optional: the repository secret `BUILDER_POLICY_TOKEN`, a fine-grained token
  with Contents: read on `stuffbucket/macos-builder` only, lets `signing
  preflight` check the policy in CI. Without it the check warns and the policy
  comparison is manual (`bun scripts/preflight-signing.ts`).
- Optional: the labels `autorelease: pending` and `autorelease: tagged`.
  release-please adds them itself, and creating them first removes any doubt.
- Recommended: require `check` and `signing preflight` on main in a ruleset.
  The current rulesets (Protect main, Require PR) do not require a status
  check.
