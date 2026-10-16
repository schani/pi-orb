#!/bin/bash
# Shared smoke ownership and verified cleanup. Never delete failed fixtures.
fixture_record() {
  if [ -n "${PI_ORB_RELEASE_RECORD:-}" ]; then
    (cd "$DIR/.." && python3 -m infra.release_state fixture "$PI_ORB_RELEASE_RECORD" "$@")
  fi
}

smoke_sleep() {
  local remaining=$(( $1 - $(date +%s) )) delay=${POLL_INTERVAL:-5}
  [ "$remaining" -gt 0 ] || return 0
  [ "$delay" -le "$remaining" ] || delay=$remaining
  sleep "$delay"
}

fixture_delete() {
  local kind=$1 id=$2 response deadline path
  path="/api/v1/${kind}s/$id"
  deadline=$(( $(date +%s) + 300 ))
  [ "$deadline" -le "${DEADLINE:-$deadline}" ] || deadline=$DEADLINE
  if ! response=$(PI_ORB_SMOKE_DEADLINE="$deadline" "$API" "$path" '' DELETE); then
    fixture_record "$kind" "$id" cleanup-failed || true
    return 1
  fi
  if [ -n "$response" ] && ! jq -e '.error == null or .error.code == "not_found"' <<<"$response" >/dev/null; then
    fixture_record "$kind" "$id" cleanup-failed || true
    return 1
  fi
  while :; do
    if ! response=$(PI_ORB_SMOKE_DEADLINE="$deadline" "$API" "$path"); then break; fi
    if jq -e '.error.code == "not_found"' <<<"$response" >/dev/null; then
      fixture_record "$kind" "$id" deleted
      return $?
    fi
    if ! jq -e --arg id "$id" '.id == $id and .error == null' <<<"$response" >/dev/null; then break; fi
    if [ "$(date +%s)" -ge "$deadline" ]; then break; fi
    smoke_sleep "$deadline"
  done
  echo "Fixture cleanup not confirmed: $kind=$id; inspect before deleting anything else." >&2
  fixture_record "$kind" "$id" cleanup-failed || true
  return 1
}
