#!/bin/sh
set -eu

top=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0
[ "$top" = "$(pwd -P)" ] || exit 0

git config core.hooksPath .githooks
git config blame.ignoreRevsFile .git-blame-ignore-revs
