#!/bin/bash
# Signal-safe ownership of a release subprocess that has its own cleanup traps.
RELEASE_CHILD_PID=""

release_run_child() {
  local status
  "$@" &
  RELEASE_CHILD_PID=$!
  if wait "$RELEASE_CHILD_PID"; then status=0; else status=$?; fi
  RELEASE_CHILD_PID=""
  return "$status"
}

release_stop_child() {
  if [ -z "$RELEASE_CHILD_PID" ]; then return 0; fi
  kill -TERM "$RELEASE_CHILD_PID" 2>/dev/null || true
  wait "$RELEASE_CHILD_PID" 2>/dev/null || true
  RELEASE_CHILD_PID=""
}
