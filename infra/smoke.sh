#!/bin/bash
# Live create -> running -> stop -> start -> stop. The identity gate tests
# preview health from a peer orb, so CI needs no additional tailnet identity.
set -euo pipefail
DIR=$(cd "$(dirname "$0")" && pwd)
API="$DIR/api.sh"
source "$DIR/smoke-fixtures.sh"
: "${PI_ORB_USER_ID:?PI_ORB_USER_ID is required for smoke project creation}"
OVERALL_TIMEOUT=${OVERALL_TIMEOUT:-2700}
RUNNING_TIMEOUT=${RUNNING_TIMEOUT:-900}
STOPPED_TIMEOUT=${STOPPED_TIMEOUT:-300}
POLL_INTERVAL=${POLL_INTERVAL:-5}
START_TS=$(date +%s)
DEADLINE=$((START_TS + OVERALL_TIMEOUT))
export PI_ORB_SMOKE_HTTP=1
export PI_ORB_SMOKE_DEADLINE=$DEADLINE
PROJECT_ID=""
ORB_ID=""

cleanup() {
  local status=$?
  trap - EXIT
  if [ "$status" -eq 0 ]; then
    if [ -n "$PROJECT_ID" ]; then
      if fixture_delete project "$PROJECT_ID"; then PROJECT_ID=""; else [ "$?" -ne 2 ] || PROJECT_ID=""; status=1; fi
      if [ -z "$PROJECT_ID" ] && [ -n "$ORB_ID" ]; then
        # A project finalizer removes its orbs. Confirm the row is gone too.
        if fixture_delete orb "$ORB_ID"; then ORB_ID=""; else [ "$?" -ne 2 ] || ORB_ID=""; status=1; fi
      fi
    fi
  fi
  if [ "$status" -ne 0 ] && [ -n "$PROJECT_ID$ORB_ID" ]; then
    [ -z "$PROJECT_ID" ] || fixture_record project "$PROJECT_ID" retained || true
    [ -z "$ORB_ID" ] || fixture_record orb "$ORB_ID" retained || true
    echo "Failed fixtures retained: project=$PROJECT_ID orb=$ORB_ID; they may incur compute/storage charges." >&2
  fi
  if [ "$status" -eq 0 ]; then echo "LIFECYCLE SMOKE PASSED (cleanup verified)"; fi
  exit "$status"
}
trap cleanup EXIT

say() { printf '[%s] %s\n' "$(date -u +%H:%M:%S)" "$*" >&2; }
fail() { echo "SMOKE FAILED: $* (project=$PROJECT_ID orb=$ORB_ID)" >&2; exit 1; }
api() { "$API" "$@"; }

smoke_lifecycle_fail() { fail "$1: $2"; }

for command in jq python3 uuidgen; do command -v "$command" >/dev/null || fail "missing $command"; done
PI_ORB_APP_ORIGIN=${PI_ORB_APP_ORIGIN:-$(python3 "$DIR/smoke_http.py" external tofu-app)} || fail "app URL unavailable"
[ -n "$PI_ORB_APP_ORIGIN" ] || fail "app URL empty"
export PI_ORB_APP_ORIGIN
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
smoke_wait_for_state "$ORB_ID" running "$RUNNING_TIMEOUT" first-boot
smoke_command_orb "$ORB_ID" stop
smoke_wait_for_state "$ORB_ID" stopped "$STOPPED_TIMEOUT" first-stop
smoke_command_orb "$ORB_ID" start
smoke_wait_for_state "$ORB_ID" running "$RUNNING_TIMEOUT" restart
smoke_command_orb "$ORB_ID" stop
smoke_wait_for_state "$ORB_ID" stopped "$STOPPED_TIMEOUT" final-stop
say "Lifecycle assertions passed in $(( $(date +%s) - START_TS ))s; verifying fixture deletion."
