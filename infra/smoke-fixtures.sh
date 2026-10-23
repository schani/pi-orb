#!/bin/bash
# Shared smoke ownership and verified cleanup. Never delete failed fixtures.
fixture_record() {
  if [ -n "${PI_ORB_RELEASE_RECORD:-}" ]; then
    if ! (cd "$DIR/.." && python3 -m infra.release_state fixture "$PI_ORB_RELEASE_RECORD" "$@"); then
      echo "smoke-cleanup: phase=record outcome=failed" >&2
      return 1
    fi
  fi
}

smoke_sleep() {
  local remaining=$(( $1 - $(date +%s) )) delay=${POLL_INTERVAL:-5}
  [ "$remaining" -gt 0 ] || return 0
  [ "$delay" -le "$remaining" ] || delay=$remaining
  sleep "$delay"
}

fixture_delete() { # Exit 2: API absence proven, but recording failed.
  local kind=$1 id=$2 response deadline path
  path="/api/v1/${kind}s/$id"
  deadline=$(( $(date +%s) + 300 ))
  [ "$deadline" -le "${DEADLINE:-$deadline}" ] || deadline=$DEADLINE
  if ! response=$(PI_ORB_SMOKE_DEADLINE="$deadline" "$API" "$path" '' DELETE); then
    echo "smoke-cleanup: phase=delete outcome=failed" >&2
    fixture_record "$kind" "$id" cleanup-failed || true
    return 1
  fi
  if [ -n "$response" ] && ! jq -e '.error == null or .error.code == "not_found"' <<<"$response" >/dev/null; then
    echo "smoke-cleanup: phase=delete outcome=failed" >&2
    fixture_record "$kind" "$id" cleanup-failed || true
    return 1
  fi
  while :; do
    if ! response=$(PI_ORB_SMOKE_DEADLINE="$deadline" "$API" "$path"); then break; fi
    if jq -e '.error.code == "not_found"' <<<"$response" >/dev/null; then
      if ! fixture_record "$kind" "$id" deleted; then
        echo "smoke-cleanup: phase=record outcome=failed" >&2
        return 2
      fi
      return 0
    fi
    if ! jq -e --arg id "$id" '.id == $id and .error == null' <<<"$response" >/dev/null; then break; fi
    if [ "$(date +%s)" -ge "$deadline" ]; then break; fi
    smoke_sleep "$deadline"
  done
  echo "smoke-cleanup: phase=confirm outcome=failed" >&2
  echo "Fixture cleanup not confirmed: $kind=$id; inspect before deleting anything else." >&2
  fixture_record "$kind" "$id" cleanup-failed || true
  return 1
}

smoke_wait_for_state() {
  local oid=$1 target=$2 timeout=$3 step=$4 limit last="" view state
  limit=$(( $(date +%s) + timeout ))
  [ "$limit" -le "$DEADLINE" ] || limit=$DEADLINE
  while :; do
    [ "$(date +%s)" -lt "$DEADLINE" ] || smoke_lifecycle_fail "$step" "overall timeout"
    view=$(PI_ORB_SMOKE_DEADLINE="$limit" api "/api/v1/orbs/$oid") ||
      smoke_lifecycle_fail "$step" "API unavailable"
    state=$(jq -er '.state | select(type == "string" and length > 0)' <<<"$view") ||
      smoke_lifecycle_fail "$step" "no orb state"
    if [ "$state" != "$last" ]; then say "$step: $oid: $state"; last=$state; fi
    [ "$state" != "$target" ] || return 0
    [ "$state" != failed ] || smoke_lifecycle_fail "$step" "orb failed"
    [ "$(date +%s)" -lt "$limit" ] ||
      smoke_lifecycle_fail "$step" "$state after ${timeout}s (wanted $target)"
    smoke_sleep "$limit"
  done
}

smoke_command_orb() {
  local oid=$1 verb=$2 response
  response=$(api "/api/v1/orbs/$oid/$verb" '{}') ||
    smoke_lifecycle_fail "$verb" "API unavailable"
  jq -e '.error == null' <<<"$response" >/dev/null ||
    smoke_lifecycle_fail "$verb" "command refused"
}
