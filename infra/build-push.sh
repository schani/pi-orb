#!/bin/bash
# Build both images for linux/amd64, push commit-tagged, and print the
# digest-pinned references plus the deploy generation to pass to tofu:
#   ./build-push.sh
#   tofu apply -var control_plane_image=... -var runtime_image=... \
#     -var deploy_generation=...
set -euo pipefail
cd "$(dirname "$0")/.."

PROJECT=${PROJECT:-playground-dev-6ae7}
REGION=${REGION:-us-central1}
REPO="$REGION-docker.pkg.dev/$PROJECT/pi-orb"
TAG=$(git rev-parse --short HEAD)
GATE_TIMEOUT=${GATE_TIMEOUT:-60}

build() {
  local name=$1 dockerfile=$2
  local image="$REPO/$name:$TAG"
  docker build --platform linux/amd64 -q -f "$dockerfile" -t "$image" . >&2
  echo "$image"
}

push() {
  local image=$1
  docker push -q "$image" >&2
  docker inspect --format='{{index .RepoDigests 0}}' "$image"
}

# Boot gate: run the just-built amd64 artifact and require it to serve HTTP.
#
# The bar is "the artifact executes and answers", not "boot succeeds": the
# runtime's health server comes up before slow initialization and returns 200
# with an `initializing`/`failed` body, which is exactly what a dummy repo URL
# produces. That still catches the class of defect worth catching here — an
# image that cannot start at all (bad entrypoint, missing/corrupt files, wrong
# arch, broken package.json).
#
# Only the runtime image is gated. Cloud Run refuses to roll out a
# control-plane revision whose container never listens, so a broken
# control-plane image fails the deploy loudly on its own. COS on the orb VM
# silently tolerates a crash-looping runtime container — nothing downstream
# ever verifies that artifact, and the control plane only sees "runtime never
# answered" minutes later (docs/postmortems/2026-08-06-rollover-repair-war-corrupt-image.md).
#
# The gate runs before either push: an artifact that cannot boot should never
# reach the registry, where a later `tofu apply` could pin it by digest.
gate() {
  local image=$1
  local cid port deadline
  echo "gate: booting $image ..." >&2
  # Deliberately not `--rm`: the most informative failure is a container that
  # crashed on startup, and `--rm` throws its logs away before we can print
  # them. Removal is explicit (and trapped) instead.
  cid=$(docker run -d --platform linux/amd64 -p 127.0.0.1:0:8080 \
    -e PI_ORB_ID=image-gate \
    -e PI_ORB_REPOSITORY_URL=https://example.invalid/repo.git \
    "$image") || true
  if [ -z "$cid" ]; then
    echo "gate: FAILED — the container could not even be created" >&2
    return 1
  fi
  # shellcheck disable=SC2064  # $cid must expand now, not at trap time
  trap "docker rm -f $cid >/dev/null 2>&1 || true" EXIT

  port=$(docker port "$cid" 8080 2>/dev/null | head -n1 | sed 's/.*://')
  if [ -z "$port" ]; then
    echo "gate: FAILED — no published port for 8080 (container did not stay up?)" >&2
    echo "gate: container logs follow" >&2
    docker logs "$cid" >&2 2>&1 || true
    docker rm -f "$cid" >/dev/null 2>&1 || true
    trap - EXIT
    return 1
  fi

  deadline=$(( $(date +%s) + GATE_TIMEOUT ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    if [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 \
      "http://127.0.0.1:$port/v1/health" 2>/dev/null)" = "200" ]; then
      echo "gate: OK — $image answered /v1/health with 200" >&2
      docker rm -f "$cid" >/dev/null 2>&1 || true
      trap - EXIT
      return 0
    fi
    if [ -z "$(docker ps -q --filter "id=$cid")" ]; then
      echo "gate: FAILED — container exited before serving /v1/health" >&2
      break
    fi
    sleep 2
  done

  echo "gate: FAILED — $image did not serve /v1/health within ${GATE_TIMEOUT}s" >&2
  echo "gate: container logs follow" >&2
  docker logs "$cid" >&2 2>&1 || true
  docker rm -f "$cid" >/dev/null 2>&1 || true
  trap - EXIT
  return 1
}

CP_IMAGE=$(build control-plane apps/control-plane/Dockerfile)
RT_IMAGE=$(build runtime apps/orb-runtime/Dockerfile)

if ! gate "$RT_IMAGE"; then
  echo "ABORTED: runtime image failed the boot gate; nothing was pushed." >&2
  exit 1
fi

CP=$(push "$CP_IMAGE")
RT=$(push "$RT_IMAGE")

echo "control_plane_image = \"$CP\""
echo "runtime_image       = \"$RT\""
# Forward-only script-repair fencing (docs/host-provider.md): each deploy must
# carry a strictly larger generation than the one it replaces, so the draining
# old revision refuses to repair the new revision's hosts backward. Seconds
# since the epoch is monotonic across machines and needs no state. An apply
# that omits the var runs at generation 0 and repairs nothing a real deploy
# stamped — an upgrade delayed to the next deploy, never a backward repair.
echo "deploy_generation   = $(date +%s)"
