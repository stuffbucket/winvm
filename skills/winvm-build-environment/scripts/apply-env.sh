#!/bin/sh
# apply-env.sh: apply an environment spec to a winvm Windows machine, then
# checkpoint it. POSIX sh (macOS, Linux). Same flags, exit codes and --json
# output as apply-env.ps1; a thin wrapper over `winvm run` and `winvm save`.
#
#   apply-env.sh -i NAME [--save CHECKPOINT] [--note TEXT] [--json] SPEC.yml
#
# Exit codes: 0 applied (and checkpointed, with --save); 1 a step failed, no
# checkpoint taken; 2 usage; 3 applied, but the checkpoint failed; 127 no winvm.
# --json: stdout is one JSON object; winvm's own output goes to stderr.
# WINVM names the winvm command (default: winvm on PATH, ~/.local/bin/winvm, the app's).
# WINVM_TEMPLATES defaults to the winvm-inside-windows skill's templates folder.

usage() {
  echo "usage: apply-env.sh -i NAME [--save CHECKPOINT] [--note TEXT] [--json] SPEC.yml" >&2
  exit 2
}

instance=""; save=""; note=""; json=0; spec=""
while [ $# -gt 0 ]; do
  case "$1" in
    -i) [ $# -ge 2 ] || usage; instance=$2; shift 2 ;;
    --save) [ $# -ge 2 ] || usage; save=$2; shift 2 ;;
    --note) [ $# -ge 2 ] || usage; note=$2; shift 2 ;;
    --json) json=1; shift ;;
    -*) usage ;;
    *) [ -z "$spec" ] || usage; spec=$1; shift ;;
  esac
done
[ -n "$instance" ] && [ -n "$spec" ] || usage

jstr() { printf '"%s"' "$(printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g')"; }
finish() { # ok stage exit-code
  if [ "$json" = 1 ]; then
    if [ -n "$save" ] && [ "$2" = done ]; then cp=$(jstr "$save"); else cp=null; fi
    printf '{"ok":%s,"instance":%s,"spec":%s,"checkpoint":%s,"stage":"%s","exit":%s}\n' \
      "$1" "$(jstr "$instance")" "$(jstr "$spec")" "$cp" "$2" "$3"
  fi
}

if [ -z "${WINVM:-}" ]; then
  if command -v winvm >/dev/null 2>&1; then WINVM=winvm
  elif [ -x "$HOME/.local/bin/winvm" ]; then WINVM=$HOME/.local/bin/winvm
  elif [ -x /Applications/winvm.app/Contents/MacOS/winvm ]; then WINVM=/Applications/winvm.app/Contents/MacOS/winvm
  else echo "apply-env: winvm not found (set WINVM)" >&2; finish false winvm 127; exit 127
  fi
fi
if [ -z "${WINVM_TEMPLATES:-}" ]; then
  here=$(CDPATH='' cd -P -- "$(dirname -- "$0")" && pwd)
  WINVM_TEMPLATES=$(CDPATH='' cd -P -- "$here/../../winvm-inside-windows/templates" 2>/dev/null && pwd)
fi
export WINVM_TEMPLATES

if [ "$json" = 1 ]; then
  $WINVM run "$spec" -i "$instance" --keep 1>&2
else
  $WINVM run "$spec" -i "$instance" --keep
fi
rc=$?
if [ "$rc" -ne 0 ]; then
  echo "apply-env: the spec failed (winvm run exited $rc); no checkpoint taken" >&2
  finish false apply "$rc"; exit 1
fi

if [ -n "$save" ]; then
  if [ -n "$note" ]; then set -- --note "$note"; else set --; fi
  if [ "$json" = 1 ]; then
    $WINVM save -i "$instance" "$save" "$@" 1>&2
  else
    $WINVM save -i "$instance" "$save" "$@"
  fi
  rc=$?
  if [ "$rc" -ne 0 ]; then
    echo "apply-env: applied, but the checkpoint failed (winvm save exited $rc)" >&2
    finish false save "$rc"; exit 3
  fi
fi
finish true done 0
exit 0
