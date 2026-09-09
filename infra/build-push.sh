#!/bin/bash
# Build and validate a native VM image, then publish the control-plane container.
# stdout is an OpenTofu variable file; progress goes to stderr.
set -euo pipefail
umask 077
cd "$(dirname "$0")/.."
source infra/release-child.sh

on_signal() {
  local status=$1
  trap '' HUP INT TERM
  release_stop_child
  exit "$status"
}
trap 'on_signal 129' HUP
trap 'on_signal 130' INT
trap 'on_signal 143' TERM

PROJECT=${PROJECT:-playground-dev-6ae7}
REGION=${REGION:-us-central1}
ZONE=${ZONE:-us-central1-a}
REPO="$REGION-docker.pkg.dev/$PROJECT/pi-orb"
COMMIT=$(git rev-parse HEAD)
TAG="v-$(git rev-parse --short HEAD)"
BASE_IMAGE=${BASE_IMAGE:-projects/debian-cloud/global/images/debian-12-bookworm-v20260902}
IMAGE_BUILD_DIR=${IMAGE_BUILD_DIR:-$PWD/.context/native-image-release/$(date -u +%Y%m%dT%H%M%SZ)-$TAG}
IMAGE_BUILDER_SA=${IMAGE_BUILDER_SA:-pi-orb-image-builder@$PROJECT.iam.gserviceaccount.com}
IMAGE_BUILD_SUBNET=${IMAGE_BUILD_SUBNET:-projects/$PROJECT/regions/$REGION/subnetworks/pi-orb-image-build-$REGION}

release_run_child node --experimental-strip-types packages/native-image/src/cli.ts \
  --project "$PROJECT" --zone "$ZONE" \
  --base-image "$BASE_IMAGE" --version "$TAG" --subnet "$IMAGE_BUILD_SUBNET" \
  --builder-service-account "$IMAGE_BUILDER_SA" \
  --validation-service-account "pi-orb-orb-vm@$PROJECT.iam.gserviceaccount.com" \
  --validation-repository-url https://github.com/octocat/Hello-World --output-dir "$IMAGE_BUILD_DIR" >&2

# Recheck both provenance and acceptance before publishing the release artifact.
node infra/native-image-vars.mjs "$IMAGE_BUILD_DIR/manifest.json" "$COMMIT" "$PROJECT" > "$IMAGE_BUILD_DIR/native.tfvars"
CP_IMAGE="$REPO/control-plane:$TAG"
docker build --platform linux/amd64 -q -f apps/control-plane/Dockerfile \
  --label "org.opencontainers.image.revision=$COMMIT" \
  --label "org.opencontainers.image.source=https://github.com/schani/pi-orb" \
  -t "$CP_IMAGE" . >&2
docker push -q "$CP_IMAGE" >&2
CP=$(docker inspect --format='{{index .RepoDigests 0}}' "$CP_IMAGE")
if ! [[ "$CP" =~ ^[^[:space:]]+@sha256:[a-f0-9]{64}$ ]]; then
  echo "build: registry returned an invalid control-plane digest" >&2
  exit 1
fi
printf 'control_plane_image = "%s"\n' "$CP"
cat "$IMAGE_BUILD_DIR/native.tfvars"
printf 'deploy_generation = %s\n' "$(date +%s)"
echo "build: accepted image manifest: $IMAGE_BUILD_DIR/manifest.json" >&2
