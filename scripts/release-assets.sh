#!/usr/bin/env bash
# usage: scripts/release-assets.sh TAG [WAIT_SECONDS]
#
# Attaches the signed DMG and the app's update to TAG's draft release.
#
# stuffbucket/macos-builder builds, signs and notarizes the app and uploads
# winvm.dmg and the update bundle (winvm-<tag>-darwin-arm64.app.tar.gz, with
# its .sig and .sha256) to the draft. Nothing here starts that build: winvm
# stores no token for macos-builder, so a person with access to it starts each
# signed build, which also makes every signing a deliberate step. This waits up
# to WAIT_SECONDS (default 0) for those files, then:
#   - replaces winvm.dmg with winvm-<tag>-darwin-arm64.dmg and its .sha256;
#   - checks the bundle's signature the way the app will, and attaches
#     latest.json, the manifest the app's updater reads.
#
# Needs GH_TOKEN with contents: write, GITHUB_REPOSITORY, and bun.
set -euo pipefail
tag=${1:?usage: release-assets.sh TAG [WAIT_SECONDS]}
wait=${2:-0}
repo=${GITHUB_REPOSITORY:?}
src=winvm.dmg
dmg="winvm-${tag}-darwin-arm64.dmg"
bundle="winvm-${tag}-darwin-arm64.app.tar.gz"
trigger="gh workflow run build.yml --repo stuffbucket/macos-builder --ref main -f repo=${repo} -f ref=${tag}"
here=$(cd "$(dirname "$0")" && pwd)

assets() {
  gh release view "$tag" --repo "$repo" --json assets --jq '.assets[].name' 2> /dev/null
}

ready() {
  local have
  have=$(assets)
  { grep -Fxq "$src" <<< "$have" || grep -Fxq "$dmg" <<< "$have"; } &&
    grep -Fxq "$bundle" <<< "$have" &&
    grep -Fxq "$bundle.sig" <<< "$have"
}

deadline=$((SECONDS + wait))
until ready; do
  if [ "$SECONDS" -ge "$deadline" ]; then
    echo "::error::The ${tag} draft is missing ${src}, ${bundle} or ${bundle}.sig. Start the signed build with: ${trigger}"
    echo "::error::Then run the finish-release workflow for ${tag}; the release stays a draft until then."
    exit 1
  fi
  sleep 45
done

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

if ! assets | grep -Fxq "$dmg"; then
  gh release download "$tag" --repo "$repo" --pattern "$src" --dir "$tmp"
  mv "$tmp/$src" "$tmp/$dmg"
  (cd "$tmp" && shasum -a 256 "$dmg" > "$dmg.sha256")
  gh release upload "$tag" --repo "$repo" "$tmp/$dmg" "$tmp/$dmg.sha256" --clobber
  gh release delete-asset "$tag" "$src" --repo "$repo" --yes 2> /dev/null || true
  gh release delete-asset "$tag" "$src.sha256" --repo "$repo" --yes 2> /dev/null || true
  echo "attached $dmg and $dmg.sha256 to the $tag draft"
fi

gh release download "$tag" --repo "$repo" --pattern "$bundle" --pattern "$bundle.sig" --dir "$tmp"
bun "$here/updater-manifest.ts" --tag "$tag" --file "$tmp/$bundle" \
  --url "https://github.com/${repo}/releases/download/${tag}/${bundle}" \
  --notes "https://github.com/${repo}/releases/tag/${tag}" \
  --out "$tmp/latest.json"
gh release upload "$tag" --repo "$repo" "$tmp/latest.json" --clobber
echo "attached latest.json to the $tag draft"
