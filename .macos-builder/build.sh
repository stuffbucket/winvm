#!/usr/bin/env bash
set -euo pipefail

# winvm's producer for stuffbucket/macos-builder. It builds the unsigned
# winvm.app at the config's app_path: the Tauri shell, the compiled winvm CLI
# (Contents/MacOS/winvm), winvm's data files and the pinned runtime
# (Contents/Resources/winvm, Contents/Resources/runtime). The builder signs every
# file in the config's sign_nested, then the app, then packages, notarizes,
# staples and checksums.
#
# The producer runs with the signing keychain locked and SIGN_IDENTITY="-".
# Bun, pnpm and Rust come from the repository's mise pins, not the runner.
#
# Builder-supplied env consumed: TAG, ARCH.

export PATH="$HOME/.local/bin:$PATH"

VERSION="${TAG#v}"
MISE_VERSION="v2026.9.14"
MISE="$HOME/.local/bin/mise"

echo "Producing winvm.app for ${TAG} (version ${VERSION}, ${ARCH:-arm64})"

mkdir -p "$HOME/.local/bin"
if [ ! -x "$MISE" ] || [ "$("$MISE" --version | cut -d' ' -f1)" != "${MISE_VERSION#v}" ]; then
  curl -fsSL https://mise.run | MISE_VERSION="$MISE_VERSION" MISE_INSTALL_PATH="$MISE" sh
fi
"$MISE" trust -q mise.toml
"$MISE" trust -q apps/viewer/mise.toml
"$MISE" install
"$MISE" -C apps/viewer install
"$MISE" exec -- pnpm install --frozen-lockfile

# Persistent runners can keep a stale bundle; build-app.ts deletes it, builds,
# stages the runtime, checks sign_nested against the bundle and asserts the
# version.
"$MISE" exec -C apps/viewer -- bun scripts/build-app.ts "$VERSION"
