#!/bin/bash
# Post-deploy smoke test against the live deployment.
#
# Walks the exact sequence that exposed the 2026-08-06 incident
# (docs/postmortems/2026-08-06-rollover-repair-war-corrupt-image.md):
#
#   create project -> create orb -> running -> [tailnet health] ->
#   stop -> stopped -> start -> running -> stop -> stopped
#
# The second start is the load-bearing leg: the deploy-rollover repair war and
# the corrupt docker layer cache were both invisible on the first boot and only
# surfaced when an already-created orb was started again.
#
# Usage:
#   ./infra/smoke.sh
#
# Talks to the ops service through api.sh (pi-orb-debug impersonation), so it
# needs the same valid gcloud credentials as any other tooling here.
set -euo pipefail

DIR=$(cd "$(dirname "$0")" && pwd)
API="$DIR/api.sh"

OVERALL_TIMEOUT=${OVERALL_TIMEOUT:-720}   # 12 minutes, whole run
RUNNING_TIMEOUT=${RUNNING_TIMEOUT:-300}   # 5 minutes per start
STOPPED_TIMEOUT=${STOPPED_TIMEOUT:-180}   # 3 minutes per stop
TAILNET_TIMEOUT=${TAILNET_TIMEOUT:-60}    # machine visible on the tailnet
HEALTH_TIMEOUT=${HEALTH_TIMEOUT:-60}      # preview health reaches "ready"
POLL_INTERVAL=${POLL_INTERVAL:-5}

START_TS=$(date +%s)
DEADLINE=$((START_TS + OVERALL_TIMEOUT))

# Resolve the ops URL once; api.sh otherwise shells out to tofu on every call
# and this script makes a lot of calls.
export PI_ORB_OPS_URL=${PI_ORB_OPS_URL:-$(cd "$DIR" && tofu output -raw ops_url)}

ORB_ID=""

# Progress goes to stderr: some steps return a JSON document on stdout.
say() {
  printf '[%s] %s\n' "$(date -u +%H:%M:%S)" "$*" >&2
}

fail() {
  local step=$1
  shift
  echo >&2
  echo "SMOKE FAILED at step: $step" >&2
  echo "  $*" >&2
  [ -n "$ORB_ID" ] && echo "  orb: $ORB_ID" >&2
  exit 1
}

check_deadline() {
  if [ "$(date +%s)" -ge "$DEADLINE" ]; then
    fail "$1" "overall timeout of ${OVERALL_TIMEOUT}s exceeded"
  fi
}

# --- JSON access ------------------------------------------------------------
# jq is not guaranteed on every machine that deploys; python3 is (macOS ships
# it, and the repo's other ad-hoc tooling already leans on it).
if command -v python3 >/dev/null 2>&1; then
  jget() { # jget <dotted.path> ; JSON on stdin ; prints "" when absent
    python3 -c '
import json, sys
try:
    doc = json.load(sys.stdin)
except Exception:
    sys.exit(3)
for key in sys.argv[1].split("."):
    if not isinstance(doc, dict) or key not in doc:
        print("")
        sys.exit(0)
    doc = doc[key]
print("" if doc is None else doc)
' "$1"
  }
elif command -v jq >/dev/null 2>&1; then
  jget() {
    # Same contract as the python3 branch: "" for an absent field, exit 3 for a
    # body that is not JSON at all (an auth failure returns an HTML page, and
    # callers want to report that as unparseable rather than as a missing id).
    local doc
    doc=$(cat)
    printf '%s' "$doc" | jq -e . >/dev/null 2>&1 || return 3
    printf '%s' "$doc" | jq -r --arg p "$1" '
      ($p | split(".")) as $path
      | (getpath($path) // "")
      | if type == "object" or type == "array" then tojson else tostring end
    ' 2>/dev/null || return 3
  }
else
  echo "smoke.sh needs python3 or jq to parse JSON responses" >&2
  exit 1
fi

api() { # api <path> [json-body]
  if [ $# -ge 2 ]; then "$API" "$1" "$2"; else "$API" "$1"; fi
}

# --- steps ------------------------------------------------------------------

create_project() {
  local pid=$1 name=$2 body response got
  body=$(printf '{"id":"%s","name":"%s","repositoryUrl":"%s"}' \
    "$pid" "$name" "https://github.com/octocat/Hello-World")
  response=$(api /api/v1/projects "$body") ||
    fail "create-project" "api.sh failed"
  got=$(printf '%s' "$response" | jget id) ||
    fail "create-project" "unparseable response: $response"
  [ "$got" = "$pid" ] ||
    fail "create-project" "response did not echo the project id: $response"
  say "project created: $pid ($name)"
}

create_orb() {
  local pid=$1 oid=$2 response got
  response=$(api "/api/v1/projects/$pid/orbs" "$(printf '{"id":"%s"}' "$oid")") ||
    fail "create-orb" "api.sh failed"
  got=$(printf '%s' "$response" | jget id) ||
    fail "create-orb" "unparseable response: $response"
  [ "$got" = "$oid" ] ||
    fail "create-orb" "response did not echo the orb id: $response"
  say "orb created: $oid (state $(printf '%s' "$response" | jget state))"
}

orb_view() {
  api "/api/v1/orbs/$ORB_ID"
}

# wait_for_state <target> <timeout> <step-name>
wait_for_state() {
  local target=$1 timeout=$2 step=$3
  local limit=$(( $(date +%s) + timeout ))
  local last="" view state
  while :; do
    check_deadline "$step"
    view=$(orb_view) || fail "$step" "api.sh failed while polling"
    state=$(printf '%s' "$view" | jget state) ||
      fail "$step" "unparseable orb view: $view"
    if [ -z "$state" ]; then
      fail "$step" "orb view carried no state: $view"
    fi
    if [ "$state" != "$last" ]; then
      say "  state: $state"
      last=$state
    fi
    case "$state" in
      "$target")
        say "reached $target after $(( $(date +%s) - limit + timeout ))s"
        printf '%s' "$view"
        return 0
        ;;
      failed)
        fail "$step" "orb entered 'failed'; lastError: $(printf '%s' "$view" | jget lastError)"
        ;;
    esac
    if [ "$(date +%s)" -ge "$limit" ]; then
      fail "$step" "orb stuck in '$state' after ${timeout}s (wanted '$target')"
    fi
    sleep "$POLL_INTERVAL"
  done
}

tailscale_cli() {
  local app=/Applications/Tailscale.app/Contents/MacOS/Tailscale
  if [ -x "$app" ]; then
    echo "$app"
  elif command -v tailscale >/dev/null 2>&1; then
    command -v tailscale
  fi
  # Never fail: "no CLI here" is an empty answer, not an error, and under
  # `set -e` a non-zero return would abort the script instead of skipping.
  return 0
}

# The preview leg is best-effort: no tailscale CLI on this machine, or no
# previewHost in the view (port exposure not configured), is a SKIP and never a
# failure. Only a machine that joins the tailnet and then refuses to report
# "ready" is a real defect.
check_preview() {
  local view=$1 preview ts limit code body machine
  preview=$(printf '%s' "$view" | jget previewHost)
  if [ -z "$preview" ]; then
    say "SKIP preview health: orb view carries no previewHost (port exposure not configured)"
    return 0
  fi
  ts=$(tailscale_cli)
  if [ -z "$ts" ]; then
    say "SKIP preview health: no tailscale CLI on this machine"
    return 0
  fi

  machine="pi-orb-$ORB_ID"
  say "waiting for tailnet machine $machine (<= ${TAILNET_TIMEOUT}s)"
  limit=$(( $(date +%s) + TAILNET_TIMEOUT ))
  while ! "$ts" status 2>/dev/null | grep -q -- "$machine"; do
    if [ "$(date +%s)" -ge "$limit" ]; then
      say "SKIP preview health: $machine never appeared in tailscale status"
      return 0
    fi
    sleep "$POLL_INTERVAL"
  done
  say "  tailnet machine present"

  say "fetching http://$preview:8080/v1/health (<= ${HEALTH_TIMEOUT}s for ready)"
  limit=$(( $(date +%s) + HEALTH_TIMEOUT ))
  while :; do
    check_deadline "preview-health"
    body=$(curl -s --max-time 10 -w '\n%{http_code}' "http://$preview:8080/v1/health" 2>/dev/null || true)
    code=$(printf '%s' "$body" | tail -n1)
    body=$(printf '%s' "$body" | sed '$d')
    if [ "$code" = "200" ] && printf '%s' "$body" | grep -q '"status":"ready"'; then
      say "  preview health ready: $body"
      return 0
    fi
    if [ "$(date +%s)" -ge "$limit" ]; then
      fail "preview-health" "http://$preview:8080/v1/health never returned 200 with status=ready (last: HTTP ${code:-none} ${body:-<empty>})"
    fi
    sleep "$POLL_INTERVAL"
  done
}

command_orb() { # command_orb <start|stop>
  local verb=$1 response err
  response=$(api "/api/v1/orbs/$ORB_ID/$verb" '{}') ||
    fail "$verb-orb" "api.sh failed"
  err=$(printf '%s' "$response" | jget error.code) ||
    fail "$verb-orb" "unparseable response: $response"
  [ -z "$err" ] ||
    fail "$verb-orb" "control plane refused $verb: $response"
  say "$verb requested"
}

# --- run --------------------------------------------------------------------

PROJECT_ID=$(uuidgen | tr '[:upper:]' '[:lower:]')
ORB_ID=$(uuidgen | tr '[:upper:]' '[:lower:]')
PROJECT_NAME="smoke-$(date -u +%Y%m%d-%H%M%S)"

say "smoke test against $PI_ORB_OPS_URL"
say "project $PROJECT_ID, orb $ORB_ID"

say "step 1/6: create project + orb"
create_project "$PROJECT_ID" "$PROJECT_NAME"
create_orb "$PROJECT_ID" "$ORB_ID"

say "step 2/6: wait for first boot to reach running"
VIEW=$(wait_for_state running "$RUNNING_TIMEOUT" "first-boot")

say "step 3/6: preview health over the tailnet"
check_preview "$VIEW"

say "step 4/6: stop"
command_orb stop
wait_for_state stopped "$STOPPED_TIMEOUT" "first-stop" >/dev/null

say "step 5/6: start again (the leg that catches repair wars and corrupt caches)"
command_orb start
wait_for_state running "$RUNNING_TIMEOUT" "restart" >/dev/null

say "step 6/6: stop again"
command_orb stop
wait_for_state stopped "$STOPPED_TIMEOUT" "final-stop" >/dev/null

echo
echo "SMOKE PASSED in $(( $(date +%s) - START_TS ))s"
echo "  project: $PROJECT_ID ($PROJECT_NAME)"
echo "  orb:     $ORB_ID (left in 'stopped')"
echo "  Note: smoke orbs accumulate — there is no orb deletion API yet, so the"
echo "  orb and its project stay in the deployment until one is added."
