#!/bin/bash
# Post-apply steps tofu does not manage: IAP on the browser service
# (provider support for IAP-on-Cloud-Run is still settling).
set -euo pipefail
PROJECT=${PROJECT:-playground-dev-6ae7}
REGION=${REGION:-us-central1}
DOMAIN=${DOMAIN:-heyglide.com}

gcloud run services update pi-orb --project "$PROJECT" --region "$REGION" --iap --quiet
gcloud beta iap web add-iam-policy-binding \
  --project "$PROJECT" --resource-type=cloud-run --service=pi-orb --region="$REGION" \
  --member="domain:$DOMAIN" --role=roles/iap.httpsResourceAccessor
echo "IAP enabled on pi-orb; access restricted to @$DOMAIN"

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
