#!/bin/bash
# Authenticated pi-orb API access for tooling, via the ops service:
#   ./api.sh /api/v1/projects
#   ./api.sh /api/v1/projects '{"id":"..."}'     # POST with JSON body
#   ./api.sh /api/v1/orbs/<id> '' DELETE         # explicit method, no body
# The method defaults to POST when a non-empty body is given and GET otherwise.
set -euo pipefail
DIR=$(cd "$(dirname "$0")" && pwd)
URL=${PI_ORB_OPS_URL:-$(cd "$DIR" && tofu output -raw ops_url)}
BODY=${2:-}
METHOD=${3:-}
if [ -z "$METHOD" ]; then
  if [ -n "$BODY" ]; then METHOD=POST; else METHOD=GET; fi
fi
TOKEN=$(gcloud auth print-identity-token \
  --impersonate-service-account=pi-orb-debug@playground-dev-6ae7.iam.gserviceaccount.com \
  --audiences="$URL" 2>/dev/null)
curl -s -H "Authorization: Bearer $TOKEN" -X "$METHOD" \
  ${BODY:+-H content-type:application/json -d "$BODY"} "$URL$1"
