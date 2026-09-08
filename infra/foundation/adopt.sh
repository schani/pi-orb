#!/bin/bash
# Split state ownership without applying or changing any GCP resource.
set -euo pipefail
umask 077

PROJECT=${PROJECT:-playground-dev-6ae7}
REGION=${REGION:-us-central1}
ZONE=${ZONE:-us-central1-a}
STATE_BUCKET=${STATE_BUCKET:-pi-orb-tfstate-$PROJECT}
execute=false
if [ "${1:-}" = --execute ]; then execute=true; elif [ "$#" -ne 0 ]; then echo 'usage: adopt.sh [--execute]' >&2; exit 2; fi
for command in gcloud jq node; do command -v "$command" >/dev/null || { echo "missing $command" >&2; exit 1; }; done
PROJECT_NUMBER=${PROJECT_NUMBER:-$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')}
case "$PROJECT_NUMBER" in ''|*[!0-9]*) echo 'could not resolve numeric project number' >&2; exit 1 ;; esac

root=$(cd "$(dirname "$0")/.." && pwd)
work=$(mktemp -d "${TMPDIR:-/tmp}/pi-orb-foundation-adopt.XXXXXX")
chmod 700 "$work"
app_object="gs://$STATE_BUCKET/static-plane/default.tfstate"
foundation_object="gs://$STATE_BUCKET/foundation/default.tfstate"
app_generation=$(gcloud storage objects describe "$app_object" --format='value(generation)')
case "$app_generation" in ''|*[!0-9]*) echo 'invalid application state generation' >&2; exit 1 ;; esac
gcloud storage cp "$app_object#$app_generation" "$work/application-before.tfstate" --quiet
foundation_error="$work/foundation-describe.error"
if foundation_generation=$(gcloud storage objects describe "$foundation_object" --format='value(generation)' 2>"$foundation_error"); then
  case "$foundation_generation" in ''|*[!0-9]*) echo 'invalid foundation state generation' >&2; exit 1 ;; esac
  gcloud storage cp "$foundation_object#$foundation_generation" "$work/foundation-before.tfstate" --quiet
  foundation_argument="$work/foundation-before.tfstate"
elif grep -qi '404\|not found\|does not exist' "$foundation_error"; then
  foundation_generation=0
  foundation_argument=-
else
  cat "$foundation_error" >&2
  exit 1
fi
jq -n --arg project "$PROJECT" --arg projectNumber "$PROJECT_NUMBER" --arg region "$REGION" --arg zone "$ZONE" --arg stateBucket "$STATE_BUCKET" '{project:$project,projectNumber:$projectNumber,region:$region,zone:$zone,stateBucket:$stateBucket}' >"$work/scope.json"
node "$root/foundation/state_split.mjs" "$work/application-before.tfstate" "$foundation_argument" "$work/scope.json" >"$work/split.json"
jq -r '.moved[]' "$work/split.json"
echo "state backups and projection: $work" >&2
if [ "$execute" != true ]; then echo 'dry run; pass --execute to push this exact projection under the release lock' >&2; exit 0; fi

lock="gs://$STATE_BUCKET/static-plane/release.lock"
jq -n --arg operation foundation-adoption --arg host "$(hostname)" --arg pid "$$" '{operation:$operation,host:$host,pid:$pid}' >"$work/lock.json"
gcloud storage cp "$work/lock.json" "$lock" --if-generation-match=0 --quiet >/dev/null || { echo "release lock held: $lock" >&2; exit 1; }
lock_generation=$(gcloud storage objects describe "$lock" --format='value(generation)')
case "$lock_generation" in ''|*[!0-9]*) echo 'invalid release lock generation' >&2; exit 1 ;; esac
cleanup() { gcloud storage rm "$lock" --if-generation-match="$lock_generation" --quiet >/dev/null 2>&1 || echo "warning: failed to release $lock" >&2; }
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

# Re-read under the lock. Any change invalidates the reviewed projection.
locked_app_generation=$(gcloud storage objects describe "$app_object" --format='value(generation)')
[ "$locked_app_generation" = "$app_generation" ] || { echo 'application state changed before lock' >&2; exit 1; }
gcloud storage cp "$app_object#$locked_app_generation" "$work/application-locked.tfstate" --quiet
cmp "$work/application-before.tfstate" "$work/application-locked.tfstate" || { echo 'application state changed before lock' >&2; exit 1; }
locked_foundation_error="$work/foundation-locked.error"
if locked_foundation_generation=$(gcloud storage objects describe "$foundation_object" --format='value(generation)' 2>"$locked_foundation_error"); then
  [ "$locked_foundation_generation" = "$foundation_generation" ] || { echo 'foundation state changed before lock' >&2; exit 1; }
  gcloud storage cp "$foundation_object#$locked_foundation_generation" "$work/foundation-locked.tfstate" --quiet
  [ "$foundation_argument" != - ] && cmp "$work/foundation-before.tfstate" "$work/foundation-locked.tfstate" || { echo 'foundation state changed before lock' >&2; exit 1; }
elif grep -qi '404\|not found\|does not exist' "$locked_foundation_error"; then
  [ "$foundation_argument" = - ] || { echo 'foundation state disappeared before lock' >&2; exit 1; }
else
  cat "$locked_foundation_error" >&2
  exit 1
fi
jq '.foundation' "$work/split.json" >"$work/foundation-after.tfstate"
jq '.application' "$work/split.json" >"$work/application-after.tfstate"
chmod 600 "$work"/*.tfstate

# Foundation first makes interruption leave duplicate ownership, which a rerun
# recognizes by exact resource identity and repairs by removing the app copy.
gcloud storage cp "$work/foundation-after.tfstate" "$foundation_object" --if-generation-match="$foundation_generation" --quiet
gcloud storage cp "$work/application-after.tfstate" "$app_object" --if-generation-match="$app_generation" --quiet
echo 'state split pushed; no cloud resource was applied' >&2
