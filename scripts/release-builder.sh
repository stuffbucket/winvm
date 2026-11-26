#!/usr/bin/env bash
# usage: scripts/release-builder.sh TAG
#
# Starts the signed build of TAG on stuffbucket/macos-builder and waits for
# THAT run to finish, so a refusal fails the release in seconds with the
# builder's own error instead of after a long wait for assets that never come.
#
# The builder builds, signs, notarizes and uploads winvm-<tag>-darwin-arm64.dmg,
# winvm-<tag>-darwin-arm64.app.tar.gz and their .sha256/.sig files to TAG's
# draft release in this repository. Its self-hosted runner is registered to the
# builder repository, so it cannot run as a reusable workflow from here; this
# dispatches it.
#
# The run is identified by the dispatch call itself: with return_run_details the
# API answers 200 with workflow_run_id instead of 204, so two releases (or a
# rerun and a release) running at once cannot be confused. The wait is plain
# REST polling, which needs only the Actions permission of the token that
# `gh run watch` could not use (it reads check-runs).
#
# Env: GH_TOKEN (a token that can run workflows and read runs on the builder
# repository), GITHUB_REPOSITORY. Optional: BUILD_TIMEOUT (seconds, default
# 1800), POLL_SECONDS (default 10).
set -euo pipefail

tag=${1:?usage: release-builder.sh TAG}
repo=${GITHUB_REPOSITORY:?}
builder=stuffbucket/macos-builder
workflow=build.yml
ref=main
timeout=${BUILD_TIMEOUT:-1800}
poll=${POLL_SECONDS:-10}
summary=${GITHUB_STEP_SUMMARY:-/dev/null}

resp=$(gh api --method POST "repos/${builder}/actions/workflows/${workflow}/dispatches" \
  -f "ref=${ref}" -f "inputs[repo]=${repo}" -f "inputs[ref]=${tag}" -F return_run_details=true)
run_id=$(jq -r '.workflow_run_id // empty' <<<"${resp:-null}" 2>/dev/null || true)
url=$(jq -r '.html_url // empty' <<<"${resp:-null}" 2>/dev/null || true)
if [[ ! "$run_id" =~ ^[0-9]+$ ]]; then
  echo "::error::The dispatch of ${builder} ${workflow} for ${tag} returned no run id (response: '${resp}'). Not guessing which run is ours."
  exit 1
fi
echo "Signed build of ${tag}: ${url:-https://github.com/${builder}/actions/runs/${run_id}}"
echo "Signed build of ${tag}: ${url:-run ${run_id}}" >>"$summary"

# Prints the builder's own error lines for the failed jobs of the run.
surface_failure() {
  local jobs job_id
  jobs=$(gh api "repos/${builder}/actions/runs/${run_id}/jobs" --jq '.jobs[] | select(.conclusion != "success" and .conclusion != "skipped") | .id' 2>/dev/null || true)
  {
    echo
    echo "### The builder refused or failed the build of ${tag}"
    echo
    echo '```'
  } >>"$summary"
  for job_id in $jobs; do
    gh api "repos/${builder}/actions/jobs/${job_id}/logs" 2>/dev/null | grep -F '##[error]' | sed 's/^.*##\[error\]//' | head -20 | tee -a "$summary" |
      sed 's/^/::error::/' || true
  done
  echo '```' >>"$summary"
}

deadline=$((SECONDS + timeout))
last=
while :; do
  if state=$(gh api "repos/${builder}/actions/runs/${run_id}" --jq '"\(.status) \(.conclusion // "none")"' 2>/dev/null); then
    [ "$state" = "$last" ] || echo "builder run ${run_id}: ${state}"
    last=$state
    case "$state" in
    "completed success") exit 0 ;;
    completed\ *)
      echo "::error::The signed build of ${tag} ended ${state#completed }: ${url:-${builder} run ${run_id}}"
      surface_failure
      exit 1
      ;;
    esac
  else
    echo "::warning::could not read builder run ${run_id}; retrying"
  fi
  if [ "$SECONDS" -ge "$deadline" ]; then
    echo "::error::The signed build of ${tag} was still running after ${timeout}s (${url:-run ${run_id}}). It is not cancelled; re-run this job once it has finished or failed."
    exit 1
  fi
  sleep "$poll"
done
