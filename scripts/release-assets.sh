#!/usr/bin/env bash
# usage: scripts/release-dmg.sh TAG [WAIT_SECONDS]
#
# Attaches the signed DMG to TAG's draft release under its release name.
#
# stuffbucket/macos-builder builds, signs and notarizes the app and uploads
# winvm.dmg to the draft. Nothing here starts that build: winvm stores no
# token for macos-builder, so a person with access to it starts each signed
# build, which also makes every signing a deliberate step. This waits up to
# WAIT_SECONDS (default 0) for winvm.dmg, then replaces it with
# winvm-<tag>-darwin-arm64.dmg and its .sha256.
#
# Needs GH_TOKEN with contents: write, and GITHUB_REPOSITORY.
set -euo pipefail
tag=${1:?usage: release-dmg.sh TAG [WAIT_SECONDS]}
wait=${2:-0}
repo=${GITHUB_REPOSITORY:?}
src=winvm.dmg
dst="winvm-${tag}-darwin-arm64.dmg"
trigger="gh workflow run build.yml --repo stuffbucket/macos-builder --ref main -f repo=${repo} -f ref=${tag}"

has() {
  gh release view "$tag" --repo "$repo" --json assets --jq '.assets[].name' 2> /dev/null | grep -Fxq "$1"
}

if has "$dst"; then
  echo "$dst is already on the $tag draft"
  exit 0
fi

deadline=$((SECONDS + wait))
until has "$src"; do
  if [ "$SECONDS" -ge "$deadline" ]; then
    echo "::error::No ${src} on the ${tag} draft. Start the signed build with: ${trigger}"
    echo "::error::Then run the finish-release workflow for ${tag}; the release stays a draft until then."
    exit 1
  fi
  sleep 45
done

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
gh release download "$tag" --repo "$repo" --pattern "$src" --dir "$tmp"
mv "$tmp/$src" "$tmp/$dst"
(cd "$tmp" && shasum -a 256 "$dst" > "$dst.sha256")
gh release upload "$tag" --repo "$repo" "$tmp/$dst" "$tmp/$dst.sha256" --clobber
gh release delete-asset "$tag" "$src" --repo "$repo" --yes 2> /dev/null || true
gh release delete-asset "$tag" "$src.sha256" --repo "$repo" --yes 2> /dev/null || true
echo "attached $dst and $dst.sha256 to the $tag draft"
