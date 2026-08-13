#!/usr/bin/env bash
set -euo pipefail

# Disposable live-GCE acceptance smoke for docs/compute-replacement.md.
# Required environment:
#   PI_ORB_BASE_URL, PI_ORB_GCP_PROJECT, PI_ORB_GCE_ZONE
# Optional:
#   PI_ORB_SMOKE_REPOSITORY_URL, PI_ORB_SMOKE_PROJECT_ID, PI_ORB_SMOKE_ORB_ID
#   PI_ORB_SMOKE_STAGE2_DEPLOY_COMMAND — deploys a higher generation with a
#     different effective host spec; when set, the Stage 2 leg is mandatory.
#
# This script intentionally uses product lifecycle APIs plus a workspace marker;
# there is no production failpoint. The runtime E2E marker is accepted only when
# PI_ORB_E2E_LAUNCH_FAILURE_MARKER is explicitly configured on the release.

# Outer budget: every bounded wait below derives from one provision + COS boot
# + runtime-ready pass (the slowest provider operation this smoke performs).
# Three lifecycle waits use it in full; stop and disposal are pure provider
# operations and get a fraction; the 65-second negative-observation window is
# the only deliberate elapsed-time assertion in this script.
boot_deadline_seconds=900             # provision + boot + runtime ready
stop_deadline_seconds=$((boot_deadline_seconds / 3))    # graceful stop drain
dispose_deadline_seconds=$((boot_deadline_seconds / 3)) # instance + boot-disk disposal
negative_window_seconds=65            # more than two 30s terminal-backstop intervals

for command in curl jq gcloud base64 python3; do
  command -v "$command" >/dev/null || { echo "missing required command: $command" >&2; exit 2; }
done
: "${PI_ORB_BASE_URL:?required}"
: "${PI_ORB_GCP_PROJECT:?required}"
: "${PI_ORB_GCE_ZONE:?required}"

repo=${PI_ORB_SMOKE_REPOSITORY_URL:-https://github.com/schani/pi-orb}
project_id=${PI_ORB_SMOKE_PROJECT_ID:-$(python3 -c 'import uuid; print(uuid.uuid4())')}
orb_id=${PI_ORB_SMOKE_ORB_ID:-$(python3 -c 'import uuid; print(uuid.uuid4())')}
base=${PI_ORB_BASE_URL%/}
instance_prefix="pi-orb-${orb_id}-i"
data_disk="pi-orb-data-${orb_id}"
log_dir=${PI_ORB_SMOKE_LOG_DIR:-test-failures/compute-replacement-live-$(date +%s)}
mkdir -p "$log_dir"

api() {
  local method=$1 path=$2 body=${3-}
  if [[ -n "$body" ]]; then
    curl -fsS -X "$method" -H 'content-type: application/json' --data "$body" "$base$path"
  else
    curl -fsS -X "$method" "$base$path"
  fi
}
orb_row() { api GET "/api/v1/orbs/$orb_id"; }
instances() {
  gcloud compute instances list --project "$PI_ORB_GCP_PROJECT" \
    --filter="zone:($PI_ORB_GCE_ZONE) AND labels.pi-orb-orb-id=$orb_id" \
    --format='value(name)'
}
describe_instance() {
  gcloud compute instances describe "$1" --project "$PI_ORB_GCP_PROJECT" \
    --zone "$PI_ORB_GCE_ZONE" --format=json
}
instance_absent() {
  ! gcloud compute instances describe "$1" --project "$PI_ORB_GCP_PROJECT" \
    --zone "$PI_ORB_GCE_ZONE" --format='value(name)' >/dev/null 2>&1
}
disk_absent() {
  ! gcloud compute disks describe "$1" --project "$PI_ORB_GCP_PROJECT" \
    --zone "$PI_ORB_GCE_ZONE" --format='value(name)' >/dev/null 2>&1
}
data_disk_exists() {
  gcloud compute disks describe "$data_disk" --project "$PI_ORB_GCP_PROJECT" \
    --zone "$PI_ORB_GCE_ZONE" --format='value(name)' | grep -Fx "$data_disk" >/dev/null
}
# HTTP status of a broker-authenticated runtime route (runtime-routes.ts) for
# one bearer token. Never -f: the 401 is the assertion, not a curl failure.
token_probe_status() {
  curl -sS -o /dev/null -w '%{http_code}' -X POST \
    -H "authorization: Bearer $1" -H 'content-type: application/json' \
    --data '{"reason":"startup"}' "$base/runtime/v1/tokens/model"
}
dump_failure() {
  orb_row >"$log_dir/orb.json" 2>&1 || true
  instances >"$log_dir/instances.txt" 2>&1 || true
  gcloud compute disks describe "$data_disk" --project "$PI_ORB_GCP_PROJECT" \
    --zone "$PI_ORB_GCE_ZONE" --format=json >"$log_dir/data-disk.json" 2>&1 || true
  echo "first-failure evidence: $log_dir" >&2
}
cleanup() {
  api DELETE "/api/v1/projects/$project_id" >"$log_dir/cleanup.json" 2>&1 || true
}
on_exit() {
  local status=$?
  (( status == 0 )) || dump_failure
  cleanup
  exit "$status"
}
trap on_exit EXIT

wait_orb_state() {
  local wanted=$1 deadline=$((SECONDS + $2)) row state
  while (( SECONDS < deadline )); do
    row=$(orb_row) || { sleep 2; continue; }
    state=$(jq -r .state <<<"$row")
    [[ "$state" == "$wanted" ]] && { printf '%s\n' "$row"; return; }
    [[ "$state" == failed && "$wanted" != failed ]] && {
      echo "orb failed while waiting for $wanted: $(jq -r .lastError <<<"$row")" >&2; return 1;
    }
    sleep 2
  done
  echo "timeout waiting for orb state $wanted" >&2
  return 1
}
wait_disposed() {
  local old_instance=$1 old_boot_disk=$2 deadline=$((SECONDS + dispose_deadline_seconds))
  while (( SECONDS < deadline )); do
    if [[ -z "$(instances)" ]] && instance_absent "$old_instance" \
      && disk_absent "$old_boot_disk"; then
      return
    fi
    sleep 2
  done
  echo "timeout waiting for instance and boot-disk disposal" >&2
  return 1
}

api POST /api/v1/projects "$(jq -nc --arg id "$project_id" --arg repo "$repo" \
  '{id:$id,name:("compute-replacement-smoke-" + ($id|.[0:8])),repositoryUrl:$repo}')" >/dev/null
api POST "/api/v1/projects/$project_id/orbs" "$(jq -nc --arg id "$orb_id" '{id:$id}')" >/dev/null
wait_orb_state running "$boot_deadline_seconds" >"$log_dir/initial-running.json"
old_instance=$(instances)
[[ $(wc -w <<<"$old_instance") -eq 1 ]]
# A fresh orb boots as incarnation 0 under the incarnation-suffixed name.
[[ "$old_instance" == "${instance_prefix}0" ]]
data_disk_exists

# Record the compute identity that must be gone after disposal: the numeric
# instance ID, the auto-created boot disk, and the incarnation-0 runtime token.
old_description=$(describe_instance "$old_instance" | tee "$log_dir/old-instance.json")
old_instance_id=$(jq -r .id <<<"$old_description")
old_boot_disk=$(jq -r '.disks[] | select(.boot == true) | .source | split("/") | last' \
  <<<"$old_description")
old_token=$(jq -r '.metadata.items[] | select(.key == "pi-orb-runtime-token") | .value' \
  <<<"$old_description")
[[ -n "$old_instance_id" && "$old_instance_id" != null ]]
[[ -n "$old_boot_disk" && "$old_boot_disk" != "$data_disk" ]]
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
gcloud compute ssh "$old_instance" --project "$PI_ORB_GCP_PROJECT" --zone "$PI_ORB_GCE_ZONE" -- \
  "sudo bash -c 'printf %s $sentinel_b64 | base64 -d > /mnt/disks/orb-data/replacement-sentinel; printf %s $marker_b64 | base64 -d > /mnt/disks/orb-data/.pi-orb-e2e-launch-failure.json'"
gcloud compute ssh "$old_instance" --project "$PI_ORB_GCP_PROJECT" --zone "$PI_ORB_GCE_ZONE" -- \
  "sudo grep -Fx '$sentinel' /mnt/disks/orb-data/replacement-sentinel"

api POST "/api/v1/orbs/$orb_id/stop" >/dev/null
wait_orb_state stopped "$stop_deadline_seconds" >/dev/null
api POST "/api/v1/orbs/$orb_id/start" >/dev/null
wait_orb_state failed "$boot_deadline_seconds" >"$log_dir/injected-failure.json"

# Disposal: the suspect instance and its disposable boot disk are gone, the
# workspace disk survives, and the incarnation-0 token no longer authenticates.
wait_disposed "$old_instance" "$old_boot_disk"
data_disk_exists
[[ "$(token_probe_status "$old_token")" == 401 ]]

# Negative observation: more than two 30-second terminal-backstop intervals
# with no replacement instance and no state change without explicit Start.
for (( i = 0; i < negative_window_seconds; i++ )); do
  [[ -z "$(instances)" ]]
  [[ $(orb_row | jq -r .state) == failed ]]
  sleep 1
done

api POST "/api/v1/orbs/$orb_id/start" >/dev/null
wait_orb_state running "$boot_deadline_seconds" >"$log_dir/replacement-running.json"
new_instance=$(instances)
[[ $(wc -w <<<"$new_instance") -eq 1 ]]
[[ "$new_instance" == "${instance_prefix}1" ]]
new_description=$(describe_instance "$new_instance" | tee "$log_dir/new-instance.json")
new_instance_id=$(jq -r .id <<<"$new_description")
new_boot_disk=$(jq -r '.disks[] | select(.boot == true) | .source | split("/") | last' \
  <<<"$new_description")
new_data_disk=$(jq -r '.disks[] | select(.boot == false) | .source | split("/") | last' \
  <<<"$new_description")
new_token=$(jq -r '.metadata.items[] | select(.key == "pi-orb-runtime-token") | .value' \
  <<<"$new_description")
new_spec=$(jq -r '.metadata.items[] | select(.key == "pi-orb-host-spec-fingerprint") | .value' \
  <<<"$new_description")
[[ -n "$new_instance_id" && "$new_instance_id" != "$old_instance_id" ]]
[[ -n "$new_boot_disk" && "$new_boot_disk" != "$old_boot_disk" ]]
[[ "$new_data_disk" == "$data_disk" ]]
[[ -n "$new_token" && "$new_token" != null && "$new_token" != "$old_token" ]]
[[ -n "$new_spec" && "$new_spec" != null ]]

# The workspace survived replacement, exactly one compute identity remains,
# and the orb is still running through the replacement incarnation.
gcloud compute ssh "$new_instance" --project "$PI_ORB_GCP_PROJECT" --zone "$PI_ORB_GCE_ZONE" -- \
  "sudo grep -Fx '$sentinel' /mnt/disks/orb-data/replacement-sentinel"
[[ "$(instances)" == "$new_instance" ]]
instance_absent "$old_instance"
[[ $(orb_row | jq -r .state) == running ]]

if [[ -n "${PI_ORB_SMOKE_STAGE2_DEPLOY_COMMAND:-}" ]]; then
  # The deployment command must advance PI_ORB_HOST_SPEC_GENERATION and alter
  # one effective fingerprint input. Its completion is the synchronization
  # point: running compute must still be the exact same GCE instance afterward.
  bash -lc "$PI_ORB_SMOKE_STAGE2_DEPLOY_COMMAND"
  [[ $(orb_row | jq -r .state) == running ]]
  [[ "$(instances)" == "$new_instance" ]]
  [[ $(describe_instance "$new_instance" | jq -r .id) == "$new_instance_id" ]]

  api POST "/api/v1/orbs/$orb_id/stop" >/dev/null
  wait_orb_state stopped "$stop_deadline_seconds" >/dev/null
  api POST "/api/v1/orbs/$orb_id/start" >/dev/null
  wait_orb_state running "$boot_deadline_seconds" >"$log_dir/spec-replacement-running.json"
  stage2_instance=$(instances)
  [[ "$stage2_instance" == "${instance_prefix}2" ]]
  stage2_description=$(describe_instance "$stage2_instance" | tee "$log_dir/stage2-instance.json")
  stage2_id=$(jq -r .id <<<"$stage2_description")
  stage2_spec=$(jq -r '.metadata.items[] | select(.key == "pi-orb-host-spec-fingerprint") | .value' \
    <<<"$stage2_description")
  stage2_data_disk=$(jq -r '.disks[] | select(.boot == false) | .source | split("/") | last' \
    <<<"$stage2_description")
  [[ "$stage2_id" != "$new_instance_id" ]]
  [[ "$stage2_spec" != "$new_spec" ]]
  [[ "$stage2_data_disk" == "$data_disk" ]]
  instance_absent "$new_instance"
  gcloud compute ssh "$stage2_instance" --project "$PI_ORB_GCP_PROJECT" \
    --zone "$PI_ORB_GCE_ZONE" -- \
    "sudo grep -Fx '$sentinel' /mnt/disks/orb-data/replacement-sentinel"
fi

echo "compute replacement smoke passed: $old_instance ($old_instance_id) -> $new_instance ($new_instance_id); disk=$data_disk"
