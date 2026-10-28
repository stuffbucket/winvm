#!/usr/bin/env bash
# usage: scripts/accept-runtime.sh [instance]
#
# Accepts a winvm runtime on a real Windows guest under HVF, through winvm
# itself: every QEMU path winvm uses at run time, then a sweep for crash
# reports written while it ran. Run it before cutting a runtime release, with
# the runtime under test installed (WINVM_RUNTIME, or the app's), against an
# instance in a scratch WINVM_HOME; it stops and starts that instance and
# leaves no saves or snapshots behind.
#
# WINVM is the CLI to use (default: winvm on PATH).
# `A && ok || bad` is a plain if/else here: ok only echoes, so it cannot fail.
# shellcheck disable=SC2015
set -uo pipefail
i=${1:-default}
winvm=${WINVM:-winvm}
fail=0
# The instance goes right after the verb: after `--` it would belong to the guest command.
w() {
  local verb=$1
  shift
  "$winvm" "$verb" -i "$i" "$@"
}
step() { printf '%-40s ' "$1"; }
ok() { echo "ok"; }
bad() { echo "FAIL $*"; fail=1; }
# The guest answers a command within five minutes (after a start, load or reboot).
alive() {
  for _ in $(seq 1 60); do
    w exec -- cmd.exe /c echo alive 2> /dev/null | grep -q alive && return 0
    sleep 5
  done
  return 1
}
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
touch "$tmp/started"

"$winvm" doctor | grep -E "runtime"

step "start (HVF, swtpm, pflash, websocket VNC)"
w start > "$tmp/start.log" 2>&1 && alive && ok || bad "$(tail -2 "$tmp/start.log")"

step "PNG screenshot"
w screenshot "$tmp/s.png" > /dev/null 2>&1 && [ "$(head -c 8 "$tmp/s.png" | od -An -tx1 | tr -d ' \n')" = "89504e470d0a1a0a" ] && ok || bad

step "command in the guest"
[ "$(w exec -- powershell.exe -NoProfile -Command '6*7' 2> /dev/null | tr -d '\r\n ')" = "42" ] && ok || bad

step "file in and out"
head -c 1048576 /dev/urandom > "$tmp/in.bin"
w put "$tmp/in.bin" 'C:\Windows\Temp\winvm-accept.bin' > /dev/null 2>&1 &&
  w get 'C:\Windows\Temp\winvm-accept.bin' "$tmp/out.bin" > /dev/null 2>&1 && cmp -s "$tmp/in.bin" "$tmp/out.bin" && ok || bad

for fmt in zstd mapped raw; do
  step "save and load ($fmt)"
  name="accept-$fmt"
  if w save "$name" --format "$fmt" > "$tmp/save.log" 2>&1 && w load "$name" --no-watch > "$tmp/load.log" 2>&1 && alive; then ok; else bad "$(tail -1 "$tmp/save.log") $(tail -1 "$tmp/load.log")"; fi
  w saves rm "$name" > /dev/null 2>&1
done

step "snapshot and rewind (savevm/loadvm)"
if w snapshot accept > "$tmp/snap.log" 2>&1 && w rewind accept --no-watch > "$tmp/rewind.log" 2>&1 && alive; then ok; else bad "$(tail -1 "$tmp/snap.log") $(tail -1 "$tmp/rewind.log")"; fi
w snapshot accept --delete > /dev/null 2>&1

for n in 1 2 3; do
  step "reboot $n"
  w reboot > "$tmp/reboot.log" 2>&1 && alive && ok || bad "$(tail -1 "$tmp/reboot.log")"
done

step "stop"
if [ "$fail" -ne 0 ]; then
  echo "skipped: something failed, so the guest is left running to look at"
else
  w stop > /dev/null 2>&1 && ok || bad
fi

step "no QEMU, swtpm or zstd crash reports"
crashes=$(find "$HOME/Library/Logs/DiagnosticReports" -newer "$tmp/started" \( -name 'qemu-*' -o -name 'swtpm*' -o -name 'zstd*' \) 2> /dev/null)
[ -z "$crashes" ] && ok || bad "$crashes"

exit $fail
