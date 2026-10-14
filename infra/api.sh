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
if TOKEN=$(gcloud auth print-identity-token \
  --impersonate-service-account="pi-orb-debug@$PROJECT.iam.gserviceaccount.com" \
  --audiences="$URL" 2>/dev/null); then
  if [ -z "$TOKEN" ]; then
    echo 'api: phase=auth exit=1 errorcode=identity_token' >&2
    exit 1
  fi
else
  status=$?
  echo "api: phase=auth exit=$status errorcode=identity_token" >&2
  exit "$status"
fi
USER_HEADER=()
if [ -n "${PI_ORB_USER_ID:-}" ]; then
  [[ "$PI_ORB_USER_ID" =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$ ]] || { echo 'api: PI_ORB_USER_ID must be a UUID' >&2; exit 2; }
  USER_HEADER=(-H "X-Pi-Orb-User-Id: $PI_ORB_USER_ID")
fi
# Raw adapter errors and response bodies never enter failure logs.
umask 077
RESPONSE=$(mktemp)
trap 'rm -f "$RESPONSE"' EXIT
if HTTP=$(printf 'header = "Authorization: Bearer %s"\n' "$TOKEN" |
  curl -s -K - -X "$METHOD" "${USER_HEADER[@]}" \
  ${BODY:+-H content-type:application/json -d "$BODY"} \
  -o "$RESPONSE" -w '%{http_code}' "$URL$1" 2>/dev/null); then
  :
else
  status=$?
  echo "api: phase=transport exit=$status errorcode=curl_transport" >&2
  exit "$status"
fi
[[ "$HTTP" =~ ^[1-5][0-9]{2}$ ]] || {
  echo 'api: phase=http exit=22 http=000 errorcode=invalid_status' >&2
  exit 22
}
if [ "$HTTP" = 404 ] && jq -e '.error.code == "not_found"' "$RESPONSE" >/dev/null 2>&1; then
  echo '{"error":{"code":"not_found"},"httpStatus":404}'
elif [[ "$HTTP" = 2* ]]; then
  if [ ! -s "$RESPONSE" ]; then exit 0; fi
  if ! jq -e 'type == "object" and .error == null' "$RESPONSE" >/dev/null 2>&1; then
    echo "api: phase=application exit=22 http=$HTTP errorcode=application_error" >&2
    exit 22
  fi
  cat "$RESPONSE"
else
  code=http_error
  if jq -e '.error != null' "$RESPONSE" >/dev/null 2>&1; then code=application_error; fi
  echo "api: phase=http exit=22 http=$HTTP errorcode=$code" >&2
  exit 22
fi
