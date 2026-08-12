#!/usr/bin/env bash
# One-time, idempotent bootstrap for keyless Amp-orb GCP access. Run this with
# an existing project administrator identity; ordinary orb releases use the
# resulting deployer and do not run this script.
set -euo pipefail

PROJECT=${PROJECT:-playground-dev-6ae7}
PROJECT_NUMBER=${PROJECT_NUMBER:-1077475695242}
POOL=amp-orbs
PROVIDER=amp-oidc
DEPLOYER=pi-orb-amp-deployer
DEPLOYER_EMAIL="$DEPLOYER@$PROJECT.iam.gserviceaccount.com"
AMP_PROJECT_ID=cad0f81a-f72a-40be-ba23-4238ce350328
AMP_USER_ID=user_01JYNTQK807VHERYA25EAND4SM
AUDIENCE="urn:amp:gcp:$PROJECT"

gcloud services enable iam.googleapis.com iamcredentials.googleapis.com sts.googleapis.com \
  --project="$PROJECT" --quiet

if ! gcloud iam workload-identity-pools describe "$POOL" \
  --project="$PROJECT" --location=global >/dev/null 2>&1; then
  gcloud iam workload-identity-pools create "$POOL" \
    --project="$PROJECT" --location=global --display-name='Amp orbs' \
    --description='Keyless access from approved Amp project orbs'
fi

if ! gcloud iam workload-identity-pools providers describe "$PROVIDER" \
  --project="$PROJECT" --location=global \
  --workload-identity-pool="$POOL" >/dev/null 2>&1; then
  gcloud iam workload-identity-pools providers create-oidc "$PROVIDER" \
    --project="$PROJECT" --location=global \
    --workload-identity-pool="$POOL" --display-name='Amp orb OIDC' \
    --issuer-uri='https://ampcode.com/api/workload-identity' \
    --allowed-audiences="$AUDIENCE" \
    --attribute-mapping='google.subject=assertion.thread_id,attribute.project_id=assertion.project_id,attribute.user_id=assertion.user_id' \
    --attribute-condition="assertion.project_id == '$AMP_PROJECT_ID' && assertion.user_id == '$AMP_USER_ID' && assertion.token_use == 'exchanged'"
fi

if ! gcloud iam service-accounts describe "$DEPLOYER_EMAIL" \
  --project="$PROJECT" >/dev/null 2>&1; then
  gcloud iam service-accounts create "$DEPLOYER" --project="$PROJECT" \
    --display-name='pi-orb Amp deployer' \
    --description='Short-lived impersonated identity for approved Amp project orbs'
fi

principal_set="principalSet://iam.googleapis.com/projects/$PROJECT_NUMBER/locations/global/workloadIdentityPools/$POOL/attribute.user_id/$AMP_USER_ID"
gcloud iam service-accounts add-iam-policy-binding "$DEPLOYER_EMAIL" \
  --project="$PROJECT" --member="$principal_set" \
  --role='roles/iam.workloadIdentityUser' --quiet >/dev/null

for role in \
  roles/artifactregistry.writer \
  roles/cloudsql.admin \
  roles/compute.networkAdmin \
  roles/compute.viewer \
  roles/iam.serviceAccountAdmin \
  roles/iam.serviceAccountUser \
  roles/iap.admin \
  roles/logging.viewer \
  roles/monitoring.viewer \
  roles/resourcemanager.projectIamAdmin \
  roles/run.admin \
  roles/secretmanager.admin \
  roles/servicenetworking.networksAdmin \
  roles/serviceusage.serviceUsageAdmin \
  roles/serviceusage.serviceUsageConsumer; do
  gcloud projects add-iam-policy-binding "$PROJECT" \
    --member="serviceAccount:$DEPLOYER_EMAIL" --role="$role" \
    --condition=None --quiet >/dev/null
done

for role in roles/storage.objectAdmin roles/storage.legacyBucketReader; do
  gcloud storage buckets add-iam-policy-binding "gs://pi-orb-tfstate-$PROJECT" \
    --member="serviceAccount:$DEPLOYER_EMAIL" --role="$role" --quiet >/dev/null
done

gcloud iam service-accounts add-iam-policy-binding \
  "pi-orb-debug@$PROJECT.iam.gserviceaccount.com" \
  --project="$PROJECT" --member="serviceAccount:$DEPLOYER_EMAIL" \
  --role='roles/iam.serviceAccountTokenCreator' --quiet >/dev/null
