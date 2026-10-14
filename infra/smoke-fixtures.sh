#!/bin/bash
# Shared smoke ownership and verified cleanup. Never delete failed fixtures.
fixture_record() {
  if [ -n "${PI_ORB_RELEASE_RECORD:-}" ]; then
    (cd "$DIR/.." && python3 -m infra.release_state fixture "$PI_ORB_RELEASE_RECORD" "$@")
  fi
}

fixture_failure() {
  # Only owned IDs and fixed diagnostic codes; never API response text.
  printf 'Fixture cleanup not confirmed: kind=%s id=%s phase=%s exit=%s errorcode=%s; inspect before deleting anything else.\n' "$@" >&2
  fixture_record "$1" "$2" cleanup-failed || true
  return 1
}

fixture_delete() {
  local kind=$1 id=$2 response deadline path status
  path="/api/v1/${kind}s/$id"
  if response=$("$API" "$path" '' DELETE); then
    :
  else
    status=$?
    fixture_failure "$kind" "$id" delete "$status" api_failure
    return 1
  fi
  if [ -n "$response" ] && ! jq -e '.error == null or (.error.code == "not_found" and .httpStatus == 404)' <<<"$response" >/dev/null 2>&1; then
    fixture_failure "$kind" "$id" delete 0 application_error
    return 1
  fi
  deadline=$(( $(date +%s) + 300 ))
  while :; do
    if response=$("$API" "$path"); then
      :
    else
      status=$?
      fixture_failure "$kind" "$id" confirm "$status" api_failure
      return 1
    fi
    if jq -e '.error.code == "not_found" and .httpStatus == 404' <<<"$response" >/dev/null 2>&1; then
      if fixture_record "$kind" "$id" deleted; then
        return 0
      else
        status=$?
      fi
      fixture_failure "$kind" "$id" record "$status" record_failure
      return 1
    fi
    if ! jq -e --arg id "$id" '.id == $id and .error == null' <<<"$response" >/dev/null 2>&1; then
      fixture_failure "$kind" "$id" confirm 0 invalid_response
      return 1
    fi
    if [ "$(date +%s)" -ge "$deadline" ]; then
      fixture_failure "$kind" "$id" confirm 0 deadline
      return 1
    fi
    sleep "${POLL_INTERVAL:-5}"
  done
}
