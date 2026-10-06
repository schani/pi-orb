#!/bin/bash
# Only a synthetic fixture runs here; never inherit the caller's environment.
set -euo pipefail
root=$(realpath "${1:-/app}")
helpers=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
mode=${3:-accept}
trace_output=${4:-}
case "$mode" in accept|fail-in-flight) ;; *) exit 2 ;; esac
privilege=()
if [ "$(id -u)" != 0 ]; then privilege=(sudo -n --); fi
scratch=$(mktemp -d "${2:-/tmp}/.pi-orb-claude-acceptance.XXXXXXXX")
cleanup() {
  status=$?
  trap - EXIT
  if ! "${privilege[@]}" timeout --kill-after=1s 5s rm -rf -- "$scratch"; then
    printf 'CLAUDE_ACCEPTANCE_CLEANUP_FAILED\n' >&2
    if [ "$status" = 0 ]; then status=1; fi
  fi
  exit "$status"
}
trap cleanup EXIT
node=$(command -v node)
host_namespace=$(readlink /proc/self/ns/net)
"${privilege[@]}" chown 2000:2000 "$scratch"
# PID-namespace teardown kills every descendant, including orphaned native tools.
# The network namespace contains only loopback: no route, host broker or metadata.
if "${privilege[@]}" timeout --kill-after=5s 105s \
  unshare --net --pid --fork --kill-child --mount-proc /bin/bash -c '
    set -euo pipefail
    ip link set lo up
    exec setpriv --reuid=2000 --regid=2000 --clear-groups \
      --bounding-set=-all --no-new-privs \
      env -i PATH=/usr/local/bin:/usr/bin:/bin HOME="$2" TMPDIR="$2" \
      "$3" "$6/claude-workload.mjs" "$1" "$2" "$4" "$5"
  ' -- "$root" "$scratch" "$node" "$mode" "$host_namespace" "$helpers"; then
  exit 0
else
  status=$?
  if "${privilege[@]}" test -f "$scratch/progress.json"; then
    "${privilege[@]}" cat "$scratch/progress.json" 2>/dev/null || \
      printf 'CLAUDE_ACCEPTANCE_TRACE_EXPORT_FAILED\n' >&2
    printf '\n'
    if [ -n "$trace_output" ]; then
      if artifact=$(mktemp "$trace_output/.pi-orb-claude-trace.XXXXXXXX" 2>/dev/null); then
        "${privilege[@]}" cat "$scratch/progress.json" >"$artifact" 2>/dev/null || \
          printf 'CLAUDE_ACCEPTANCE_TRACE_EXPORT_FAILED\n' >&2
      else
        printf 'CLAUDE_ACCEPTANCE_TRACE_EXPORT_FAILED\n' >&2
      fi
    fi
    "${privilege[@]}" cat "$scratch/progress.json" >&2 2>/dev/null || \
      printf 'CLAUDE_ACCEPTANCE_PROGRESS_UNREADABLE\n' >&2
    printf '\n' >&2
  else
    printf '{"kind":"claude_qualification_failure_trace","schemaVersion":1,"traceUnavailable":true}\n'
  fi
  exit "$status"
fi
