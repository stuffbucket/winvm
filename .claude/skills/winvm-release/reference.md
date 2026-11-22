# winvm release: reference

Companion to [SKILL.md](SKILL.md). Checked 2026-11-03.

## Where docs/release-runbook.md is stale or wrong

| Runbook says | Reality |
|---|---|
| One-time setup: policy has `artifact_allowed=dmg`, entitlements, bundle id | `clients/stuffbucket/winvm.policy` in macos-builder also pins `artifact_allowed = dmg,updater`, `volname_allowed`, `app_path_allowed`, `updater_key_id = winvm` and a 26-entry `sign_nested_allowed` that must equal `.macos-builder/config` `sign_nested` exactly. |
| "Changing the runtime": after a pin change run `sign-list.ts --write` and commit | Missing the other half: the builder's policy must be updated first (macos-builder issue/PR) or the build is refused (v0.1.3). See SKILL.md section 2. |
| Release checklist: wait for the PR's "required `check`" | `gh api repos/stuffbucket/winvm/rulesets` shows `Protect main` (deletion, non_fast_forward) and `Require PR` (pull_request, 0 approvals); no `required_status_checks` rule is visible, and classic branch protection returns 404. The check is run (dispatched) but not shown to be enforced. Whether other settings enforce it is `[unverified]`. |
| `macos-dmg` "prints the command that starts the signed build" | Only when `vars.APP_ID` is empty. Normally it mints an app-repoman token and starts the build itself (release.yml "Start the signed build"). |
| "Published releases, tags and assets are immutable" | `gh api repos/stuffbucket/winvm/releases` reports `immutable: false` for v0.1.0-v0.1.3. It is a rule, not an enforced setting. |
| Recovery: "Re-run failed jobs on the original run" for a gating failure | Works for the `macos-dmg` job only if the builder succeeds on re-run; after a builder policy failure prefer: fix policy, restart builder, `finish-release` (no 50 min wait). A red `release` job on a pushed tag cannot be fixed by re-running if the cause is in the tag's code. |
| Silent on release-please | Release Please run is red after every release-PR merge (missing `autorelease: tagged` label, SKILL.md 3b). Not mentioned. |
| Silent on version injection | `tauri.conf.json` stays 0.1.0 in git; the builder injects the tag's version. |
| Silent on provenance gate | Builder refuses a tag not contained in winvm's default branch. |
| Silent on `finish-release` limits | It never regenerates the SBOM or notes; it needs the draft to exist with builder files uploaded. |

## v0.1.3 incident timeline (UTC, 2026-11-03)

| Time | Event | Evidence |
|---|---|---|
| 16:13 | Release PR #25 merged; tag v0.1.3 pushed; `Release` dispatched | PR #25 events; run 41672018952 (`workflow_dispatch`) |
| 16:13 | Release Please run 41671952130 red at "Mark tagged release PRs" (`'autorelease: tagged' not found`) | run log |
| 16:15 | macos-dmg starts builder (run 41672255204 on macos-builder); fails ~25 s later at "Enforce per-repo policy": `sign_nested '...' is not permitted by policy` (policy had 24 entries, config 26 after `virtiofsd` + `libjpeg.8.dylib` from winvm-runtime 11.1.2-2) | builder run log; winvm PR "feat: pin winvm-runtime 11.1.2-2" (commit 140f07b) |
| 17:01 | Build-config issue #34 opened; labeled `needs-triage`, never `approved` | macos-builder #34 |
| 17:05 | macos-dmg times out after 50 min; `publish` skipped; run stays failure | run 41672018952 |
| 22:48 | macos-builder PR #35 merged (policy edited by hand, closes #34) | PR #35 |
| 22:51-22:55 | Builder rerun green (run 41734374384): sign, notarize, upload | builder run |
| 23:07 | `finish-release` run 41736597750 green; v0.1.3 published, Latest | winvm runs, `gh release view` |

Earlier pattern: v0.1.0 and v0.1.1 shipped only dmg + sha256 + SBOM (pre-updater); from v0.1.2 the 7-asset set applies. Release Please run 40642984921 (first PR attempt) failed at "Open or update the release PR": "GitHub Actions is not permitted to create or approve pull requests" (a repo Actions setting; later runs succeed, so it was changed, exact setting `[unverified]`).

## Other facts worth knowing

- Tag creation: release-please.yml runs on every push to main, reads `.release-please-manifest.json`, and tags the pushed commit if `vX.Y.Z` is missing. Concurrency group `release-please-<ref>`, no cancel.
- Builder concurrency: `macos-build-<repo>-<ref>`. Builder reads the policy from macos-builder `main` at build time, so a merged policy PR takes effect immediately.
- Updater: `requireSignedVersion: true`; the `.sig` trusted comment carries `version:X.Y.Z`; key id `E4167998E5A196BB`; endpoint `https://github.com/stuffbucket/winvm/releases/latest/download/latest.json`; the manifest has only `darwin-aarch64`. Losing the private key (macos-builder `signing` environment, `TAURI_SIGNING_PRIVATE_KEY__WINVM`) strands installed apps.
- Pre-release tags (`vX.Y.Z-rc.1`): `release.yml` and `finish-release.yml` publish with `--prerelease` (no `--latest`), so `latest.json` is not moved. `[unverified]` never exercised.
- Release asset names are produced in three places that must agree: `.macos-builder/config` (`updater_name = winvm-{tag}-darwin-arm64.app.tar.gz`), `scripts/release-assets.sh`, `macos-dmg`'s "already built" regex in `release.yml`.
- Policy gate fields (macos-builder build.yml "Enforce per-repo policy"): bundle id, entitlements (including each `sign_nested` profile), artifact list, volname, app_path, exact `sign_nested`. Unknown policy keys are rejected.
