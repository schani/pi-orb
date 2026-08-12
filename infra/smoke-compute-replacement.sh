#!/usr/bin/env bash
set -euo pipefail

# Disposable live-GCE acceptance smoke for docs/compute-replacement.md Stage 1.
# Required environment:
#   PI_ORB_BASE_URL, PI_ORB_GCP_PROJECT, PI_ORB_GCE_ZONE
# Optional:
#   PI_ORB_SMOKE_REPOSITORY_URL, PI_ORB_SMOKE_PROJECT_ID, PI_ORB_SMOKE_ORB_ID
#
# This script intentionally uses product lifecycle APIs plus a workspace marker;
# there is no production failpoint. The runtime E2E marker is accepted only when
# PI_ORB_E2E_LAUNCH_FAILURE_MARKER is explicitly configured on the release.

for command in curl jq gcloud; do
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
trap 'status=$?; (( status == 0 )) || dump_failure; cleanup; exit $status' EXIT

wait_orb_state() {
  local wanted=$1 deadline=$((SECONDS + ${2:-900})) row state
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
wait_no_compute() {
  local deadline=$((SECONDS + 300))
  while (( SECONDS < deadline )); do
    [[ -z "$(instances)" ]] && return
    sleep 2
  done
  echo "timeout waiting for compute absence" >&2
  return 1
}

api POST /api/v1/projects "$(jq -nc --arg id "$project_id" --arg repo "$repo" \
  '{id:$id,name:("compute-replacement-smoke-" + ($id|.[0:8])),repositoryUrl:$repo}')" >/dev/null
api POST "/api/v1/projects/$project_id/orbs" "$(jq -nc --arg id "$orb_id" '{id:$id}')" >/dev/null
wait_orb_state running 900 >"$log_dir/initial-running.json"
old_instance=$(instances)
[[ $(wc -w <<<"$old_instance") -eq 1 ]]
gcloud compute disks describe "$data_disk" --project "$PI_ORB_GCP_PROJECT" \
  --zone "$PI_ORB_GCE_ZONE" --format='value(name)' | grep -Fx "$data_disk" >/dev/null

sentinel="compute-replacement-$orb_id"
# Arm the current incarnation (0 for a fresh smoke orb) and retain a workspace sentinel.
gcloud compute ssh "$old_instance" --project "$PI_ORB_GCP_PROJECT" --zone "$PI_ORB_GCE_ZONE" -- \
  "sudo bash -c 'printf %s \\\"$sentinel\\\" > /mnt/disks/orb-data/replacement-sentinel; printf %s \\\"{\\\"orbId\\\":\\\"$orb_id\\\",\\\"incarnation\\\":0}\\\" > /mnt/disks/orb-data/.pi-orb-e2e-launch-failure.json'"
api POST "/api/v1/orbs/$orb_id/stop" >/dev/null
wait_orb_state stopped 300 >/dev/null
api POST "/api/v1/orbs/$orb_id/start" >/dev/null
wait_orb_state failed 900 >"$log_dir/injected-failure.json"
wait_no_compute

# Negative observation: more than two 30-second terminal-backstop intervals.
for _ in $(seq 1 65); do
  [[ -z "$(instances)" ]]
  [[ $(orb_row | jq -r .state) == failed ]]
  sleep 1
done

api POST "/api/v1/orbs/$orb_id/start" >/dev/null
wait_orb_state running 900 >"$log_dir/replacement-running.json"
new_instance=$(instances)
[[ $(wc -w <<<"$new_instance") -eq 1 ]]
[[ "$new_instance" != "$old_instance" ]]
gcloud compute ssh "$new_instance" --project "$PI_ORB_GCP_PROJECT" --zone "$PI_ORB_GCE_ZONE" -- \
  "sudo grep -Fx '$sentinel' /mnt/disks/orb-data/replacement-sentinel"
[[ $(orb_row | jq -r .state) == running ]]

echo "compute replacement smoke passed: $old_instance -> $new_instance; disk=$data_disk"
