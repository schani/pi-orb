#!/bin/bash
# Authoritative release composition, shared by local invocation and GitHub.
set -euo pipefail
umask 077
ROOT=$(cd "$(dirname "$0")/.." && pwd)
INFRA="$ROOT/infra"
source "$INFRA/release-child.sh"
PROJECT=${PROJECT:-playground-dev-6ae7}
REGION=${REGION:-us-central1}
STATE_BUCKET="pi-orb-tfstate-$PROJECT"
REMOTE_LOCK_URL="gs://$STATE_BUCKET/static-plane/release.lock"
LOCAL_LOCK_DIR="${TMPDIR:-/tmp}/pi-orb-release-${PROJECT}.lock"
AUTO_APPROVE=false
VALIDATE=""
WORK_DIR=""
RECORD=""
LOCAL_LOCK_HELD=false
REMOTE_LOCK_HELD=false
REMOTE_LOCK_GENERATION=""
KEEP_REMOTE_LOCK=false
APPLY_ATTEMPTED=false
IAP_REPAIRED=false

usage() {
  echo 'Usage: ./infra/release.sh [--yes] [--validate RELEASE_ID|latest]'
  echo 'Deploy clean, freshly fetched main, or explicitly validate a recorded deployment without rebuilding/reapplying.'
}
while [ "$#" -gt 0 ]; do
  case "$1" in
    --yes) AUTO_APPROVE=true ;;
    --validate) [ "$#" -ge 2 ] || { usage >&2; exit 2; }; VALIDATE=$2; shift ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; exit 2 ;;
  esac
  shift
done

state() { python3 -m infra.release_state "$1" "$RECORD" "${@:2}"; }
stage() {
  echo "release: $1"
  state stage "$1"
  state publish
}
repair_iap_after_attempt() {
  if [ "$APPLY_ATTEMPTED" = true ] && [ "$IAP_REPAIRED" != true ]; then
    if "$INFRA/deploy.sh" --iap-only; then IAP_REPAIRED=true; else
      echo 'release: IAP repair failed; inspect the browser service before proceeding' >&2
      return 1
    fi
  fi
}
cleanup() {
  local status=$?
  trap - EXIT HUP INT TERM
  release_stop_child
  repair_iap_after_attempt || status=1
  if [ -n "$RECORD" ] && [ -f "$RECORD" ]; then
    state finish "$status" || status=1
    state publish || status=1
    echo "release result: $RECORD"
    echo "durable record: gs://$STATE_BUCKET/static-plane/releases/$release_id.json"
  fi
  if [ "$REMOTE_LOCK_HELD" = true ]; then
    if [ "$KEEP_REMOTE_LOCK" = true ]; then
      echo "release: lock retained: migration execution may still be running; inspect the recorded job before unlocking $REMOTE_LOCK_URL" >&2
      status=1
    elif [ -z "$REMOTE_LOCK_GENERATION" ] || ! gcloud storage rm "$REMOTE_LOCK_URL" --if-generation-match="$REMOTE_LOCK_GENERATION" --quiet >/dev/null; then
      echo "release: lock cleanup failed: $REMOTE_LOCK_URL; verify ownership before removing it" >&2
      status=1
    fi
  fi
  [ -z "$WORK_DIR" ] || rm -rf "$WORK_DIR"
  if [ "$LOCAL_LOCK_HELD" = true ]; then rm -rf "$LOCAL_LOCK_DIR"; fi
  exit "$status"
}
on_signal() {
  trap '' HUP INT TERM
  release_stop_child
  exit "$1"
}
trap cleanup EXIT
trap 'on_signal 129' HUP
trap 'on_signal 130' INT
trap 'on_signal 143' TERM

cd "$ROOT"
for tool in curl gcloud git jq node npm python3 tofu uuidgen; do
  command -v "$tool" >/dev/null || { echo "release preflight failed: missing required command '$tool'" >&2; exit 1; }
done
if [ -z "$VALIDATE" ]; then
  command -v docker >/dev/null || { echo 'release preflight failed: missing docker' >&2; exit 1; }
  docker info >/dev/null
fi
for name in TF_LOG TF_LOG_CORE TF_LOG_PROVIDER; do
  [ -z "${!name:-}" ] || { echo "release refused: $name can disclose credentials" >&2; exit 1; }
done
export CLOUDSDK_CORE_LOG_HTTP=false CLOUDSDK_CORE_VERBOSITY=warning
if [ -n "$(git status --porcelain)" ]; then echo 'release preflight failed: working tree is not clean' >&2; exit 1; fi
if [ "$(git branch --show-current)" != main ]; then echo 'release preflight failed: current branch is not main' >&2; exit 1; fi
git fetch --quiet origin main
head_commit=$(git rev-parse HEAD)
if [ "$head_commit" != "$(git rev-parse origin/main)" ]; then echo 'release preflight failed: HEAD is not latest origin/main' >&2; exit 1; fi
python3 infra/artifact_guard.py
gcloud auth print-access-token >/dev/null
if ! mkdir "$LOCAL_LOCK_DIR" 2>/dev/null; then echo 'release preflight failed: another local release may be active' >&2; exit 1; fi
LOCAL_LOCK_HELD=true
printf '%s\n' "$$" > "$LOCAL_LOCK_DIR/pid"
WORK_DIR=$(mktemp -d "${TMPDIR:-/tmp}/pi-orb-release.XXXXXX")
chmod 700 "$WORK_DIR"
release_id="r-$(date +%s)-$(uuidgen | tr '[:upper:]' '[:lower:]')"
workflow_url=""
if [ -n "${GITHUB_RUN_ID:-}" ]; then workflow_url="https://github.com/schani/pi-orb/actions/runs/$GITHUB_RUN_ID"; fi
jq -n --arg commit "$head_commit" --arg releaseId "$release_id" --arg workflowUrl "$workflow_url" --arg host "$(hostname)" --arg pid "$$" --arg startedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  '{commit:$commit,releaseId:$releaseId,workflowUrl:$workflowUrl,host:$host,pid:$pid,startedAt:$startedAt}' > "$WORK_DIR/lock.json"
if ! gcloud storage cp "$WORK_DIR/lock.json" "$REMOTE_LOCK_URL" --if-generation-match=0 --quiet >/dev/null; then
  echo "release preflight failed: another deployment holds $REMOTE_LOCK_URL" >&2; exit 1
fi
REMOTE_LOCK_HELD=true
REMOTE_LOCK_GENERATION=$(gcloud storage objects describe "$REMOTE_LOCK_URL" --format='value(generation)')
[[ "$REMOTE_LOCK_GENERATION" =~ ^[0-9]+$ ]] || { echo 'release: acquired lock generation is unknown' >&2; exit 1; }
export PROJECT REGION

tofu -chdir="$INFRA/foundation" init -input=false -lockfile=readonly -backend-config="bucket=$STATE_BUCKET"
foundation=$(tofu -chdir="$INFRA/foundation" output -json)
if ! jq -e --arg project "$PROJECT" --arg region "$REGION" '
  .foundation_schema_version.value == 1 and .project.value == $project and .region.value == $region and
  ([.zone.value,.image_builder_service_account_email.value,.image_build_subnetwork.value,
    .pi_orb_network.value,.orb_subnetwork_resource.value,.run_egress_subnetwork.value,.run_egress_cidr.value,
    .control_plane_service_account_email.value,.trusted_pi_orb_project_id.value,.pi_orb_workload_identity_provider.value,
    .deployer_service_account_email.value] | all(type == "string" and length > 0))
' <<<"$foundation" >/dev/null; then
  echo 'release refused: apply/adopt the matching foundation before releasing' >&2; exit 1
fi
ZONE=$(jq -r '.zone.value' <<<"$foundation")
IMAGE_BUILDER_SA=$(jq -r '.image_builder_service_account_email.value' <<<"$foundation")
IMAGE_BUILD_SUBNET=$(jq -r '.image_build_subnetwork.value' <<<"$foundation")
export ZONE IMAGE_BUILDER_SA IMAGE_BUILD_SUBNET
RESULT_DIR=${PI_ORB_RELEASE_RESULT_DIR:-$ROOT/.context/releases/$release_id}
mkdir -p "$RESULT_DIR"
chmod 700 "$RESULT_DIR"
RECORD="$RESULT_DIR/release.json"
state init "$release_id" "$head_commit" "$PROJECT" "$REGION" "$ZONE" "$workflow_url"
if [ -n "$VALIDATE" ]; then state recover "$VALIDATE"; else state previous; fi
state publish
tofu -chdir="$INFRA" init -input=false -lockfile=readonly -backend-config="bucket=$STATE_BUCKET" -backend-config=prefix=static-plane
export PI_ORB_OPS_URL=$(tofu -chdir="$INFRA" output -raw ops_url)
export PI_ORB_ISSUER_URL=$(tofu -chdir="$INFRA" output -raw issuer_url)
"$INFRA/api.sh" /api/v1/system | jq -e '.hostProvider == "gce"' >/dev/null
# This read proves both the beta command dependency and scoped policy access
# before any build, migration or apply—not after changing serving services.
gcloud beta iap web get-iam-policy --project="$PROJECT" --resource-type=cloud-run \
  --service=pi-orb --region="$REGION" --format=json > "$WORK_DIR/iap-preflight.json"
jq -e 'type == "object" and ((.bindings // []) | type == "array")' "$WORK_DIR/iap-preflight.json" >/dev/null

plan_and_guard() {
  local vars=$1 plan=$2
  tofu -chdir="$INFRA" plan -input=false -no-color -out="$plan" -var-file="$vars" \
    -var="project=$PROJECT" -var="region=$REGION" -var="zone=$ZONE" -var="foundation_state_bucket=$STATE_BUCKET"
  chmod 600 "$plan"
  tofu -chdir="$INFRA" show -json "$plan" > "$WORK_DIR/plan.json"
  if ! jq -e -f "$INFRA/check-database-plan.jq" "$WORK_DIR/plan.json" >/dev/null; then
    echo 'release refused: saved plan does not preserve the database and its credentials' >&2; return 1
  fi
}

if [ -z "$VALIDATE" ]; then
  python3 -m infra.release_preflight "$PROJECT"
  # Real scoped permission reads, including bucket IAM, precede expensive builds.
  state preflight-vars "$WORK_DIR/current.tfvars"
  plan_and_guard "$WORK_DIR/current.tfvars" "$WORK_DIR/preflight.tfplan"
  python3 -m infra.release_retire inventory "$RECORD"
  stage checks
  release_run_child env -u PI_ORB_RELEASE_RESULT_DIR -u PI_ORB_RELEASE_RECORD npm ci
  release_run_child env -u PI_ORB_RELEASE_RESULT_DIR -u PI_ORB_RELEASE_RECORD npm run typecheck
  release_run_child env -u PI_ORB_RELEASE_RESULT_DIR -u PI_ORB_RELEASE_RECORD npm run lint
  release_run_child env -u PI_ORB_RELEASE_RESULT_DIR -u PI_ORB_RELEASE_RECORD npm test
  release_run_child env -u PI_ORB_RELEASE_RESULT_DIR -u PI_ORB_RELEASE_RECORD docker build -f apps/orb-runtime/Dockerfile -t pi-orb-runtime:dev .
  release_run_child env -u PI_ORB_RELEASE_RESULT_DIR -u PI_ORB_RELEASE_RECORD npm run test:e2e
  stage build
  release_run_child "$INFRA/build-push.sh" > "$WORK_DIR/release.tfvars"
  state vars "$WORK_DIR/release.tfvars"
  state generation "$WORK_DIR/release.tfvars"
  stage plan
  plan_and_guard "$WORK_DIR/release.tfvars" "$WORK_DIR/release.tfplan"
  if [ "$AUTO_APPROVE" != true ]; then
    [ -t 0 ] || { echo 'release: pass --yes for noninteractive deployment' >&2; exit 1; }
    printf 'Deploy %s to %s? Type "deploy": ' "$head_commit" "$PROJECT"
    read -r confirmation
    [ "$confirmation" = deploy ] || exit 1
  fi
  stage schema
  migration_job="pi-orb-migrate-${release_id:0:47}"
  state migration-job "$migration_job"
  state publish
  database_version=$(gcloud secrets versions describe latest --secret=pi-orb-database-url --project="$PROJECT" --format='value(name)')
  database_version=${database_version##*/}
  [[ "$database_version" =~ ^[0-9]+$ ]] || { echo 'release: invalid database secret version' >&2; exit 1; }
  # A cancelled execute request can outlive this shell. Keep the global lock on
  # any uncertain schema execution, and retain its job/record for diagnosis.
  KEEP_REMOTE_LOCK=true
  release_run_child gcloud run jobs create "$migration_job" --project="$PROJECT" --region="$REGION" \
    --image="$(jq -r '.artifacts.control_plane_image' "$RECORD")" \
    --service-account="$(jq -r '.control_plane_service_account_email.value' <<<"$foundation")" \
    --network="$(jq -r '.pi_orb_network.value' <<<"$foundation")" \
    --subnet="$(jq -r '.run_egress_subnetwork.value' <<<"$foundation")" --vpc-egress=private-ranges-only \
    --set-secrets="DATABASE_URL=pi-orb-database-url:$database_version" \
    --command=node --args=apps/control-plane/src/migrate.ts --tasks=1 --parallelism=1 \
    --max-retries=0 --task-timeout=300s --cpu=1 --memory=512Mi --execute-now --wait --quiet
  KEEP_REMOTE_LOCK=false
  gcloud run jobs delete "$migration_job" --project="$PROJECT" --region="$REGION" --quiet
  state check-previous
  stage apply
  APPLY_ATTEMPTED=true
  release_run_child tofu -chdir="$INFRA" apply -input=false "$WORK_DIR/release.tfplan"
fi

stage repair
"$INFRA/deploy.sh"
IAP_REPAIRED=true
if [ -z "$VALIDATE" ]; then state snapshot; else state check; fi

stage retire
release_run_child python3 -m infra.release_retire wait "$RECORD"
stage activate
state activate
stage lifecycle
export PI_ORB_RELEASE_RECORD="$RECORD"
release_run_child "$INFRA/smoke.sh"
stage identity
# Reuse this repository's already-admitted project to exercise real federation,
# but own/delete only the two newly generated orbs, never the shared project.
export PI_ORB_GCP_PROJECT="$PROJECT" PI_ORB_GCE_ZONE="$ZONE"
export PI_ORB_SMOKE_PROJECT_ID=$(jq -r '.trusted_pi_orb_project_id.value' <<<"$foundation")
export PI_ORB_SMOKE_WIF_AUDIENCE="urn:pi-orb:gcp:$PROJECT"
export PI_ORB_SMOKE_WIF_STS_AUDIENCE="//iam.googleapis.com/$(jq -r '.pi_orb_workload_identity_provider.value' <<<"$foundation")"
export PI_ORB_SMOKE_WIF_TEST_SA=$(jq -r '.deployer_service_account_email.value' <<<"$foundation")
release_run_child "$INFRA/smoke-workload-identity.sh"
state check
stage complete
echo "RELEASE VALIDATED: $(jq -r '.commit' "$RECORD") (generation $(jq -r '.artifacts.deploy_generation' "$RECORD"))"
