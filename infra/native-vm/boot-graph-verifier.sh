#!/bin/bash
set -euo pipefail
if ! graph=$(LC_ALL=C systemd-analyze --man=no verify "$@" 2>&1); then
  printf '%s\n' "$graph" >&2
  printf 'PI_ORB_SEAL_GUARD_FAILED=boot_graph_verify\n' >&2
  exit 1
fi
printf '%s\n' "$graph"
if grep -q 'ordering cycle' <<<"$graph"; then
  printf 'PI_ORB_SEAL_GUARD_FAILED=boot_graph_ordering_cycle\n' >&2
  exit 1
fi
