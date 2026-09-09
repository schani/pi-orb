#!/bin/bash
# Shared smoke ownership and verified cleanup. Never delete failed fixtures.
fixture_record() {
  if [ -n "${PI_ORB_RELEASE_RECORD:-}" ]; then
    python3 "$DIR/release_state.py" fixture "$PI_ORB_RELEASE_RECORD" "$@"
  fi
}

fixture_delete() {
  local kind=$1 id=$2 response deadline path
  path="/api/v1/${kind}s/$id"
  if ! response=$("$API" "$path" '' DELETE); then
    fixture_record "$kind" "$id" cleanup-failed || true
    return 1
  fi
  if [ -n "$response" ] && ! jq -e '.error == null or .error.code == "not_found"' <<<"$response" >/dev/null; then
    fixture_record "$kind" "$id" cleanup-failed || true
    return 1
  fi
  deadline=$(( $(date +%s) + 300 ))
  while :; do
    if ! response=$("$API" "$path"); then break; fi
    if jq -e '.error.code == "not_found"' <<<"$response" >/dev/null; then
      fixture_record "$kind" "$id" deleted
      return $?
    fi
    if ! jq -e --arg id "$id" '.id == $id and .error == null' <<<"$response" >/dev/null; then break; fi
    if [ "$(date +%s)" -ge "$deadline" ]; then break; fi
    sleep "${POLL_INTERVAL:-5}"
  done
  echo "Fixture cleanup not confirmed: $kind=$id; inspect before deleting anything else." >&2
  fixture_record "$kind" "$id" cleanup-failed || true
  return 1
}
