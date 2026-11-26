#!/usr/bin/env bash
# usage: scripts/release-assets.sh TAG SBOM_FILE
#
# Completes TAG's draft release once stuffbucket/macos-builder has finished its
# signed build, and checks the result is exactly the set that gets published.
#
# The builder (scripts/release-builder.sh waits for it) has uploaded the .dmg,
# the app's update bundle and their .sha256 and .sig files, under their release
# names (.macos-builder/config: dmg_name, updater_name). This adds:
#   - SBOM.cdx.json, the SBOM made by the check job;
#   - latest.json, the manifest the app's updater reads, written only after
#     scripts/updater-manifest.ts has checked the bundle's signature the way the
#     app will;
#   - the signed keeper from inside the notarized app as
#     winvm-keeper-<tag>-darwin-arm64 with its .sha256, the binary
#     packages/core/keeper.json pins for CLI-only installs;
# and then fails unless the draft holds exactly the expected assets.
#
# Safe to run again: uploads replace same-named assets, nothing is polled for
# and nothing is published here.
#
# Needs GH_TOKEN with contents: write, GITHUB_REPOSITORY, and bun.
set -euo pipefail
tag=${1:?usage: release-assets.sh TAG SBOM_FILE}
sbom=${2:?usage: release-assets.sh TAG SBOM_FILE}
repo=${GITHUB_REPOSITORY:?}
dmg="winvm-${tag}-darwin-arm64.dmg"
bundle="winvm-${tag}-darwin-arm64.app.tar.gz"
keeper="winvm-keeper-${tag}-darwin-arm64"
here=$(cd "$(dirname "$0")" && pwd)

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

gh release download "$tag" --repo "$repo" --pattern "$bundle" --pattern "$bundle.sig" --dir "$tmp"
bun "$here/updater-manifest.ts" --tag "$tag" --file "$tmp/$bundle" \
  --url "https://github.com/${repo}/releases/download/${tag}/${bundle}" \
  --notes "https://github.com/${repo}/releases/tag/${tag}" \
  --out "$tmp/latest.json"

mkdir "$tmp/app"
tar -xzf "$tmp/$bundle" -C "$tmp/app"
signed=$(find "$tmp/app" -path '*.app/Contents/MacOS/winvm-keeper' -type f | head -n 1)
if [ -z "$signed" ]; then
  echo "::error::${bundle} has no Contents/MacOS/winvm-keeper"
  exit 1
fi
cp "$signed" "$tmp/$keeper"
(cd "$tmp" && shasum -a 256 "$keeper" >"$keeper.sha256")

cp "$sbom" "$tmp/SBOM.cdx.json"
gh release upload "$tag" --repo "$repo" "$tmp/latest.json" "$tmp/SBOM.cdx.json" \
  "$tmp/$keeper" "$tmp/$keeper.sha256" --clobber

want=$(printf '%s\n' "$bundle" "$bundle.sha256" "$bundle.sig" "$dmg" "$dmg.sha256" \
  "$keeper" "$keeper.sha256" SBOM.cdx.json latest.json | sort)
have=$(gh release view "$tag" --repo "$repo" --json assets --jq '.assets[].name' | sort)
if [ "$want" != "$have" ]; then
  echo "::error::The ${tag} draft does not hold exactly the expected assets. Expected (<) vs found (>):"
  diff <(echo "$want") <(echo "$have") | sed 's/^/::error::/' || true
  exit 1
fi
echo "The ${tag} draft holds the expected $(wc -l <<<"$want" | tr -d ' ') assets:"
echo "$have"
