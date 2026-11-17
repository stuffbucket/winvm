#!/usr/bin/env bash
# usage: scripts/accept-keeper.sh install | report [RUN] | cleanup
#
# Measures what a real Mac restart and a real logout do to a keeper job, with
# a dummy child and no VM. install starts the test job
# co.stuffbucket.winvm.test.accept-keeper in your Background launchd domain:
# the keeper from this checkout keeps a shell loop that writes the time every
# second, and on SIGTERM runs a stop action that writes the time every second
# until the keeper's deadline (50 s) or until something kills it. report prints
# what happened; cleanup removes the job, its processes and every file.
#
#   1. scripts/accept-keeper.sh install
#   2. Restart the Mac. It may take about a minute longer than usual.
#   3. Log in, then: scripts/accept-keeper.sh report > ~/keeper-restart.txt
#   4. scripts/accept-keeper.sh install
#   5. Log out, log back in, then: scripts/accept-keeper.sh report > ~/keeper-logout.txt
#   6. scripts/accept-keeper.sh cleanup, and send the two files.
#
# WINVM_KEEPER names a keeper binary to use instead of building native/keeper.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/.." && pwd)
base="$HOME/.local/state/winvm-accept-keeper"
label=co.stuffbucket.winvm.test.accept-keeper
job="user/$(id -u)/$label"

loaded() { launchctl print "$job" >/dev/null 2>&1; }
latest() { find "$base" -maxdepth 1 -type d -name 'run-*' 2>/dev/null | sort | tail -n 1; }
when() { date -r "$1" '+%Y-%m-%d %H:%M:%S'; }

install() {
  if loaded; then
    echo "already installed; run report or cleanup" >&2
    exit 1
  fi
  local keeper=${WINVM_KEEPER:-} run
  if [ -z "$keeper" ]; then
    mise exec -C "$root/native/keeper" -- cargo build --release --locked \
      --manifest-path "$root/native/keeper/Cargo.toml" >&2
    keeper="$root/native/keeper/target/release/winvm-keeper"
  fi
  mkdir -p "$base/bin"
  cp "$keeper" "$base/bin/winvm-keeper"
  run="$base/run-$(date +%Y%m%d-%H%M%S)"
  mkdir -p "$run/keeper"
  chmod 700 "$run/keeper"
  cat >"$run/keeper/spec.json" <<EOF
{
  "instance": "accept-keeper",
  "record": "$run/events.jsonl",
  "lingerMs": 0,
  "child": {
    "name": "dummy",
    "argv": ["/bin/sh", "-c", "while :; do date +%s >> \"\$0\"; sleep 1; done", "$run/child.beat"],
    "log": "$run/child.log"
  },
  "stop": {
    "argv": ["/bin/sh", "-c", "echo \"start \$(date +%s) deadline-ms \$WINVM_KEEPER_DEADLINE_MS\" >> \"\$0\"; i=0; while [ \$i -lt 120 ]; do date +%s >> \"\$0\"; sleep 1; i=\$((i+1)); done", "$run/stop.beat"],
    "log": "$run/stop.log"
  }
}
EOF
  bun "$here/keeper-plist.ts" --label "$label" --program "$base/bin/winvm-keeper" \
    --dir "$run/keeper" --exit-timeout 60 >"$run/keeper/keeper.plist"
  launchctl bootstrap "user/$(id -u)" "$run/keeper/keeper.plist"
  for _ in $(seq 1 50); do
    if "$base/bin/winvm-keeper" ctl --dir "$run/keeper" '{"op":"hello"}' 2>/dev/null; then
      echo "installed $label ($run)"
      return 0
    fi
    sleep 0.2
  done
  echo "the keeper did not answer; see $run/keeper/keeper.log" >&2
  exit 1
}

beats() {
  local file=$1 first last count prev=""
  if [ ! -s "$file" ]; then
    echo "  none"
    return 0
  fi
  first=$(grep -E '^[0-9]+$' "$file" | head -n 1)
  last=$(grep -E '^[0-9]+$' "$file" | tail -n 1)
  count=$(grep -cE '^[0-9]+$' "$file")
  echo "  first $(when "$first") ($first)"
  echo "  last  $(when "$last") ($last), $count beats"
  grep -E '^[0-9]+$' "$file" | while read -r t; do
    if [ -n "$prev" ] && [ $((t - prev)) -gt 2 ]; then
      echo "  gap   $(when "$prev") -> $(when "$t"), $((t - prev)) s"
    fi
    prev=$t
  done
}

report() {
  local run=${1:-$(latest)}
  if [ -z "$run" ] || [ ! -d "$run" ]; then
    echo "no run to report; run install first" >&2
    exit 1
  fi
  echo "run      $run"
  echo "now      $(date '+%Y-%m-%d %H:%M:%S %Z')"
  echo "booted   $(sysctl -n kern.boottime)"
  echo "macOS    $(sw_vers -productVersion) ($(sw_vers -buildVersion))"
  echo "--- launchd job"
  launchctl print "$job" 2>/dev/null | grep -E $'^\t(state|pid|runs|last exit code|exit timeout) =' || echo "  not loaded"
  echo "--- recent sessions"
  last -40 2>/dev/null | grep -E '^(reboot|shutdown)|console' | head -n 8 || true
  echo "--- keeper record"
  grep '"kind":"keeper"' "$run/events.jsonl" 2>/dev/null || echo "  empty"
  echo "--- child heartbeat"
  beats "$run/child.beat"
  echo "--- stop action"
  grep '^start' "$run/stop.beat" 2>/dev/null | sed 's/^/  /' || true
  beats "$run/stop.beat"
  echo "--- keeper.log (last 15 lines)"
  tail -n 15 "$run/keeper/keeper.log" 2>/dev/null || echo "  empty"
}

cleanup() {
  local run
  run=$(latest)
  if loaded; then
    if [ -n "$run" ]; then
      "$base/bin/winvm-keeper" ctl --dir "$run/keeper" '{"op":"kill"}' >/dev/null 2>&1 || true
    fi
    launchctl bootout "$job" 2>/dev/null || true
    for _ in $(seq 1 100); do
      loaded || break
      sleep 0.2
    done
  fi
  pkill -KILL -f -- "$base/" 2>/dev/null || true
  sleep 0.5
  rm -rf "$base"
  if loaded || pgrep -f -- "$base/" >/dev/null; then
    echo "cleanup incomplete: launchctl print $job; pgrep -fl $base/" >&2
    exit 1
  fi
  echo "removed $label and $base"
}

case "${1:-}" in
install) install ;;
report) report "${2:-}" ;;
cleanup) cleanup ;;
*)
  sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//'
  exit 2
  ;;
esac
