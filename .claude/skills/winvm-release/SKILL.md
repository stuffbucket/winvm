---
name: winvm-release
description: Use when cutting, shipping, checking, debugging or recovering a winvm release - release-please PRs and versions, the Release / finish-release workflows, the signed macOS build on stuffbucket/macos-builder (sign_nested policy, notarization), publishing a draft release, latest.json / app-update verification, or a runtime pin bump that needs a signing-policy update before tagging. Do not invent release steps; follow this.
---

# winvm release

Facts below were checked against the repo and `gh` history on 2026-11-03 (v0.1.0-v0.1.3). `[unverified]` marks anything not confirmed. Longer detail: [reference.md](reference.md). Process doc: [docs/release-runbook.md](../../../docs/release-runbook.md) (stale in places; see reference.md).

## STOP: publishing is public and irreversible

Publishing a draft (`finish-release`, the `publish` job, `gh release edit --draft=false`) makes the release, its tag and `latest.json` live for every installed app. GitHub's `immutable` flag is `false` on all four releases, so immutability is project policy, not enforced: never edit, delete or replace assets after publishing; fix forward with a new patch release.

**An agent may run publishing only after the user, in their own words, says to publish that specific tag** (e.g. "publish v0.1.4"). "Finish the release", an earlier approval, or a passing pipeline is not authorization. Everything else here (reading runs, previews, local checks) needs no approval. Never tag, dispatch, label or comment on issues without being asked.

## Checklist

Pre-flight (before the release PR merges)
- [ ] `gh pr list --repo stuffbucket/winvm --label "autorelease: pending"`: one open release PR; read its body (section 5).
- [ ] Runtime pin changed since the last tag? (`packages/core/runtime.json`). If yes, run section 2 checks and get the builder policy merged FIRST.
- [ ] Release PR's dispatched `CI` run is green for its head SHA.

Release
- [ ] Merge the release PR (no manual tag).
- [ ] `gh run list --repo stuffbucket/winvm --workflow release.yml --limit 3`: `release` job green, `macos-dmg` running (~5 min builder, waits up to 50).
- [ ] Publish happens in the `publish` job. If you are finishing by hand, the user must have told you to publish (rule above).

Post-verify (section 4): Latest tag, `latest.json`, 7 assets, then `spctl` / `stapler` / `codesign` / updater signature on the downloaded files.

Recovery (section 3): read the first red step, fix its cause, restart the builder, run `finish-release`. Never re-tag.

## 1. Pipeline

| # | Step | Where | Notes |
|---|---|---|---|
| 1 | Conventional commits land on main | `.github/workflows/ci.yml` (PR job `check` rejects non-conventional subjects via `scripts/check-commit-msg.ts`) | A subject release-please cannot parse is silently dropped from the release. |
| 2 | Release PR `chore(main): release X.Y.Z` opened/updated | `release-please.yml`, step "Open or update the release PR" (`release-please@17.11.2`, `release-pr`) | Uses `github.token`, NOT an app token. Branch `release-please--branches--main--components--winvm-workspace`. Label `autorelease: pending`. Edits `package.json` (root), `CHANGELOG.md`, `.release-please-manifest.json`. |
| 3 | CI for the PR head | `release-please.yml` "Dispatch CI for the release PR head" -> `ci.yml` `workflow_dispatch` with `expected_sha` | Bot PRs trigger no workflows; the `pull_request` CI run shows `action_required`. The dispatched run is the real check. |
| 4 | Merge | human | Merge commit on main updates the manifest. |
| 5 | Tag `vX.Y.Z` pushed, `Release` dispatched | `release-please.yml` "Tag a merged release PR" reads the manifest version, pushes an annotated tag if absent; then `gh workflow run release.yml --ref $TAG -f tag=$TAG` unless already published | `GITHUB_TOKEN` tag pushes trigger nothing, hence the explicit dispatch. |
| 6 | Relabel merged PR `autorelease: tagged` | same workflow | Currently FAILS every time (section 3b). |
| 7 | `release` job | `release.yml`: tag-shape check, `apply-pnpm-tarball-policy --check`, `pnpm install --frozen-lockfile`, `pnpm check`, `scripts/sbom.ts` (license allowlist), draft release (changelogithub), runtime link in notes, upload `SBOM.cdx.json` | 20 min timeout. Draft has only the SBOM after this. |
| 8 | `macos-dmg` job starts the builder | `release.yml`, `environment: release` (only `v*` tags), `actions/create-github-app-token` with `vars.APP_ID` + `secrets.APP_PRIVATE_KEY` (app-repoman, `actions: write` on macos-builder), then `gh workflow run build.yml --repo stuffbucket/macos-builder --ref main -f repo=stuffbucket/winvm -f ref=$TAG` | Skips if the draft already has a dmg. No `APP_ID`: prints the command in the step summary instead. |
| 9 | Builder builds, signs, notarizes, uploads | `stuffbucket/macos-builder` `.github/workflows/build.yml` (90 min timeout; real runs ~4 min), `lib/package-macos.sh` | Gates: tag must descend from winvm's default branch; "Enforce per-repo policy" against `clients/stuffbucket/winvm.policy`. Runs `.macos-builder/build.sh` -> `apps/viewer/scripts/build-app.ts <version>` (writes version into `tauri.conf.json`, runs `sign-list.ts --check`). Uploads `winvm.dmg`, `winvm-vX.Y.Z-darwin-arm64.app.tar.gz`, `.sig`, `.sha256` to the draft (`--clobber`). |
| 10 | Finish assets | `scripts/release-assets.sh TAG 3000` in `macos-dmg` | Polls every 45 s up to 3000 s; renames `winvm.dmg` -> `winvm-vX.Y.Z-darwin-arm64.dmg` + `.sha256`; `scripts/updater-manifest.ts` verifies the `.sig` against `plugins.updater.pubkey` in `apps/viewer/src-tauri/tauri.conf.json` and the version, writes `latest.json`. |
| 11 | `publish` job | `release.yml`; `needs: [release, macos-dmg]` | `gh release edit --draft=false --latest` (or `--prerelease` for `vX.Y.Z-rc`). Draft -> Latest. |

Side workflows
- `finish-release.yml` (manual, input `tag`): requires a draft; runs `release-assets.sh TAG 0` (no waiting), then publishes. For when `macos-dmg` stopped waiting. Does not rebuild the SBOM.
- `site.yml`: Pages deploy of `site/`+`docs/` on main pushes; not part of release gating.
- `ci.yml`: `check` job on push to main, PRs, and dispatch. Not run by `release.yml` except through `pnpm check`.

## 2. Pre-flight for runtime pin bumps (v0.1.3 lesson)

The builder signs only the Mach-O files named in `sign_nested` (`.macos-builder/config`), and refuses the build unless that string is byte-identical to `sign_nested_allowed` in `clients/stuffbucket/winvm.policy` in macos-builder (`!=` comparison in build.yml "Enforce per-repo policy": order and every entry matter). A pin that adds/removes a binary or dylib (v11.1.2-2 added `virtiofsd`, `libjpeg.8.dylib`) therefore needs the policy changed BEFORE tagging.

1. Does the runtime's Mach-O set still match `.macos-builder/config`? Verified on v11.1.2-2 (prints `sign_nested matches the app (26 nested binaries)`):
   ```sh
   d=$(mktemp -d); gh release download vRT --repo stuffbucket/winvm-runtime --pattern '*darwin-arm64.tar.gz' --dir "$d"
   mkdir -p "$d/x" "$d/winvm.app/Contents/MacOS" "$d/winvm.app/Contents/Resources"
   tar -xzf "$d"/winvm-runtime-*-darwin-arm64.tar.gz -C "$d/x"
   cp -R "$d"/x/winvm-runtime-*-darwin-arm64 "$d/winvm.app/Contents/Resources/runtime"
   cp "$d/winvm.app/Contents/Resources/runtime/bin/zstd" "$d/winvm.app/Contents/MacOS/winvm"   # stand-in for the CLI Mach-O
   bun apps/viewer/scripts/sign-list.ts --check "$d/winvm.app"
   ```
   Mismatch: `bun apps/viewer/scripts/sign-list.ts --write <winvm.app>` rewrites `sign_nested` in `.macos-builder/config`; commit it. (The real build also runs `--check` in `build-app.ts`; `mise -C apps/viewer exec -- bun scripts/build-app.ts` reproduces it locally.)
2. Does config equal the builder policy? Verified identical as of v0.1.3:
   ```sh
   t=$(mktemp -d)   # repo root as cwd
   gh api repos/stuffbucket/macos-builder/contents/clients/stuffbucket/winvm.policy --jq .content > "$t/p.b64"
   base64 -d < "$t/p.b64" | sed -n 's/^sign_nested_allowed *= *//p' > "$t/policy.txt"
   sed -n 's/^sign_nested *= *//p' .macos-builder/config > "$t/config.txt"
   diff "$t/policy.txt" "$t/config.txt" && echo identical
   ```
3. If they differ, update the policy first, by one of (a human does the approving):
   - Issue `[build-config] stuffbucket/winvm` in stuffbucket/macos-builder (form: repo, bundle id `co.stuffbucket.winvm`, entitlement profiles `default, bun-runtime, qemu-hvf`, artifacts, volname `winvm`, app path, nested-signing map = the new `sign_nested` string, justification). Tick BOTH `dmg` and `updater` (as #34 did; #31 pre-dates `updater`, so re-filing with only `dmg` would likely drop it [unverified]). The bot comments "awaiting an authorized maintainer to apply the `approved` label"; once a maintainer adds `approved`, it applies the policy, labels `applied`, closes (#31: applied within a minute).
   - Or a reviewed PR in macos-builder editing `sign_nested_allowed` by hand (#33 added `updater`; #35 added the two v0.1.3 entries and closed #34, which had sat at `needs-triage` and was never labeled `approved`).
   - Merge/apply it, then re-run step 2 until `identical`. Only then merge the release PR.
4. New entitlement needs (new profile) are out of scope here; they need `entitlements_allowed` changed in the same issue.

## 3. Recovery

First look: `gh run list --repo stuffbucket/winvm --workflow release.yml --limit 3`, then `gh run view <id> --repo stuffbucket/winvm --json jobs` and `--log-failed`. For the builder: `gh run list --repo stuffbucket/macos-builder --workflow build.yml --limit 5`, `gh run view <id> --repo stuffbucket/macos-builder --log-failed | grep '##\[error\]'`.

### a. Builder refused the build (v0.1.3 incident)
Symptom: builder fails in ~25 s at "Enforce per-repo policy" with `sign_nested '...' is not permitted by policy for stuffbucket/winvm`; `macos-dmg` waits 50 min (16:15 -> 17:05 on 2026-11-03), fails at "Attach the signed .dmg...", `publish` skipped, draft keeps only `SBOM.cdx.json`. Cause: section 2 skipped.
1. Get the policy applied (section 2.3). Do not touch the tag.
2. Verify with section 2.2 (`identical`).
3. Restart the builder (any maintainer token; ~4 min):
   `gh workflow run build.yml --repo stuffbucket/macos-builder --ref main -f repo=stuffbucket/winvm -f ref=vX.Y.Z`
4. Wait for green, then `gh release view vX.Y.Z --repo stuffbucket/winvm --json assets,isDraft`: expect `winvm.dmg`, `winvm-vX.Y.Z-darwin-arm64.app.tar.gz`, `.sig`, `.sha256` plus the SBOM; still a draft.
5. Publish: `gh workflow run finish-release.yml --repo stuffbucket/winvm -f tag=vX.Y.Z`. **Requires the user's explicit publish instruction for that tag.**
6. The original failed `Release` run stays red forever; do not re-run it. (v0.1.3 timeline: builder rerun 22:51, `finish-release` success 23:07.)

### b. release-please run red at "Mark tagged release PRs autorelease:tagged"
Cause (established from run logs 40644633269 / 40655441451 / 41671952130 and `gh label list`): the label `autorelease: tagged` does not exist in stuffbucket/winvm (only `autorelease: pending`). `gh pr edit --remove-label pending --add-label tagged` removes `pending`, then fails with `'autorelease: tagged' not found`. Happened on every release-PR merge (0.1.1, 0.1.2, 0.1.3). Effect: tagging and the `release.yml` dispatch (earlier steps) already succeeded; the run is red, and the later steps (open next release PR, dispatch CI) are skipped until the next push to main. The merged PR ends with no labels. Not applied as of 2026-11-03: fix by creating the label (`gh label create "autorelease: tagged" --repo stuffbucket/winvm`, a repo write the user must approve) or making that step tolerate a missing label. Do not re-run the red run.

### c. Other failure modes (from the workflows)
| Symptom | Cause / action |
|---|---|
| `release` job red at `pnpm check`, `apply-pnpm-tarball-policy`, or SBOM "Disallowed licenses" | Fix on main via a PR, then cut the next patch (tag is already pushed; do not move it). Allowed licenses: `scripts/sbom.ts` `ALLOWED_LICENSES`. `[unverified]` whether re-running `release.yml` on the same tag after a main fix is wanted: it checks out the tag, so it would re-fail. |
| Release not dispatched / no draft | `gh workflow run release.yml --repo stuffbucket/winvm --ref vX.Y.Z -f tag=vX.Y.Z` (needs the tag to exist; ref must match `^vX.Y.Z(-pre)?$`). |
| `macos-dmg` printed a command instead of starting the build | `release` environment has no `APP_ID`; run the printed `gh workflow run build.yml ...` yourself, then `finish-release`. |
| Builder: `Tag vX is not contained in ... main` | Tag does not descend from winvm main. Never build from side-branch tags; cut a proper release. |
| Builder: `No build policy` / `not in ALLOWED_CLIENTS` / bundle id, entitlements, artifact, volname, app_path not permitted | Policy mismatch; same route as 3a. |
| Builder fails in the producer (`sign_nested ... does not match the app's Mach-O files`, from `sign-list.ts`) | `.macos-builder/config` stale vs the built app; `--write`, commit, and it needs a new tag (the tag's code is what the builder builds). |
| Notarization rejected | builder `lib/package-macos.sh` runs `notarytool submit --wait`, dumps `notarytool log`; read the builder run log. winvm holds no Apple credentials. Retry the builder run; if it recurs, fix in macos-builder. `[unverified]` no real instance in history. |
| Builder green but `macos-dmg` timed out (>50 min) | Run `finish-release` (it waits 0 s). |
| `release-assets.sh` "missing winvm.dmg, ...app.tar.gz or ...sig" | Builder did not upload (or failed). Start/fix the builder, then `finish-release`. |
| Builder re-run after the dmg was already renamed | `[unverified]` the script skips the rename, so a stray `winvm.dmg` would remain on the draft; delete it (`gh release delete-asset vX winvm.dmg`) before publishing. |
| Updater signature check fails in `updater-manifest.ts` | Wrong key or version in the `.sig` trusted comment (key id `E4167998E5A196BB`, `winvm` key in macos-builder's `signing` environment). Do not publish. |
| A published asset is wrong | Cut a new patch release. |

## 4. Verify after publishing

```sh
gh release list --repo stuffbucket/winvm --limit 3            # new tag marked Latest
gh api repos/stuffbucket/winvm/releases/latest --jq .tag_name
curl -sL https://github.com/stuffbucket/winvm/releases/latest/download/latest.json \
  | jq '{version, url: .platforms["darwin-aarch64"].url, sig_len: (.platforms["darwin-aarch64"].signature|length)}'
gh release view vX.Y.Z --repo stuffbucket/winvm --json assets --jq '[.assets[].name]|sort'
```
Expect `latest.json` version `X.Y.Z`, a `darwin-aarch64` signature, and exactly these 7 assets (same as v0.1.2, v0.1.3): `SBOM.cdx.json`, `latest.json`, `winvm-vX.Y.Z-darwin-arm64.dmg`, `.dmg.sha256`, `winvm-vX.Y.Z-darwin-arm64.app.tar.gz`, `.app.tar.gz.sha256`, `.app.tar.gz.sig`. No stray `winvm.dmg`.

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
| Not bumped | `apps/*/package.json`, `packages/*/package.json` (0.1.0) and `apps/viewer/src-tauri/tauri.conf.json` (0.1.0). The app version is injected at build: `.macos-builder/build.sh` -> `build-app.ts ${TAG#v}` rewrites `tauri.conf.json` on the builder and asserts `CFBundleShortVersionString`. v0.1.3 app Info.plist verified `0.1.3`. |
| Notes | The 0.1.3 PR body lists only Features, Bug Fixes, Performance Improvements; `docs`, `test`, `ci`, `chore` commits were in the range but not listed (verified on PR #25). They still do not trigger a release by themselves [unverified]. |

Preview the next release:
```sh
gh pr list --repo stuffbucket/winvm --label "autorelease: pending" --json number,title,url
gh pr view <n> --repo stuffbucket/winvm --json body,files --jq '.body, [.files[].path]'
git log --format=%s "$(git describe --tags --abbrev=0 origin/main)"..origin/main   # raw commits
```
No open PR right now means no releasable commit since v0.1.3 (or the next push to main will create it).
