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
