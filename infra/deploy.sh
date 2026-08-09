#!/bin/bash
# Post-apply steps tofu does not manage: exact IAP policy on the browser
# service, plus drained-revision cleanup after a successful apply.
set -euo pipefail
umask 077
PROJECT=${PROJECT:-playground-dev-6ae7}
REGION=${REGION:-us-central1}
DOMAIN=${DOMAIN:-heyglide.com}
IAP_ONLY=false

case "${1:-}" in
  "") ;;
  --iap-only) IAP_ONLY=true ;;
  *) echo "usage: $0 [--iap-only]" >&2; exit 2 ;;
esac

for command in gcloud jq; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "deploy failed: missing required command '$command'" >&2
    exit 1
  fi
done

policy_dir=$(mktemp -d "${TMPDIR:-/tmp}/pi-orb-iap-policy.XXXXXX")
cleanup() { rm -rf "$policy_dir"; }
trap cleanup EXIT HUP INT TERM
current_policy="$policy_dir/current.json"
desired_policy="$policy_dir/desired.json"
verified_policy="$policy_dir/verified.json"
desired_member="domain:$DOMAIN"

gcloud run services update pi-orb --project "$PROJECT" --region "$REGION" --iap --quiet

gcloud beta iap web get-iam-policy \
  --project "$PROJECT" --resource-type=cloud-run --service=pi-orb --region="$REGION" \
  --format=json > "$current_policy"

# Preserve the policy etag and every unrelated role while replacing all
# accessor-role bindings with the one documented domain binding. The etag makes
# concurrent policy changes fail rather than get overwritten.
jq --arg member "$desired_member" '
  .bindings = (
    [.bindings[]? | select(.role != "roles/iap.httpsResourceAccessor")]
    + [{role: "roles/iap.httpsResourceAccessor", members: [$member]}]
    | sort_by(.role)
  )
' "$current_policy" > "$desired_policy"

gcloud beta iap web set-iam-policy "$desired_policy" \
  --project "$PROJECT" --resource-type=cloud-run --service=pi-orb --region="$REGION" \
  --quiet >/dev/null

gcloud beta iap web get-iam-policy \
  --project "$PROJECT" --resource-type=cloud-run --service=pi-orb --region="$REGION" \
  --format=json > "$verified_policy"

if ! jq -e --arg member "$desired_member" '
  [.bindings[]? | select(.role == "roles/iap.httpsResourceAccessor") | .members[]?]
  == [$member]
' "$verified_policy" >/dev/null; then
  echo "deploy failed: IAP accessor policy does not match the exact intended allowlist" >&2
  exit 1
fi
echo "IAP enabled on pi-orb; exact accessor allowlist is $desired_member"

if [ "$IAP_ONLY" = true ]; then
  exit 0
fi

# Delete drained-out revisions of the reconciler-running service. A draining
# old revision keeps reconciling with the previous startup-script generation
# for many minutes and fights the new revision over orb VMs
# (docs/postmortems/2026-08-06-rollover-repair-war-corrupt-image.md).
serving=$(gcloud run services describe pi-orb --project "$PROJECT" --region "$REGION" \
  --format="value(status.traffic[0].revisionName)")
for rev in $(gcloud run revisions list --service pi-orb --project "$PROJECT" --region "$REGION" \
  --format="value(name)"); do
  if [ "$rev" != "$serving" ]; then
    gcloud run revisions delete "$rev" --project "$PROJECT" --region "$REGION" --quiet
    echo "deleted drained revision $rev"
  fi
done
