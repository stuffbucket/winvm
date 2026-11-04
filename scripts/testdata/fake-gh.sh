#!/usr/bin/env bash
# A fake `gh` for the release script tests. State lives in $FAKE_GH_DIR:
#   api/<path with / as _>.<N>.json  response to the Nth `gh api <path>` (the last is repeated);
#                                    --jq runs through the real jq
#   api/<path with / as _>.txt       raw response (job logs)
#   dispatch.json                    response to the dispatch POST (absent: an empty 204)
#   release/<name>                   the draft release's assets, one file each
#   release.isDraft                  "true" or "false"
#   edits.log                        `gh release edit` calls
#   calls.log                        every call
set -euo pipefail
d=${FAKE_GH_DIR:?}
echo "gh $*" >> "$d/calls.log"
case "$1 $2" in
  "api "*)
    shift
    method=GET
    jq_expr=
    path=
    while [ $# -gt 0 ]; do
      case "$1" in
        --method) method=$2; shift 2 ;;
        --jq) jq_expr=$2; shift 2 ;;
        -f | -F) shift 2 ;;
        *) [ -n "$path" ] || path=$1; shift ;;
      esac
    done
    if [ "$method" = POST ]; then
      if [ -f "$d/dispatch.json" ]; then cat "$d/dispatch.json"; fi
      exit 0
    fi
    k=${path//\//_}
    if [ -f "$d/api/$k.txt" ]; then cat "$d/api/$k.txt"; exit 0; fi
    n=$(($(cat "$d/api/$k.n" 2> /dev/null || echo 0) + 1))
    echo "$n" > "$d/api/$k.n"
    f="$d/api/$k.$n.json"
    if [ ! -f "$f" ]; then f=$(find "$d/api" -name "$k.*.json" | sort -V | tail -1); fi
    if [ -z "$f" ] || [ ! -f "$f" ]; then echo "fake gh: no fixture for $path" >&2; exit 1; fi
    if [ -n "$jq_expr" ]; then jq -r "$jq_expr" "$f"; else cat "$f"; fi
    ;;
  "release view")
    if [[ "$*" == *isDraft* ]]; then cat "$d/release.isDraft"; else ls "$d/release"; fi
    ;;
  "release download")
    pats=()
    dir=.
    shift 3
    while [ $# -gt 0 ]; do
      case "$1" in
        --pattern) pats+=("$2"); shift 2 ;;
        --dir) dir=$2; shift 2 ;;
        *) shift ;;
      esac
    done
    for p in "${pats[@]}"; do cp "$d/release/$p" "$dir/$p"; done
    ;;
  "release upload")
    shift 3
    while [ $# -gt 0 ]; do
      case "$1" in
        --repo) shift 2 ;;
        --clobber) shift ;;
        *) cp "$1" "$d/release/$(basename "$1")"; shift ;;
      esac
    done
    ;;
  "release delete-asset")
    rm "$d/release/$4"
    ;;
  "release edit" | "release create")
    echo "$*" >> "$d/edits.log"
    ;;
  *)
    echo "fake gh: unhandled: $*" >&2
    exit 1
    ;;
esac
