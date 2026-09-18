#!/bin/bash
# Signal-safe ownership of release subprocesses that may have their own cleanup traps.
RELEASE_CHILD_PIDS=""
RELEASE_STARTED_PID=""

release_start_child() {
  "$@" &
  RELEASE_STARTED_PID=$!
  if [ -n "$RELEASE_CHILD_PIDS" ]; then
    RELEASE_CHILD_PIDS="$RELEASE_CHILD_PIDS $RELEASE_STARTED_PID"
  else
    RELEASE_CHILD_PIDS=$RELEASE_STARTED_PID
  fi
}

release_forget_child() {
  local target=$1 pid
  local remaining=""
  for pid in $RELEASE_CHILD_PIDS; do
    if [ "$pid" != "$target" ]; then
      if [ -n "$remaining" ]; then remaining="$remaining $pid"; else remaining=$pid; fi
    fi
  done
  RELEASE_CHILD_PIDS=$remaining
}

release_wait_child() {
  local pid=$1 status
  if wait "$pid"; then status=0; else status=$?; fi
  release_forget_child "$pid"
  return "$status"
}

release_run_child() {
  local pid status
  release_start_child "$@"
  pid=$RELEASE_STARTED_PID
  if release_wait_child "$pid"; then status=0; else status=$?; fi
  return "$status"
}

release_child_is_running() {
  local target=$1 pid
  for pid in $(jobs -pr); do
    [ "$pid" = "$target" ] && return 0
  done
  return 1
}

release_wait_children() {
  local pid status
  while [ -n "$RELEASE_CHILD_PIDS" ]; do
    for pid in $RELEASE_CHILD_PIDS; do
      if ! release_child_is_running "$pid"; then
        if release_wait_child "$pid"; then status=0; else status=$?; fi
        if [ "$status" -ne 0 ]; then
          release_stop_children
          return "$status"
        fi
      fi
    done
    [ -z "$RELEASE_CHILD_PIDS" ] || sleep 0.1
  done
}

release_stop_children() {
  local pid
  for pid in $RELEASE_CHILD_PIDS; do
    if release_child_is_running "$pid"; then
      kill -TERM "$pid" 2>/dev/null || true
    fi
  done
  for pid in $RELEASE_CHILD_PIDS; do
    wait "$pid" 2>/dev/null || true
  done
  RELEASE_CHILD_PIDS=""
  RELEASE_STARTED_PID=""
}
