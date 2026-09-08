#!/bin/bash
# One-release maintenance boundary for draining every browser revision.
set -euo pipefail
umask 077

PROJECT=${PROJECT:?PROJECT is required}
REGION=${REGION:?REGION is required}
STATE_FILE=${1:?state file is required}
shift
if [ "${1:-}" != "--" ] || [ "$#" -lt 2 ]; then
  echo "usage: release-quiesce.sh STATE_FILE -- DEPLOY_COMMAND [ARG ...]" >&2
  exit 2
fi
shift

GCLOUD=${GCLOUD:-gcloud}
CURL=${CURL:-curl}
JQ=${JQ:-jq}
DATE=${DATE:-date}
SLEEP=${SLEEP:-sleep}
DEADLINE_SECONDS=${QUIESCE_DEADLINE_SECONDS:-420}
POLL_SECONDS=${QUIESCE_POLL_SECONDS:-15}
RESTORED=false
IAP_REPAIRED=false
DEPLOY=("$@")

restore() {
  if [ "$RESTORED" = true ] || [ ! -s "$STATE_FILE" ]; then return 0; fi
  mode=$($JQ -r '.scalingMode' "$STATE_FILE") || return 1
  if [ "$mode" = "manual" ]; then
    count=$($JQ -r '.manualInstanceCount' "$STATE_FILE")
    if ! "$GCLOUD" run services update pi-orb --project "$PROJECT" --region "$REGION" \
      --scaling="$count" --quiet >/dev/null; then return 1; fi
  else
    if ! "$GCLOUD" run services update pi-orb --project "$PROJECT" --region "$REGION" \
      --scaling=auto --quiet >/dev/null; then return 1; fi
  fi
  RESTORED=true
  echo "release: restored browser scaling ($mode)"
}

repair_iap() {
  if [ "$IAP_REPAIRED" = true ]; then return 0; fi
  if "${DEPLOY[0]}" --iap-only; then IAP_REPAIRED=true; return 0; fi
  echo "release: CRITICAL: IAP repair failed during maintenance cleanup" >&2
  return 1
}

finish() {
  status=$?
  trap - EXIT HUP INT TERM
  rm -f "$STATE_FILE.authorization"
  repair_iap || status=1
  restore || status=1
  exit "$status"
}
signal() { exit "$1"; }
trap finish EXIT
trap 'signal 129' HUP
trap 'signal 130' INT
trap 'signal 143' TERM

service=$($GCLOUD run services describe pi-orb --project "$PROJECT" --region "$REGION" --format=json)
if ! $JQ -e '([.status.traffic[]? | select((.tag // "") != "")] | length) == 0' \
  <<<"$service" >/dev/null; then
  echo "release refused: browser service has traffic tags that bypass service disablement" >&2
  exit 1
fi
serving=$($JQ -r '.status.traffic[] | select((.percent // 0) == 100) | .revisionName' <<<"$service")
latest_ready=$($JQ -r '.status.latestReadyRevisionName // empty' <<<"$service")
latest_created=$($JQ -r '.status.latestCreatedRevisionName // empty' <<<"$service")
traffic_count=$($JQ '.status.traffic | length' <<<"$service")
if [ "$traffic_count" -ne 1 ] || [ -z "$serving" ] || [[ "$serving" == *$'\n'* ]] ||
  [ "$serving" != "$latest_ready" ] || [ "$serving" != "$latest_created" ]; then
  echo "release refused: browser traffic is not assigned to exactly one revision" >&2
  exit 1
fi
revisions=$($GCLOUD run revisions list --service pi-orb --project "$PROJECT" \
  --region "$REGION" --format='value(name)' | $JQ -R 'select(length > 0)' | $JQ -s .)
if [ "$revisions" = "[]" ]; then
  echo "release refused: browser service has no revisions" >&2
  exit 1
fi

mode=$($JQ -r '.metadata.annotations["run.googleapis.com/scalingMode"] // "automatic"' <<<"$service")
count=$($JQ -r '.metadata.annotations["run.googleapis.com/manualInstanceCount"] // empty' <<<"$service")
if [ "$mode" != "automatic" ] && [ "$mode" != "manual" ]; then
  echo "release refused: invalid existing scaling mode" >&2
  exit 1
fi
if [ "$mode" = "manual" ] && ! [[ "$count" =~ ^[0-9]+$ ]]; then
  echo "release refused: invalid existing manual scaling configuration" >&2
  exit 1
fi
$JQ -n --arg mode "$mode" --arg count "$count" --arg serving "$serving" \
  --argjson revisions "$revisions" \
  '{scalingMode:$mode, manualInstanceCount:($count | if . == "" then null else tonumber end), serving:$serving, revisions:$revisions}' \
  > "$STATE_FILE"
chmod 600 "$STATE_FILE"
echo "release: quiescing browser revisions: $($JQ -r '.revisions | join(", ")' "$STATE_FILE")"

"$GCLOUD" run services update pi-orb --project "$PROJECT" --region "$REGION" \
  --scaling=0 --quiet >/dev/null
disabled_at=$($DATE -u +%Y-%m-%dT%H:%M:%SZ)
deadline=$(( $($DATE +%s) + DEADLINE_SECONDS ))
filter="metric.type=\"run.googleapis.com/container/instance_count\" AND resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"pi-orb\" AND resource.labels.location=\"$REGION\""

while :; do
  now=$($DATE -u +%Y-%m-%dT%H:%M:%SZ)
  token=$($GCLOUD auth print-access-token)
  printf 'header = "Authorization: Bearer %s"\n' "$token" > "$STATE_FILE.authorization"
  chmod 600 "$STATE_FILE.authorization"
  metrics='{"timeSeries":[]}'
  page_token=""
  while :; do
    curl_args=(--fail --silent --show-error --connect-timeout 10 --max-time 30 --get \
      --config "$STATE_FILE.authorization" --data-urlencode "filter=$filter" \
      --data-urlencode "interval.startTime=$disabled_at" --data-urlencode "interval.endTime=$now" \
      --data-urlencode 'view=FULL' --data-urlencode 'pageSize=10000')
    if [ -n "$page_token" ]; then curl_args+=(--data-urlencode "pageToken=$page_token"); fi
    page=$("$CURL" "${curl_args[@]}" \
      "https://monitoring.googleapis.com/v3/projects/$PROJECT/timeSeries")
    if ! $JQ -e '.timeSeries == null or (.timeSeries | type == "array")' <<<"$page" >/dev/null; then
      echo "release refused: malformed Monitoring response" >&2
      exit 1
    fi
    metrics=$($JQ -s '{timeSeries: ((.[0].timeSeries // []) + (.[1].timeSeries // []))}' \
      <(printf '%s' "$metrics") <(printf '%s' "$page"))
    page_token=$($JQ -r '.nextPageToken // empty' <<<"$page")
    [ -z "$page_token" ] && break
  done
  rm -f "$STATE_FILE.authorization"
  if $JQ -e --arg disabled "$disabled_at" --arg now "$now" --arg region "$REGION" --argjson revisions "$($JQ '.revisions' "$STATE_FILE")" '
    def epoch:
      if type != "string" then null
      else try (sub("\\.[0-9]+Z$"; "Z") | fromdateiso8601) catch null end;
    def explicit_zero:
      type == "object" and (.int64Value? | type == "string") and
      (.int64Value | test("^[0-9]+$") and tonumber == 0);
    ($disabled | epoch) as $disabled_epoch |
    ($now | epoch) as $now_epoch |
    $disabled_epoch != null and $now_epoch != null and
    ([$revisions[] as $revision | ["active", "idle"][] as $state |
      ([.timeSeries[]? |
        select(.resource.labels.revision_name == $revision) |
        select(.resource.labels.location == $region) |
        select(.metric.labels.state == $state) |
        .points[]? |
        {epoch:(.interval.endTime | epoch), value:.value}]) as $points |
      ($points | length) > 0 and
      all($points[]; .epoch != null and .epoch <= $now_epoch) and
      ([$points[] | select(.epoch >= $disabled_epoch)] | if length == 0 then false
       else (max_by(.epoch).value | explicit_zero) end)] | all)
  ' <<<"$metrics" >/dev/null; then
    break
  fi
  if [ "$($DATE +%s)" -ge "$deadline" ]; then
    echo "release refused: no fresh zero active+idle instance count for every recorded browser revision" >&2
    exit 1
  fi
  "$SLEEP" "$POLL_SECONDS"
done

"${DEPLOY[@]}"
IAP_REPAIRED=true

after=$($GCLOUD run services describe pi-orb --project "$PROJECT" --region "$REGION" --format=json)
if ! $JQ -e --arg serving "$serving" '
  ([.status.traffic[]? | select((.tag // "") != "")] | length) == 0 and
  ([.status.traffic[]? | select(.revisionName == $serving and (.percent // 0) == 100)] | length) == 1 and
  ([.status.traffic[]?] | length) == 1 and
  .status.latestReadyRevisionName == $serving and
  .status.latestCreatedRevisionName == $serving
' <<<"$after" >/dev/null; then
  echo "release refused: browser traffic changed during maintenance cleanup" >&2
  exit 1
fi

restore
trap - EXIT HUP INT TERM
