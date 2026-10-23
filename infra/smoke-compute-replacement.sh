#!/usr/bin/env bash
set -euo pipefail
umask 077

# Disposable live-GCE acceptance smoke for docs/compute-replacement.md.
# Required environment:
#   PI_ORB_BASE_URL, PI_ORB_GCP_PROJECT, PI_ORB_GCE_ZONE, PI_ORB_USER_ID
# Optional:
#   PI_ORB_SMOKE_REPOSITORY_URL, PI_ORB_SMOKE_PROJECT_ID, PI_ORB_SMOKE_ORB_ID
#   PI_ORB_SMOKE_STAGE2_DEPLOY_COMMAND — deploys a higher generation with a
#     different effective host spec; when set, the Stage 2 leg is mandatory.
#
# This script intentionally uses product lifecycle APIs plus a workspace marker;
# there is no production failpoint. The runtime E2E marker is accepted only when
# PI_ORB_E2E_LAUNCH_FAILURE_MARKER is explicitly configured on the release.

# Outer budget: every bounded wait below derives from one provision + native
# Debian boot + runtime-ready pass (the slowest provider operation this smoke performs).
# Lifecycle create/start/failure waits use it in full; stop and disposal are pure provider
# operations and get a fraction. The two negative-observation windows
# — no autonomous replacement after failure, and no running orb touched by a
# deployed specification change — are the only deliberate elapsed-time
# assertions in this script.
boot_deadline_seconds=900
stop_deadline_seconds=$((boot_deadline_seconds / 3))
dispose_deadline_seconds=$((boot_deadline_seconds / 3))
negative_window_seconds=65            # more than two 30s terminal-backstop intervals

DIR=$(cd "$(dirname "$0")" && pwd)
API="$DIR/api.sh"
source "$DIR/smoke-fixtures.sh"

for command in curl jq gcloud base64 python3 mktemp; do
  command -v "$command" >/dev/null || { echo "missing required command: $command" >&2; exit 2; }
done
: "${PI_ORB_BASE_URL:?required}"
: "${PI_ORB_GCP_PROJECT:?required}"
: "${PI_ORB_GCE_ZONE:?required}"
: "${PI_ORB_USER_ID:?required}"

repo=${PI_ORB_SMOKE_REPOSITORY_URL:-https://github.com/schani/pi-orb}
project_id=${PI_ORB_SMOKE_PROJECT_ID:-$(python3 -c 'import uuid; print(uuid.uuid4())')}
orb_id=${PI_ORB_SMOKE_ORB_ID:-$(python3 -c 'import uuid; print(uuid.uuid4())')}
base=${PI_ORB_BASE_URL%/}
export PI_ORB_APP_ORIGIN=$base
export PROJECT=${PROJECT:-$PI_ORB_GCP_PROJECT}
export PI_ORB_SMOKE_HTTP=1
instance_prefix="pi-orb-${orb_id}-i"
data_disk="pi-orb-data-${orb_id}"
log_root=${PI_ORB_SMOKE_LOG_DIR:-test-failures}
replacement_evidence_dir "$log_root"
echo "compute replacement evidence: $log_dir" >&2

api() {
  local method=$1 path=$2 body=${3-} response
  response=$(PI_ORB_SMOKE_DEADLINE=${PI_ORB_SMOKE_DEADLINE:-$(( $(date +%s) + boot_deadline_seconds ))} \
    "$API" "$path" "$body" "$method") || return 1
  jq -e '.error == null' <<<"$response" >/dev/null || return 1
  printf '%s\n' "$response"
}
external() {
  PI_ORB_SMOKE_DEADLINE=${PI_ORB_SMOKE_DEADLINE:-$(( $(date +%s) + boot_deadline_seconds ))} \
    python3 "$DIR/smoke_http.py" external "$@"
}
orb_row() { api GET "/api/v1/orbs/$orb_id"; }
instances() { external instances-list "$orb_id"; }
describe_instance() { external instance-describe "$1"; }
resource_names() { external resource-names "$@"; }
instance_absent() {
  local names
  names=$(resource_names instances "$1") || return 2
  [[ -z "$names" ]]
}
data_disk_exists() {
  local description
  description=$(external disk-describe "$data_disk") || return 1
  printf '%s\n' "$description" | jq -e --arg name "$data_disk" '.name == $name' >/dev/null
}
token_refused() { printf '%s' "$1" | external runtime-refused "$base"; }
dump_failure() {
  orb_row 2>/dev/null | orb_summary >"$log_dir/orb.json" 2>/dev/null || true
  instances >"$log_dir/instances.txt" 2>/dev/null || true
  external disk-describe "$data_disk" 2>/dev/null |
    jq '{name,id,status,sizeGb}' >"$log_dir/data-disk.json" 2>/dev/null || true
  echo "first-failure evidence: $log_dir" >&2
}
project_pending=0
orb_pending=0
boot_disks=()
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
trap on_exit EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

wait_orb_state() {
  local wanted=$1 row state
  local -x PI_ORB_SMOKE_DEADLINE=$(( $(date +%s) + $2 ))
  while (( $(date +%s) < PI_ORB_SMOKE_DEADLINE )); do
    row=$(orb_row) || return 1
    state=$(jq -r .state <<<"$row")
    [[ "$state" == "$wanted" ]] && { orb_summary <<<"$row"; return; }
    [[ "$state" == failed && "$wanted" != failed ]] && {
      echo "orb failed while waiting for $wanted" >&2; return 1;
    }
    sleep 2
  done
  echo "timeout waiting for orb state $wanted" >&2
  return 1
}
wait_disposed() {
  local old_instance=$1 old_boot_disk=$2
  local -x PI_ORB_SMOKE_DEADLINE=$(( $(date +%s) + dispose_deadline_seconds ))
  local listed old_names old_disks
  while (( $(date +%s) < PI_ORB_SMOKE_DEADLINE )); do
    listed=$(instances) || return 2
    old_names=$(resource_names instances "$old_instance") || return 2
    old_disks=$(resource_names disks "$old_boot_disk") || return 2
    if [[ -z "$listed$old_names$old_disks" ]]; then
      return
    fi
    sleep 2
  done
  echo "timeout waiting for instance and boot-disk disposal" >&2
  return 1
}

replacement_preflight
replacement_create project "$project_id" /api/v1/projects "$(jq -nc --arg id "$project_id" --arg repo "$repo" \
  '{id:$id,name:("compute-replacement-smoke-" + ($id|.[0:8])),repositoryUrl:$repo}')"
replacement_create orb "$orb_id" "/api/v1/projects/$project_id/orbs" "$(jq -nc --arg id "$orb_id" '{id:$id}')"
wait_orb_state running "$boot_deadline_seconds" >"$log_dir/initial-running.json"
old_instance=$(instances)
[[ $(wc -w <<<"$old_instance") -eq 1 ]]
# A fresh orb boots as incarnation 0 under the incarnation-suffixed name.
[[ "$old_instance" == "${instance_prefix}0" ]]
data_disk_exists

# Record the compute identity that must be gone after disposal: the numeric
# instance ID, the auto-created boot disk, and the incarnation-0 runtime token.
old_description=$(describe_instance "$old_instance")
printf '%s\n' "$old_description" | instance_summary >"$log_dir/old-instance.json"
old_instance_id=$(printf '%s\n' "$old_description" | jq -r .id)
old_boot_disk=$(printf '%s\n' "$old_description" |
  jq -r '.disks[] | select(.boot == true) | .source | split("/") | last')
old_token=$(printf '%s\n' "$old_description" |
  jq -r '.metadata.items[] | select(.key == "pi-orb-config") | .value | fromjson | .PI_ORB_RUNTIME_TOKEN')
[[ -n "$old_instance_id" && "$old_instance_id" != null ]]
[[ -n "$old_boot_disk" && "$old_boot_disk" != "$data_disk" ]]
boot_disks+=("$old_boot_disk")
[[ -n "$old_token" && "$old_token" != null ]]

sentinel="compute-replacement-$orb_id"
marker=$(jq -nc --arg orbId "$orb_id" '{orbId: $orbId, incarnation: 0}')
# Arm the current incarnation (0 for a fresh smoke orb) and retain a workspace
# sentinel. The payloads travel base64-encoded: the base64 alphabet survives
# local expansion, ssh remote-command concatenation, and the remote single
# quotes untouched, so the decoded files hold the exact local bytes with no
# nested-quote escaping.
sentinel_b64=$(printf %s "$sentinel" | base64 | tr -d '\n')
marker_b64=$(printf %s "$marker" | base64 | tr -d '\n')
external ssh-replacement "$old_instance" \
  "sudo bash -c 'printf %s $sentinel_b64 | base64 -d > /workspace/replacement-sentinel; printf %s $marker_b64 | base64 -d > /workspace/.pi-orb-e2e-launch-failure.json'"
external ssh-replacement "$old_instance" \
  "sudo grep -Fx '$sentinel' /workspace/replacement-sentinel"

api POST "/api/v1/orbs/$orb_id/stop" >/dev/null
wait_orb_state stopped "$stop_deadline_seconds" >/dev/null
api POST "/api/v1/orbs/$orb_id/start" >/dev/null
wait_orb_state failed "$boot_deadline_seconds" >"$log_dir/injected-failure.json"

wait_disposed "$old_instance" "$old_boot_disk"
data_disk_exists
token_refused "$old_token"

# Negative observation: more than two 30-second terminal-backstop intervals
# with no replacement instance and no state change without explicit Start.
for (( i = 0; i < negative_window_seconds; i++ )); do
  observed_instances=$(instances)
  [[ -z "$observed_instances" ]]
  [[ $(orb_row | jq -r .state) == failed ]]
  sleep 1
done

api POST "/api/v1/orbs/$orb_id/start" >/dev/null
wait_orb_state running "$boot_deadline_seconds" >"$log_dir/replacement-running.json"
new_instance=$(instances)
[[ $(wc -w <<<"$new_instance") -eq 1 ]]
[[ "$new_instance" == "${instance_prefix}1" ]]
new_description=$(describe_instance "$new_instance")
printf '%s\n' "$new_description" | instance_summary >"$log_dir/new-instance.json"
new_instance_id=$(printf '%s\n' "$new_description" | jq -r .id)
new_boot_disk=$(printf '%s\n' "$new_description" |
  jq -r '.disks[] | select(.boot == true) | .source | split("/") | last')
new_data_disk=$(printf '%s\n' "$new_description" |
  jq -r '.disks[] | select(.boot == false) | .source | split("/") | last')
new_token=$(printf '%s\n' "$new_description" |
  jq -r '.metadata.items[] | select(.key == "pi-orb-config") | .value | fromjson | .PI_ORB_RUNTIME_TOKEN')
new_spec=$(printf '%s\n' "$new_description" |
  jq -r '.metadata.items[] | select(.key == "pi-orb-host-spec-fingerprint") | .value')
[[ -n "$new_instance_id" && "$new_instance_id" != "$old_instance_id" ]]
[[ -n "$new_boot_disk" && "$new_boot_disk" != "$old_boot_disk" ]]
boot_disks+=("$new_boot_disk")
[[ "$new_data_disk" == "$data_disk" ]]
[[ -n "$new_token" && "$new_token" != null && "$new_token" != "$old_token" ]]
[[ -n "$new_spec" && "$new_spec" != null ]]

external ssh-replacement "$new_instance" \
  "sudo grep -Fx '$sentinel' /workspace/replacement-sentinel"
observed_instances=$(instances)
[[ "$observed_instances" == "$new_instance" ]]
instance_absent "$old_instance"
[[ $(orb_row | jq -r .state) == running ]]

if [[ -n "${PI_ORB_SMOKE_STAGE2_DEPLOY_COMMAND:-}" ]]; then
  # The deployment command must advance PI_ORB_HOST_SPEC_GENERATION and alter
  # one effective fingerprint input. Its completion is the synchronization
  # point: running compute must still be the exact same GCE instance afterward.
  external stage2-deploy >/dev/null

  # Negative observation, the same shape as the Stage 1 window above: for more
  # than two 30-second terminal-backstop intervals the running orb keeps its
  # state, its exact instance identity, and incarnation 1. Compute is immutable,
  # so a deployed specification change must not touch a running orb at all —
  # neither by replacing it nor by mutating it in place.
  [[ $(describe_instance "$new_instance" | jq -r .id) == "$new_instance_id" ]]
  for (( i = 0; i < negative_window_seconds; i++ )); do
    [[ $(orb_row | jq -r .state) == running ]]
    observed_instances=$(instances)
    [[ "$observed_instances" == "$new_instance" ]]
    sleep 1
  done
  # The numeric ID at both ends of the window rules out a same-named instance
  # having been recreated inside it.
  [[ $(describe_instance "$new_instance" | jq -r .id) == "$new_instance_id" ]]

  api POST "/api/v1/orbs/$orb_id/stop" >/dev/null
  wait_orb_state stopped "$stop_deadline_seconds" >/dev/null
  api POST "/api/v1/orbs/$orb_id/start" >/dev/null
  wait_orb_state running "$boot_deadline_seconds" >"$log_dir/spec-replacement-running.json"
  stage2_instance=$(instances)
  [[ "$stage2_instance" == "${instance_prefix}2" ]]
  stage2_description=$(describe_instance "$stage2_instance")
  printf '%s\n' "$stage2_description" | instance_summary >"$log_dir/stage2-instance.json"
  stage2_id=$(printf '%s\n' "$stage2_description" | jq -r .id)
  stage2_spec=$(printf '%s\n' "$stage2_description" |
    jq -r '.metadata.items[] | select(.key == "pi-orb-host-spec-fingerprint") | .value')
  stage2_data_disk=$(printf '%s\n' "$stage2_description" |
    jq -r '.disks[] | select(.boot == false) | .source | split("/") | last')
  stage2_boot_disk=$(printf '%s\n' "$stage2_description" |
    jq -r '.disks[] | select(.boot == true) | .source | split("/") | last')
  # Replacement, not repair: a new instance ID, a new disposable boot disk, and
  # a new specification stamp around the one retained workspace disk. No
  # in-place repair path exists, so the identity change is what this leg
  # proves; there is no repair event to observe.
  [[ "$stage2_id" != "$new_instance_id" ]]
  [[ "$stage2_spec" != "$new_spec" ]]
  [[ -n "$stage2_boot_disk" && "$stage2_boot_disk" != "$new_boot_disk" ]]
  boot_disks+=("$stage2_boot_disk")
  [[ "$stage2_data_disk" == "$data_disk" ]]
  instance_absent "$new_instance"
  external ssh-replacement "$stage2_instance" \
    "sudo grep -Fx '$sentinel' /workspace/replacement-sentinel"
fi

echo "compute replacement assertions passed; verifying cleanup" >&2
