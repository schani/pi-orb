#!/bin/bash
# Live create -> running -> stop -> start -> stop. The identity gate tests
# preview health from a peer orb, so CI needs no additional tailnet identity.
set -euo pipefail
DIR=$(cd "$(dirname "$0")" && pwd)
API="$DIR/api.sh"
source "$DIR/smoke-fixtures.sh"
OVERALL_TIMEOUT=${OVERALL_TIMEOUT:-2700}
RUNNING_TIMEOUT=${RUNNING_TIMEOUT:-900}
STOPPED_TIMEOUT=${STOPPED_TIMEOUT:-300}
POLL_INTERVAL=${POLL_INTERVAL:-5}
START_TS=$(date +%s)
DEADLINE=$((START_TS + OVERALL_TIMEOUT))
PROJECT_ID=""
ORB_ID=""

cleanup() {
  local status=$?
  trap - EXIT
  if [ "$status" -eq 0 ]; then
    if [ -n "$PROJECT_ID" ]; then
      fixture_delete project "$PROJECT_ID" || status=1
      if [ "$status" -eq 0 ] && [ -n "$ORB_ID" ]; then
        # A project finalizer removes its orbs. Confirm the row is gone too.
        fixture_delete orb "$ORB_ID" || status=1
      fi
    fi
  else
    [ -z "$PROJECT_ID" ] || fixture_record project "$PROJECT_ID" retained || true
    [ -z "$ORB_ID" ] || fixture_record orb "$ORB_ID" retained || true
    echo "Failed fixtures retained: project=$PROJECT_ID orb=$ORB_ID; they may incur compute/storage charges." >&2
  fi
  exit "$status"
}
trap cleanup EXIT

say() { printf '[%s] %s\n' "$(date -u +%H:%M:%S)" "$*" >&2; }
fail() { echo "SMOKE FAILED: $* (project=$PROJECT_ID orb=$ORB_ID)" >&2; exit 1; }
api() { "$API" "$@"; }

wait_for_state() {
  local target=$1 timeout=$2 step=$3 limit last="" view state
  limit=$(( $(date +%s) + timeout ))
  while :; do
    if [ "$(date +%s)" -ge "$DEADLINE" ]; then fail "$step: overall timeout"; fi
    view=$(api "/api/v1/orbs/$ORB_ID") || fail "$step: API unavailable"
    state=$(jq -er '.state' <<<"$view") || fail "$step: no orb state"
    if [ "$state" != "$last" ]; then say "$step: $state"; last=$state; fi
    if [ "$state" = "$target" ]; then return 0; fi
    if [ "$state" = failed ]; then fail "$step: $(jq -r '.lastError' <<<"$view")"; fi
    if [ "$(date +%s)" -ge "$limit" ]; then fail "$step: $state after ${timeout}s (wanted $target)"; fi
    sleep "$POLL_INTERVAL"
  done
}

command_orb() {
  local response
  response=$(api "/api/v1/orbs/$ORB_ID/$1" '{}') || fail "$1: API unavailable"
  jq -e '.error == null' <<<"$response" >/dev/null || fail "$1 refused"
}

for command in jq python3 uuidgen; do command -v "$command" >/dev/null || fail "missing $command"; done
export PI_ORB_OPS_URL=${PI_ORB_OPS_URL:-$(cd "$DIR" && tofu output -raw ops_url)}
PROJECT_ID=$(uuidgen | tr '[:upper:]' '[:lower:]')
ORB_ID=$(uuidgen | tr '[:upper:]' '[:lower:]')
fixture_record project "$PROJECT_ID" requested
fixture_record orb "$ORB_ID" requested
say "lifecycle smoke: project=$PROJECT_ID orb=$ORB_ID"
response=$(api /api/v1/projects "$(jq -nc --arg id "$PROJECT_ID" '{id:$id,name:("smoke-"+$id),repositoryUrl:"https://github.com/octocat/Hello-World"}')") || fail "create-project unavailable"
jq -e --arg id "$PROJECT_ID" '.id == $id' <<<"$response" >/dev/null || fail "create-project refused"
fixture_record project "$PROJECT_ID" created
response=$(api "/api/v1/projects/$PROJECT_ID/orbs" "$(jq -nc --arg id "$ORB_ID" '{id:$id}')") || fail "create-orb unavailable"
jq -e --arg id "$ORB_ID" '.id == $id' <<<"$response" >/dev/null || fail "create-orb refused"
fixture_record orb "$ORB_ID" created
wait_for_state running "$RUNNING_TIMEOUT" first-boot
command_orb stop
wait_for_state stopped "$STOPPED_TIMEOUT" first-stop
command_orb start
wait_for_state running "$RUNNING_TIMEOUT" restart
command_orb stop
wait_for_state stopped "$STOPPED_TIMEOUT" final-stop
say "Lifecycle assertions passed in $(( $(date +%s) - START_TS ))s; verifying fixture deletion."
