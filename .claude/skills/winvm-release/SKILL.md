---
name: winvm-release
description: Use when cutting, shipping, checking, debugging or recovering a winvm release - the release-please PR and versions, the one-run Release workflow, the signed macOS build on stuffbucket/macos-builder (sign_nested policy, notarization), a rehearsal, re-running a failed release, latest.json / app-update verification, or a runtime pin bump that needs a signing-policy update before the release PR merges. Do not invent release steps; follow this.
---

# winvm release

The pipeline was restructured on 2026-11-03, after v0.1.0-v0.1.3, and brought up to date with main on 2026-11-24 (the signed keeper asset from v0.1.4, and the release PR CI dispatch in `scripts/release-please-ci.ts`). Facts about the OLD pipeline were checked against real runs; the NEW pipeline has been linted (actionlint) and its scripts unit-tested with a fake `gh`, but **has not run for real yet**: `[unverified]` marks every claim that only a real run can confirm. Longer detail: [reference.md](reference.md). Process doc: [docs/release-runbook.md](../../../docs/release-runbook.md).

## STOP: merging the release PR publishes, publicly and irreversibly

Merging the `chore(main): release X.Y.Z` PR makes `release.yml` tag, build, sign and PUBLISH, with no further gate. The release, its tag and `latest.json` go live for every installed app. GitHub's `immutable` flag is `false` on all releases, so immutability is project policy, not enforced: never edit, delete or replace assets after publishing; fix forward with a new patch release.

**An agent may merge a release PR, or publish a draft by hand (`gh release edit --draft=false`), only after the user, in their own words, says to for that specific version** (e.g. "merge the 0.1.4 release PR"). A passing pipeline or an earlier approval is not authorization. Reading runs, previews, local checks and `scripts/preflight-signing.ts` need no approval. Never tag, dispatch (including a rehearsal), label, create releases or comment on issues without being asked.

## Checklist

Pre-flight (before merging the release PR)
- [ ] `gh pr list --repo stuffbucket/winvm --label "autorelease: pending"`: one open release PR; read its body (section 5).
- [ ] Its dispatched CI run is green for the head SHA: `check`, whose `Signing preflight` step runs `scripts/preflight-signing.ts`.
- [ ] Runtime pin (`packages/core/runtime.json`) changed since the last tag? Run `bun scripts/preflight-signing.ts` (section 2). It must print both OK lines. If the policy needs changing, get macos-builder updated FIRST.

Release
- [ ] Merge the release PR (the user said to). No manual tag, no dispatch.
- [ ] `gh run list --repo stuffbucket/winvm --workflow release.yml --limit 3`; watch `release-please` -> `check` + `build` (parallel, ~4 min) -> `publish`. ~6 min total.

Recovery (section 3): read the failed job's summary, fix the cause, **Re-run failed jobs** on the same run. Never re-tag, never dispatch a second workflow.

Post-verify (section 4): `publish` already checks not-draft and `latest.json`'s version; check the 9 assets, then `spctl` / `stapler` / `codesign` / updater signature on the downloaded files.

## 1. Pipeline (one workflow, `.github/workflows/release.yml`)

Triggers: push to `main`; `workflow_dispatch` (empty input = same as a push; `rehearse_tag` = rehearsal, section 6; `force_ci` = run the release PR's CI again). Every run must be on `refs/heads/main` (`release-please-ci.ts validate-trigger`). Concurrency group `release`, never cancels.

| Job | What | Notes |
|---|---|---|
| `release-please` (contents+pull-requests write) | `googleapis/release-please-action@v5.0.0` (pinned by SHA; bundles release-please 17.6.0; the old CLI pin was 17.11.2). Push to main: open/update the release PR. Merged release PR: create tag `vX.Y.Z` (config `force-tag-creation`) and a DRAFT release (config `draft: true`) whose notes are the changelog; relabel the PR `autorelease: tagged`. Before the action, `release-please-ci.ts capture` records the release branch's head (`release_pr_before`). Step `plan` outputs only `tag` (empty: nothing to release); `check` and `build` run when it is set, and `publish` publishes unless `rehearse_tag` was given. | Config: `release-please-config.json`. Replaces the hand-written tag step, the label step (failed on every old release), and the explicit dispatches. `[unverified]` that the action creates the missing `autorelease: tagged` label by itself (it uses the add-labels API, which creates labels). |
| `release-pr-ci` (actions write; skipped in a rehearsal) | `bun scripts/release-please-ci.ts dispatch --before <release_pr_before> --force <force_ci>`: reads the release branch's head with `git ls-remote`; when it is new or moved (or forced), `gh workflow run ci.yml --ref <branch> -f expected_sha=<head>`; absent or unchanged: nothing. Decision in the job summary. | GITHUB_TOKEN-created PRs trigger no `pull_request` CI. The dispatched run's checks attach to the head SHA. |
| `check` (contents read) | At the tag: `apply-pnpm-tarball-policy --check`, `pnpm install --frozen-lockfile`, `pnpm check`, `scripts/sbom.ts` (license allowlist `ALLOWED_LICENSES`); uploads artifact `sbom`. | Parallel with `build`. A failure leaves the draft unpublished. |
| `build` (contents read, `environment: release`) | `create-github-app-token` (app-repoman, `actions: write` on macos-builder only) then `scripts/release-builder.sh TAG`: `gh api POST .../actions/workflows/build.yml/dispatches` with `return_run_details=true` -> `workflow_run_id`; REST-poll that run (10 s, 30 min limit); on failure print the failed jobs' `##[error]` lines to the log and the job summary. | The builder (`stuffbucket/macos-builder` `build.yml`, self-hosted Mac, ~4 min) cannot be a reusable workflow: its runner is registered to the builder repo and the workflow only has `workflow_dispatch`. Polls with `gh api` rather than `gh run watch`, which needs the checks permission the app token lacks. A rerun dispatches a fresh build (the builder serialises per repo+ref). |
| `publish` (contents write) | If still a draft: `scripts/release-assets.sh TAG SBOM.cdx.json` (verify the bundle `.sig` via `scripts/updater-manifest.ts`, add `latest.json` + SBOM, extract the signed `Contents/MacOS/winvm-keeper` from the bundle and add it as `winvm-keeper-vX.Y.Z-darwin-arm64` + `.sha256`, assert EXACTLY 9 assets), add the winvm-runtime link to the notes, then `gh release edit --draft=false --latest` (or `--prerelease` for a tag with `-`). Then verify not-draft and `latest.json` serves the version. | Publishing is the last change. A published release is never modified on a re-run (the draft check skips it). |

Builder side (unchanged): gates the tag (must descend from winvm's default branch) and "Enforce per-repo policy" against `clients/stuffbucket/winvm.policy`, runs `.macos-builder/build.sh` -> `apps/viewer/scripts/build-app.ts <version>` (version injection; runs `sign-list.ts --check`), signs, notarizes, uploads to the draft with `--clobber`. `.macos-builder/config` now sets `dmg_name = winvm-{tag}-darwin-arm64.dmg`, so the dmg arrives under its release name (`[unverified]` until a real build). A stray `winvm.dmg` fails `release-assets.sh`'s exact-asset check.

Other workflows: `ci.yml` (`check`, including its `Signing preflight` step: `scripts/preflight-signing.ts`) on push to main, PRs, and dispatch with `expected_sha`; `site.yml` Pages deploy, not part of releases. **Deleted**: `release-please.yml`, `finish-release.yml`.

## 2. Pre-flight for runtime pin bumps (the v0.1.3 lesson)

The builder signs only the Mach-O files in `sign_nested` (`.macos-builder/config`) and refuses the build unless it equals `sign_nested_allowed` in `clients/stuffbucket/winvm.policy` in macos-builder. The builder sorts the config's entries (`LC_ALL=C sort`) and compares that byte for byte with the policy as stored, so the config may be in any order but the policy must be in sorted order; the build-config flow writes it that way (checked against its `build.yml` on 2026-11-25). `bun scripts/preflight-signing.ts` prints the exact line the policy must hold. A pin that adds or removes a binary or dylib (11.1.2-2 added `virtiofsd`, `libjpeg.8.dylib`) therefore needs the policy changed BEFORE the release PR merges.

```sh
bun scripts/preflight-signing.ts        # from the repo root; ~2 s
```
It (a) fetches the pinned runtime through core's `ensureRuntime` (sha256 and manifest verified) and checks that `sign_nested` equals what `sign-list.ts` makes of `tauri.conf.json`'s `externalBin` plus the manifest's `macho` list (verified 2026-11-25: `sign_nested matches the app's 27 nested binaries`), and (b) reads the policy with `gh` (your login, or `GH_TOKEN` = the `BUILDER_POLICY_TOKEN` secret in CI) and applies the builder's own gate (bundle id, entitlements, artifacts, volname, app_path, and `sign_nested` sorted and compared byte for byte), naming entries added and removed, or printing the exact line when only the policy's order is wrong. Verified against the live policy: passes at v0.1.3's config; fails, naming `virtiofsd:default`, against a policy without it. CI runs it as the `Signing preflight` step of `check` on every run; in CI the policy part needs the optional repo secret `BUILDER_POLICY_TOKEN` (read-only on macos-builder) and otherwise warns `Builder policy not checked` `[unverified]` whether CI currently has the secret (it did not as of 2026-11-03: no repo secrets exist).

If the config mismatches the runtime: `bun apps/viewer/scripts/sign-list.ts --write <winvm.app>` rewrites `sign_nested`; commit it. If the policy differs, update it first, by one of (a human approves):
- Issue `[build-config] stuffbucket/winvm` in stuffbucket/macos-builder (form: repo, bundle id `co.stuffbucket.winvm`, entitlement profiles `default, bun-runtime, qemu-hvf`, artifacts, volname `winvm`, app path, nested-signing map = the new `sign_nested`, justification). Tick BOTH `dmg` and `updater` (#34 did; #31 pre-dates `updater`). A maintainer adds the `approved` label; the bot applies the policy and closes (#31: within a minute; #34 sat at `needs-triage`, never approved).
- Or a reviewed PR in macos-builder editing `sign_nested_allowed` (#33 added `updater`; #35 added the two v0.1.3 entries).
Then re-run the preflight until it passes; only then merge the release PR. New entitlement needs (a new profile) also need `entitlements_allowed` changed.

## 3. Recovery

Everything is **Re-run failed jobs** on the failed `Release` run (`gh run rerun <id> --failed --repo stuffbucket/winvm`; asking for it is a repo write, so do it only when asked). Steps are repeatable: the tag and draft are reused, uploads replace same-named assets, a published release is skipped.

First look: `gh run view <id> --repo stuffbucket/winvm --json jobs` and the failed job's step summary. For the builder run itself: `gh run list --repo stuffbucket/macos-builder --workflow build.yml --limit 5`, `gh run view <builder-id> --repo stuffbucket/macos-builder --log-failed | grep '##\[error\]'`.

| Symptom | Cause / action |
|---|---|
| `build` fails in ~30 s, summary shows `sign_nested '...' is not permitted by policy` (the v0.1.3 case) | Policy not updated (section 2). Get it applied in macos-builder, run `bun scripts/preflight-signing.ts` until it passes, Re-run failed jobs. `publish` then follows on the same run. Old pipeline: 51 min wait plus 3 manual dispatches. |
| `build`: other policy errors (`No build policy`, `not in ALLOWED_CLIENTS`, bundle id/entitlements/artifact/volname/app_path not permitted) | Same route: fix in macos-builder, re-run. |
| `build`: `Tag vX is not contained in ... main` | Provenance gate: the tag must descend from winvm's main. Cannot happen on the normal flow. |
| `build`: producer fails (`sign_nested ... does not match the app's Mach-O files`) | `.macos-builder/config` stale vs the built app. The tag's code is what the builder builds, so the tag cannot be fixed: merge a fix, delete the draft and tag (`gh release delete vX --cleanup-tag --yes`, needs approval), release the next patch. |
| `build`: notarization rejected | Builder `lib/package-macos.sh` runs `notarytool submit --wait` and dumps the log; read the builder run. Re-run failed jobs; if it recurs, fix in macos-builder. `[unverified]` no real instance in history. |
| `build`: "still running after 1800s" | The builder run is not cancelled. Wait for it, then re-run. |
| `build` cannot mint a token / `APP_ID` empty | The `release` environment must admit `main` and hold `APP_ID` + `APP_PRIVATE_KEY`; the app needs Actions write on macos-builder (runbook, One-time setup). |
| `check` red (`pnpm check`, lockfile policy, SBOM "Disallowed licenses") | Tag cannot move: fix on main, delete draft + tag, ship the fix as the next patch. |
| `publish`: "does not hold exactly the expected assets" | The diff is printed. A stray or missing builder file: look at the builder run's upload step and the `dmg_name`/`updater_name` config. Nothing was published. |
| `publish`: updater signature check fails in `updater-manifest.ts` | Wrong key or version in the `.sig` trusted comment (key id `E4167998E5A196BB`, `winvm` key in macos-builder's `signing` environment). Do not publish. |
| `publish`: post-publish check fails | The release is already live. Inspect; do not modify it. |
| `publish`: "has no Contents/MacOS/winvm-keeper" | The builder's bundle lacks the keeper: the build or `sign_nested` dropped it. Nothing was published; fix forward (the tag's code is what was built). |
| The release PR's dispatched `check` never ran, or must run again | `gh workflow run release.yml --ref main -f force_ci=true` (a dispatch: only when asked). |
| Merged release PR but no release/tag | `gh workflow run release.yml --ref main` (no input) runs release-please, which finds the merged, unreleased PR. |
| Release-please job red | Read its step. The old `autorelease: tagged` failure should not recur `[unverified]`; if it does, the label is missing: create it (approval). |
| A published asset is wrong | Cut a new patch release. |

## 4. Verify after publishing

```sh
gh release list --repo stuffbucket/winvm --limit 3            # new tag marked Latest
gh api repos/stuffbucket/winvm/releases/latest --jq .tag_name
curl -sL https://github.com/stuffbucket/winvm/releases/latest/download/latest.json \
  | jq '{version, url: .platforms["darwin-aarch64"].url, sig_len: (.platforms["darwin-aarch64"].signature|length)}'
gh release view vX.Y.Z --repo stuffbucket/winvm --json assets --jq '[.assets[].name]|sort'
```
Expect `latest.json` version `X.Y.Z`, a `darwin-aarch64` signature, and exactly these 9 assets: `SBOM.cdx.json`, `latest.json`, `winvm-vX.Y.Z-darwin-arm64.dmg`, `.dmg.sha256`, `winvm-vX.Y.Z-darwin-arm64.app.tar.gz`, `.app.tar.gz.sha256`, `.app.tar.gz.sig`, `winvm-keeper-vX.Y.Z-darwin-arm64`, `winvm-keeper-vX.Y.Z-darwin-arm64.sha256`. No stray `winvm.dmg`. (`publish` asserts the list before publishing and the version after.)

Those checks only list names and a string. They do not prove the artifacts are signed/notarized. On a Mac, download into an empty scratch dir and run (all verified passing on v0.1.3):
```sh
gh release download vX.Y.Z --repo stuffbucket/winvm --dir "$d" --pattern '*.dmg*' --pattern '*.app.tar.gz*'
(cd "$d" && shasum -a 256 -c winvm-vX.Y.Z-darwin-arm64.dmg.sha256 winvm-vX.Y.Z-darwin-arm64.app.tar.gz.sha256)
spctl -a -t open --context context:primary-signature -v "$d"/winvm-vX.Y.Z-darwin-arm64.dmg   # accepted, Notarized Developer ID
xcrun stapler validate "$d"/winvm-vX.Y.Z-darwin-arm64.dmg
mkdir "$d/app" && tar -xzf "$d"/winvm-vX.Y.Z-darwin-arm64.app.tar.gz -C "$d/app"
codesign --verify --deep --strict --verbose=2 "$d/app/winvm.app"
xcrun stapler validate "$d/app/winvm.app"; spctl -a -t exec -v "$d/app/winvm.app"
bun scripts/updater-manifest.ts --tag vX.Y.Z --file "$d"/winvm-vX.Y.Z-darwin-arm64.app.tar.gz --url x --out "$d/latest.check.json"
```
The last line re-runs the repo's own check of the `.sig` (key id and version); `minisign` itself is not needed. Not verified by any of this: that an already-installed app actually self-updates (needs an older installed build; `[unverified]`).

## 5. Versioning

| Thing | Where |
|---|---|
| Version source | Conventional commits since the last tag, read by release-please (`release-please-config.json`: `release-type: node`, `bump-minor-pre-major`, `bump-patch-for-minor-pre-major`, `include-v-in-tag`, no component in tag). Pre-1.0: `feat` and `fix` -> patch; breaking (`!` / `BREAKING CHANGE`) -> minor. |
| Force a version | `Release-As: X.Y.Z` in a commit body. |
| Written by release-please | root `package.json` `version`, `.release-please-manifest.json` (`"."`), `CHANGELOG.md`. Nothing else. |
| Not bumped | `apps/*/package.json`, `packages/*/package.json` (0.1.0) and `apps/viewer/src-tauri/tauri.conf.json` (0.1.0). The app version is injected at build: `.macos-builder/build.sh` -> `build-app.ts ${TAG#v}` rewrites `tauri.conf.json` on the builder and asserts `CFBundleShortVersionString`. |
| Release notes | release-please's changelog section (the draft's body), plus the winvm-runtime link added by `publish`. The old changelogithub/`--generate-notes` step is gone. Manual tags are not a supported path. The PR body lists only Features, Bug Fixes, Performance Improvements; `docs`, `test`, `ci`, `chore` do not trigger a release by themselves `[unverified]`. |

Preview the next release:
```sh
gh pr list --repo stuffbucket/winvm --label "autorelease: pending" --json number,title,url
gh pr view <n> --repo stuffbucket/winvm --json body,files --jq '.body, [.files[].path]'
git log --format=%s "$(git describe --tags --abbrev=0 origin/main)"..origin/main   # raw commits
```
No open PR means no releasable commit since the last tag (or the next push to main will create it).

## 6. Rehearsal (no public release)

Needs the new workflow on main and the `release` environment admitting `main`. A maintainer (or the user's explicit say-so) creates a pre-release tag on a commit of main and dispatches:
```sh
git tag v0.0.0-rehearsal.1 origin/main && git push origin v0.0.0-rehearsal.1
gh workflow run release.yml --ref main -f rehearse_tag=v0.0.0-rehearsal.1
```
`plan` refuses anything but a pre-release-shaped tag, a non-main run, or a published release. It creates a pre-release draft if none exists, runs `check` and `build` (a real signed, notarized build) and the asset step, then stops before publishing and leaves the draft. Inspect it, then `gh release delete v0.0.0-rehearsal.1 --repo stuffbucket/winvm --cleanup-tag --yes`. It proves env access, the app token, run-id dispatch, builder output names, the asset assertion and `check`; it does not exercise release-please's tag/draft creation or the publish path (first real release).
