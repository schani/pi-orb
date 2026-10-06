#!/bin/bash
# Verify application routing and delete drained revisions; Monitoring proves retirement.
set -euo pipefail
umask 077
PROJECT=${PROJECT:-playground-dev-6ae7}
REGION=${REGION:-us-central1}
policy_dir=$(mktemp -d "${TMPDIR:-/tmp}/pi-orb-deploy.XXXXXX")
trap 'rm -rf "$policy_dir"' EXIT
service_status="$policy_dir/service.json"
gcloud run services describe pi-orb-issuer --project "$PROJECT" --region "$REGION" \
  --format=json > "$service_status"
if ! serving=$(jq -er '
  [
    .status.traffic[]? |
    select(
      .tag == "files" and .latestRevision == true and .percent == 100 and
      (.revisionName | type) == "string" and .revisionName != ""
    )
  ] as $files |
  if ($files | length) == 1 and .status.latestReadyRevisionName == $files[0].revisionName
  then $files[0].revisionName
  else empty
  end
' "$service_status"); then
  echo "deploy failed: application service does not route the files tag to 100% of its latest ready revision" >&2
  exit 1
fi

# Delete drained-out revisions of the reconciler-running service. A draining
# old revision keeps reconciling with the previous host specification
# for many minutes and fights the new revision over orb VMs
# (docs/postmortems/2026-08-06-rollover-repair-war-corrupt-image.md).
for rev in $(gcloud run revisions list --service pi-orb-issuer --project "$PROJECT" --region "$REGION" \
  --format="value(name)"); do
  if [ "$rev" != "$serving" ]; then
    gcloud run revisions delete "$rev" --project "$PROJECT" --region "$REGION" --quiet
    echo "deleted drained revision $rev"
  fi
done
