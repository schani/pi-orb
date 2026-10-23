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

instance_summary() {
  jq '{name,id,disks:[.disks[] | {boot,source}],
    spec:([.metadata.items[] | select(.key == "pi-orb-host-spec-fingerprint") | .value][0])}'
}
orb_summary() { jq '{id,state}'; }
disk_summary() { jq '{name,id,status,sizeGb}'; }
fixture_evidence() {
  jq -nc --arg kind "$1" --arg id "$2" --arg outcome "$3" \
    '{kind:$kind,id:$id,outcome:$outcome}' >>"$log_dir/fixtures.jsonl"
}
record_owned() {
  fixture_evidence "$@" && fixture_record "$@"
}
on_exit() {
  local status=$? code
  trap - EXIT
  if (( status == 0 )); then
    if fixture_delete project "$project_id"; then
      project_pending=0
      fixture_evidence project "$project_id" deleted || status=1
    else
      code=$?; status=1
      if (( code == 2 )); then
        project_pending=0
        fixture_evidence project "$project_id" deleted || true
      fi
    fi
    if (( status == 0 )); then
      if fixture_delete orb "$orb_id"; then
        orb_pending=0
        fixture_evidence orb "$orb_id" deleted || status=1
      else
        code=$?; status=1
        if (( code == 2 )); then
          orb_pending=0
          fixture_evidence orb "$orb_id" deleted || true
        fi
      fi
    fi
    if (( status == 0 )) && ! verify_provider_cleanup; then
      echo "Owned provider cleanup unconfirmed: project=$project_id orb=$orb_id; compute/storage charges may remain." >&2
      status=1
    fi
  fi
  if (( status != 0 )); then
    (( project_pending == 0 )) || record_owned project "$project_id" retained || true
    (( orb_pending == 0 )) || record_owned orb "$orb_id" retained || true
    if (( project_pending || orb_pending )); then
      echo "Failed fixtures retained: project=$project_id orb=$orb_id; they may incur compute/storage charges." >&2
    fi
    echo '{"outcome":"failed"}' >"$log_dir/cleanup.json"
    dump_failure
  else
    echo '{"outcome":"verified"}' >"$log_dir/cleanup.json"
    echo "compute replacement smoke passed (cleanup verified): project=$project_id orb=$orb_id"
  fi
  exit "$status"
}
replacement_evidence_dir() {
  umask 077
  mkdir -p "$1"
  log_dir=$(mktemp -d "$1/compute-replacement-live.XXXXXXXX")
}

replacement_preflight() {
  : "${PI_ORB_USER_ID:?required}"
  local path response
  for path in "/api/v1/projects/$project_id" "/api/v1/orbs/$orb_id"; do
    response=$(PI_ORB_SMOKE_DEADLINE=$(( $(date +%s) + boot_deadline_seconds )) "$API" "$path") || return 1
    jq -e '.error.code == "not_found"' <<<"$response" >/dev/null || return 1
  done
}

replacement_create() {
  local kind=$1 id=$2 path=$3 body=$4 response
  printf -v "${kind}_pending" '%s' 1
  record_owned "$kind" "$id" requested || return 1
  response=$(api POST "$path" "$body") || return 1
  jq -e --arg id "$id" '.id == $id and .error == null' <<<"$response" >/dev/null || return 1
  record_owned "$kind" "$id" created
}

instance_absent() {
  local names
  names=$(resource_names instances "$1") || return 2
  [[ -z "$names" ]]
}
verify_provider_cleanup() {
  local -x PI_ORB_SMOKE_DEADLINE=$(( $(date +%s) + dispose_deadline_seconds ))
  local listed disks disk names
  while :; do
    listed=$(instances) || return 1
    disks=$(resource_names disks "$data_disk") || return 1
    for disk in "${boot_disks[@]}"; do
      names=$(resource_names disks "$disk") || return 1
      disks+=$names
    done
    [[ -z "$listed$disks" ]] && return 0
    if (( $(date +%s) >= PI_ORB_SMOKE_DEADLINE )); then
      echo "smoke-cleanup: phase=provider outcome=timeout" >&2
      return 1
    fi
    smoke_sleep "$PI_ORB_SMOKE_DEADLINE"
  done
}
