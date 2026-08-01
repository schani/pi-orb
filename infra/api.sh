#!/bin/bash
# Authenticated pi-orb API access for tooling, via the ops service:
#   ./api.sh /api/v1/projects
#   ./api.sh /api/v1/projects '{"id":"..."}'     # POST with JSON body
set -euo pipefail
DIR=$(cd "$(dirname "$0")" && pwd)
URL=${PI_ORB_OPS_URL:-$(cd "$DIR" && tofu output -raw ops_url)}
TOKEN=$(gcloud auth print-identity-token \
  --impersonate-service-account=pi-orb-debug@playground-dev-6ae7.iam.gserviceaccount.com \
  --audiences="$URL" 2>/dev/null)
curl -s -H "Authorization: Bearer $TOKEN" \
  ${2:+-X POST -H content-type:application/json -d "$2"} "$URL$1"
