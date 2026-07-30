#!/bin/bash
# Build both images for linux/amd64, push commit-tagged, and print the
# digest-pinned references to pass to tofu:
#   ./build-push.sh
#   tofu apply -var control_plane_image=... -var runtime_image=...
set -euo pipefail
cd "$(dirname "$0")/.."

PROJECT=${PROJECT:-playground-dev-6ae7}
REGION=${REGION:-us-central1}
REPO="$REGION-docker.pkg.dev/$PROJECT/pi-orb"
TAG=$(git rev-parse --short HEAD)

build() {
  local name=$1 dockerfile=$2
  local image="$REPO/$name:$TAG"
  docker build --platform linux/amd64 -q -f "$dockerfile" -t "$image" . >&2
  docker push -q "$image" >&2
  local digest
  digest=$(docker inspect --format='{{index .RepoDigests 0}}' "$image")
  echo "$digest"
}

CP=$(build control-plane apps/control-plane/Dockerfile)
RT=$(build runtime apps/orb-runtime/Dockerfile)

echo "control_plane_image = \"$CP\""
echo "runtime_image       = \"$RT\""
