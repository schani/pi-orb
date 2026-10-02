#!/bin/bash
# Authenticated pi-orb API access for tooling, via the application:
#   PI_ORB_USER_ID=<uuid> ./api.sh /api/v1/projects
#   ./api.sh /api/v1/projects '{"id":"..."}'     # POST with JSON body
#   ./api.sh /api/v1/orbs/<id> '' DELETE         # explicit method, no body
# The method defaults to POST when a non-empty body is given and GET otherwise.
set -euo pipefail
DIR=$(cd "$(dirname "$0")" && pwd)
PROJECT=${PROJECT:-playground-dev-6ae7}
URL=${PI_ORB_APP_ORIGIN:-$(cd "$DIR" && tofu output -raw app_url)}
BODY=${2:-}
METHOD=${3:-}
if [ -z "$METHOD" ]; then
  if [ -n "$BODY" ]; then METHOD=POST; else METHOD=GET; fi
fi
TOKEN=$(gcloud auth print-identity-token \
  --impersonate-service-account="pi-orb-debug@$PROJECT.iam.gserviceaccount.com" \
  --audiences="$URL" 2>/dev/null)
USER_HEADER=()
if [ -n "${PI_ORB_USER_ID:-}" ]; then
  [[ "$PI_ORB_USER_ID" =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$ ]] || { echo 'api: PI_ORB_USER_ID must be a UUID' >&2; exit 2; }
  USER_HEADER=(-H "X-Pi-Orb-User-Id: $PI_ORB_USER_ID")
fi
printf 'header = "Authorization: Bearer %s"\n' "$TOKEN" |
  curl -s -K - -X "$METHOD" "${USER_HEADER[@]}" \
  ${BODY:+-H content-type:application/json -d "$BODY"} "$URL$1"
