# winvm release: reference

Companion to [SKILL.md](SKILL.md). Old-pipeline facts checked 2026-11-03 against runs of v0.1.0-v0.1.3; the new pipeline is `[unverified]` until its first real run.

## What the restructure changed, and why

| Old (v0.1.0-v0.1.3) | New |
|---|---|
| `release-please.yml` on every push to main: hand-written tag step (reads the manifest, pushes an annotated tag), a label step that failed on every release (`autorelease: tagged` did not exist; `gh pr edit` validates labels), `gh workflow run release.yml`, `gh workflow run ci.yml`; release PR via `bunx release-please@17.11.2 release-pr` | One `release.yml`: `googleapis/release-please-action@v5.0.0` (SHA-pinned) creates the tag (`force-tag-creation`) and the draft (`draft: true`) and manages labels itself. Only `ci.yml` is still dispatched, for the release PR. |
| `release.yml` on a `v*` tag (dispatched): `release` job (check, SBOM, draft via changelogithub), then `macos-dmg` (start builder, poll the release for assets up to 50 min), then `publish` | Same run: `check` and `build` in parallel, then `publish`. `build` waits on the builder run itself (id from the dispatch response), not on assets. |
| `finish-release.yml` (manual) for a builder run that finished after `macos-dmg` stopped waiting | Deleted. Recovery is Re-run failed jobs on the same run. |
| `release-assets.sh TAG WAIT`: poll, rename `winvm.dmg`, `latest.json` | `release-assets.sh TAG SBOM`: no polling; `latest.json` + SBOM; asserts the exact 7-asset set. The rename is gone because `.macos-builder/config` sets `dmg_name`. |
| No check that `sign_nested` matches the runtime or the builder's policy before the tag | `scripts/preflight-signing.ts`, run by `ci.yml` as `signing preflight`. |
| `release` environment admitted only `v*` tags | Must admit `main` (the run starts on a push to main). Setting changed by hand. |
| Runbook claimed: PR `check` required, assets immutable by setting, `macos-dmg` only prints a command | Rewritten. Facts: rulesets `Protect main` (deletion, non_fast_forward) and `Require PR` (pull_request, 0 approvals) have no `required_status_checks`; `immutable: false` on all releases; `can_approve_pull_request_reviews: true` (Actions may create PRs). |

## Failure at v0.1.3, and what the new run does with it (UTC, 2026-11-03)

| Time | Event | Evidence |
|---|---|---|
| 16:13 | Release PR #25 merged; tag v0.1.3 pushed; `Release` dispatched | PR #25 events; run 41672018952 (`workflow_dispatch`) |
| 16:13 | Release Please run 41671952130 red at "Mark tagged release PRs" (`'autorelease: tagged' not found`) | run log |
| 16:15 | macos-dmg starts builder (run 41672255204); fails ~25 s later at "Enforce per-repo policy": `sign_nested '...' is not permitted by policy` (policy had 24 entries, config 26 after `virtiofsd` + `libjpeg.8.dylib` from winvm-runtime 11.1.2-2) | builder run log; winvm commit 140f07b |
| 17:01 | Build-config issue #34 opened; labeled `needs-triage`, never `approved` | macos-builder #34 |
| 17:05 | macos-dmg times out after 50 min; `publish` skipped | run 41672018952 |
| 22:48 | macos-builder PR #35 merged (policy edited by hand) | PR #35 |
| 22:51-22:55 | Builder rerun green (run 41734374384) | builder run |
| 23:07 | `finish-release` run 41736597750 green; v0.1.3 published | winvm runs |

New pipeline: `signing preflight` fails the pin PR when it can read the policy; otherwise `build` fails ~30 s after the merge with the builder's error in the job summary (`scripts/release-builder.test.ts` replays this log shape); after the policy PR merges, one Re-run failed jobs finishes the release on the same run.

Earlier pattern: v0.1.0 and v0.1.1 shipped only dmg + sha256 + SBOM (pre-updater); from v0.1.2 the 7-asset set applies. Release Please run 40642984921 (first PR attempt) failed at "GitHub Actions is not permitted to create or approve pull requests" (a repo setting, now on).

## Other facts worth knowing

- Builder: `workflow_dispatch` only (inputs `repo`, `ref`; `ref` must match `^v?[0-9][0-9A-Za-z.+~_-]{0,99}$`), runs on one self-hosted runner `macos-builder` registered to the builder repo (so no reusable-workflow call from winvm), run name "macOS build (dispatched)" (a proposal to name runs is in `proposals/`), concurrency `macos-build-<repo>-<ref>` with no cancel, 90 min timeout. It reads the policy from macos-builder `main` at build time, so a merged policy PR takes effect immediately.
- The dispatch endpoint returns 200 with `workflow_run_id`, `run_url`, `html_url` when the request has `return_run_details: true` (GitHub changelog 2026-02-19; `gh workflow run` prints the URL since v2.87). Without it: 204 and no id. `release-builder.sh` fails rather than guess a run if there is no id.
- `gh run watch` is not used: it reads check-runs, which the app token (Actions only) may not. `release-builder.sh` polls `GET /actions/runs/{id}` and, on failure, `GET /actions/runs/{id}/jobs` and `GET /actions/jobs/{id}/logs`; all Actions-read.
- Draft releases do not create their git tag until published, so the config sets `force-tag-creation` (release-please makes the ref via the git API) because the builder needs the tag to exist and to descend from main.
- Builder knobs for naming: `dmg_name` and `updater_name` accept `{tag}`/`{version}`; names must match `[A-Za-z0-9._-]` and end in `.dmg` / the updater's suffix. The `.sha256` beside each takes the artifact's name. Release asset names are decided in `.macos-builder/config` and asserted in `scripts/release-assets.sh`; they must agree.
- Updater: `requireSignedVersion: true`; the `.sig` trusted comment carries `version:X.Y.Z`; key id `E4167998E5A196BB`; endpoint `https://github.com/stuffbucket/winvm/releases/latest/download/latest.json`; the manifest has only `darwin-aarch64`. Losing the private key (macos-builder `signing` environment, `TAURI_SIGNING_PRIVATE_KEY__WINVM`) strands installed apps.
- Pre-release tags (`vX.Y.Z-rc.1`): `publish` uses `--prerelease` (no `--latest`), so `latest.json` is not moved, and the post-publish check reads `latest.json` from the tag's own download URL. `[unverified]` never exercised for a real release; rehearsal tags exercise everything but publish.
- Policy gate fields (macos-builder build.yml "Enforce per-repo policy"): bundle id (exact), entitlements membership (including each `sign_nested` profile), every artifact in `artifact_allowed`, volname and app_path if pinned, `sign_nested` exact string. Unknown policy keys are rejected. `scripts/preflight-signing.ts` mirrors this.
- Security: with the key in an environment that admits `main`, any code merged to main can mint an app-repoman token. main requires a PR. The token still only runs workflows on macos-builder.
- Release PR branch name: `release-please--branches--main` or `...--components--winvm-workspace` (old runs used the latter); `release-pr-ci` takes it from the action's `pr` output instead of assuming.
