#!/bin/bash
# Live workload-identity smoke against the deployed control plane
# (docs/workload-identity.md, "Federation integrations").
#
# It proves the whole provider-neutral chain on real infrastructure, which no
# unit, DST, or E2E run can: a disposable orb on real GCE mints through the
# in-orb CLI, the token verifies against the *deployed* public issuer's
# discovery document and JWKS, GCP's STS accepts it, an impersonated read-only
# service account answers a real API call, and the identity is refused where it
# must be — a wrong audience at STS, and a stopped orb at the mint route.
#
# Usage:
#   ./infra/smoke-workload-identity.sh
#
# Required environment:
#   PI_ORB_GCP_PROJECT, PI_ORB_GCE_ZONE   where orb VMs live
# Optional:
#   PI_ORB_APP_ORIGIN, PI_ORB_ISSUER_URL     default to the tofu outputs
#   PI_ORB_SMOKE_PROJECT_ID               an existing pi-orb project to use (the
#                                         one a project-scoped WIF grant names).
#                                         It is never created or deleted; a
#                                         generated project is deleted on pass.
#   PI_ORB_SMOKE_SSH_FLAGS                extra `gcloud compute ssh` flags; the
#                                         required IAP tunnel is always enabled
#
# Federation legs (all three, or the script degrades to mint + verify with a
# loud notice — that is the mode to expect before the WIF tier is bootstrapped
# by infra/bootstrap-pi-orb-oidc.sh):
#   PI_ORB_SMOKE_WIF_AUDIENCE      audience the provider allows
#   PI_ORB_SMOKE_WIF_STS_AUDIENCE  //iam.googleapis.com/projects/.../providers/...
#   PI_ORB_SMOKE_WIF_TEST_SA       read-only service account to impersonate
#
# Talks to the application through api.sh (pi-orb-debug impersonation) and to
# GCE through gcloud, so it needs the same valid credentials as any other
# tooling here. No JWT, bearer, or access token is ever printed: tokens travel
# through pipes and mode-0600 files in a mode-0700 directory removed on exit.
set -euo pipefail
umask 077

DIR=$(cd "$(dirname "$0")" && pwd)
API="$DIR/api.sh"
: "${PI_ORB_USER_ID:?PI_ORB_USER_ID is required for smoke project creation}"
source "$DIR/smoke-fixtures.sh"

OVERALL_TIMEOUT=${OVERALL_TIMEOUT:-3600} # two lifecycle boots, stops, SSH and federation
RUNNING_TIMEOUT=${RUNNING_TIMEOUT:-900}
STOPPED_TIMEOUT=${STOPPED_TIMEOUT:-300}
SSH_READY_TIMEOUT=${SSH_READY_TIMEOUT:-180} # SSH daemon + metadata key propagation
POLL_INTERVAL=${POLL_INTERVAL:-5}

START_TS=$(date +%s)
DEADLINE=$((START_TS + OVERALL_TIMEOUT))
export PI_ORB_SMOKE_HTTP=1
export PI_ORB_SMOKE_DEADLINE=$DEADLINE

MINT_ORB=""
STOPPED_ORB=""
PROJECT_ID=""
PROJECT_IS_DISPOSABLE=true
WORK_DIR=""

say() { # progress to stderr: several steps return documents on stdout
  printf '[%s] %s\n' "$(date -u +%H:%M:%S)" "$*" >&2
}

note() { # a deliberate, loud degradation — never silent
  printf '\n[%s] SKIP: %s\n\n' "$(date -u +%H:%M:%S)" "$*" >&2
}

fail() {
  local step=$1
  shift
  echo >&2
  echo "WORKLOAD-IDENTITY SMOKE FAILED at step: $step" >&2
  echo "  $*" >&2
  if [ -n "$PROJECT_ID" ]; then echo "  project:     $PROJECT_ID" >&2; fi
  if [ -n "$MINT_ORB" ]; then echo "  minting orb: $MINT_ORB" >&2; fi
  if [ -n "$STOPPED_ORB" ]; then echo "  stopped orb: $STOPPED_ORB" >&2; fi
  exit 1
}

check_deadline() {
  if [ "$(date +%s)" -ge "$DEADLINE" ]; then
    fail "$1" "overall timeout of ${OVERALL_TIMEOUT}s exceeded"
  fi
}

cleanup() {
  local status=$?
  trap - EXIT
  # Failure evidence stays in the cloud; credential scratch is always removed.
  if [ "$status" -eq 0 ]; then
    if [ -n "$MINT_ORB" ]; then if fixture_delete orb "$MINT_ORB"; then MINT_ORB=""; else [ "$?" -ne 2 ] || MINT_ORB=""; status=1; fi; fi
    if [ -n "$STOPPED_ORB" ]; then if fixture_delete orb "$STOPPED_ORB"; then STOPPED_ORB=""; else [ "$?" -ne 2 ] || STOPPED_ORB=""; status=1; fi; fi
    if [ "$status" -eq 0 ] && [ "$PROJECT_IS_DISPOSABLE" = true ] && [ -n "$PROJECT_ID" ]; then
      if fixture_delete project "$PROJECT_ID"; then PROJECT_ID=""; else [ "$?" -ne 2 ] || PROJECT_ID=""; status=1; fi
    fi
  fi
  if [ "$status" -ne 0 ] && { [ -n "$MINT_ORB$STOPPED_ORB" ] || { [ "$PROJECT_IS_DISPOSABLE" = true ] && [ -n "$PROJECT_ID" ]; }; }; then
    [ -z "$MINT_ORB" ] || fixture_record orb "$MINT_ORB" retained || true
    [ -z "$STOPPED_ORB" ] || fixture_record orb "$STOPPED_ORB" retained || true
    if [ "$PROJECT_IS_DISPOSABLE" = true ] && [ -n "$PROJECT_ID" ]; then fixture_record project "$PROJECT_ID" retained || true; fi
    echo "Failed fixtures retained for diagnosis: orbs=$MINT_ORB,$STOPPED_ORB" >&2
    if [ "$PROJECT_IS_DISPOSABLE" = true ] && [ -n "$PROJECT_ID" ]; then echo "Owned project retained: $PROJECT_ID" >&2; fi
    echo "Delete only these test fixtures after preserving evidence; they may still incur compute/storage charges." >&2
  fi
  [ -n "$WORK_DIR" ] && rm -rf "$WORK_DIR"
  if [ "$status" -eq 0 ]; then echo "WORKLOAD-IDENTITY SMOKE PASSED (cleanup verified)"; fi
  exit "$status"
}
trap cleanup EXIT

# --- preflight --------------------------------------------------------------

# node is required: verifying an RS256 signature against the served JWKS is the
# point of the mint leg, and a shell that cannot do that would be asserting
# nothing.
for command in curl gcloud node tofu uuidgen jq python3; do
  command -v "$command" >/dev/null 2>&1 ||
    fail "preflight" "missing required command '$command'"
done

: "${PI_ORB_GCP_PROJECT:?required}"
: "${PI_ORB_GCE_ZONE:?required}"

# `set -e` makes a failing command substitution abort the script *silently* at
# the assignment, before the diagnostic that explains it can run — so every
# assignment whose failure the operator must understand is guarded with `||` or
# the `if !` form.
if [ -z "${PI_ORB_APP_ORIGIN:-}" ]; then
  if ! PI_ORB_APP_ORIGIN=$(python3 "$DIR/smoke_http.py" external tofu-app); then
    fail "preflight" "no app URL (set PI_ORB_APP_ORIGIN, or make 'tofu output -raw app_url' readable)"
  fi
fi
export PI_ORB_APP_ORIGIN
[ -n "$PI_ORB_APP_ORIGIN" ] || fail "preflight" "the app URL is empty"

ISSUER_URL=${PI_ORB_ISSUER_URL:-}
if [ -z "$ISSUER_URL" ]; then
  if ! ISSUER_URL=$(python3 "$DIR/smoke_http.py" external tofu-issuer); then
    fail "preflight" "no issuer URL (set PI_ORB_ISSUER_URL, or make 'tofu output -raw issuer_url' readable)"
  fi
fi
[ -n "$ISSUER_URL" ] || fail "preflight" "no issuer URL (tofu output issuer_url)"

WIF_AUDIENCE=${PI_ORB_SMOKE_WIF_AUDIENCE:-}
WIF_STS_AUDIENCE=${PI_ORB_SMOKE_WIF_STS_AUDIENCE:-}
WIF_TEST_SA=${PI_ORB_SMOKE_WIF_TEST_SA:-}
FEDERATE=false
if [ -n "$WIF_AUDIENCE" ] && [ -n "$WIF_STS_AUDIENCE" ] && [ -n "$WIF_TEST_SA" ]; then
  FEDERATE=true
fi
# The audience the mint + verify legs use. When the WIF tier is configured it is
# the provider's allowed audience, so one token exercises both halves.
AUDIENCE=${WIF_AUDIENCE:-urn:pi-orb-smoke:identity}
WRONG_AUDIENCE="urn:pi-orb-smoke:not-this-provider"

if ! WORK_DIR=$(mktemp -d "${TMPDIR:-/tmp}/pi-orb-wif-smoke.XXXXXX"); then
  fail "preflight" "could not create a working directory under ${TMPDIR:-/tmp}"
fi
chmod 700 "$WORK_DIR"

# --- JSON access ------------------------------------------------------------
  jget() { # jget <dotted.path> ; JSON on stdin ; prints "" when absent
    python3 -c '
import json, sys
try:
    doc = json.load(sys.stdin)
except Exception:
    sys.exit(3)
for key in sys.argv[1].split("."):
    if not isinstance(doc, dict) or key not in doc:
        print("")
        sys.exit(0)
    doc = doc[key]
print("" if doc is None else doc)
' "$1"
  }

api() { # api <path> [json-body] [method]
  "$API" "$1" "${2-}" "${3-}"
}

# --- helper programs --------------------------------------------------------

# Local verifier: exactly the checks docs/workload-identity.md requires of a
# relying party, run against the *deployed* issuer rather than a fixture. The
# JWT arrives on stdin and never appears in argv, output, or a file.
cp "$DIR/smoke_identity_http.cjs" "$WORK_DIR/smoke_identity_http.cjs"
cat > "$WORK_DIR/verify.js" <<'VERIFY_JS'
const { createPublicKey, createVerify } = require("node:crypto");
const { smokeJson } = require("./smoke_identity_http.cjs");

// Run as a file (`node verify.js …`), so the arguments start after argv[1].
const [issuer, audience, projectId, orbId, incarnation] = process.argv.slice(2);
const fail = (message) => {
  process.stderr.write(`verify: ${message}\n`);
  process.exit(1);
};
const decode = (segment) =>
  JSON.parse(Buffer.from(segment.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));

const read = () =>
  new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data.trim()));
  });

const getJson = async (operation, url) => {
  const response = await smokeJson(operation, url);
  if (!response.ok) fail("issuer request failed");
  return response.body;
};

(async () => {
  const jwt = await read();
  const parts = jwt.split(".");
  if (parts.length !== 3) fail("stdin did not carry a three-part JWT");
  const header = decode(parts[0]);
  const claims = decode(parts[1]);

  // Discovery is fetched from the configured issuer origin and must claim to be
  // that issuer. A document naming someone else is a misconfiguration a verifier
  // must never follow.
  const discovery = await getJson("discovery", `${issuer}/.well-known/openid-configuration`);
  if (discovery.issuer !== issuer) fail("discovery_issuer_mismatch");
  if (new URL(discovery.jwks_uri).origin !== new URL(issuer).origin) {
    fail("jwks_origin_mismatch");
  }
  if (!(discovery.id_token_signing_alg_values_supported || []).includes("RS256")) {
    fail("discovery does not advertise RS256");
  }

  if (header.alg !== "RS256") fail("algorithm_mismatch");
  if (!header.kid) fail("no kid in the JWT header");
  const jwks = await getJson("jwks", discovery.jwks_uri);
  const jwk = (jwks.keys || []).find((key) => key.kid === header.kid);
  if (!jwk) fail("key_unpublished");
  const verifier = createVerify("RSA-SHA256");
  verifier.update(`${parts[0]}.${parts[1]}`);
  const signature = Buffer.from(parts[2].replace(/-/g, "+").replace(/_/g, "/"), "base64");
  if (!verifier.verify(createPublicKey({ key: jwk, format: "jwk" }), signature)) {
    fail("signature does not verify against the published key");
  }

  // Claims must equal the minting orb's real identity, not merely be present:
  // asserting presence would pass for any orb of the deployment, which is the
  // authorization mistake the recipes warn about.
  const now = Math.floor(Date.now() / 1000);
  const skew = 60;
  if (claims.iss !== issuer) fail("issuer_mismatch");
  if (claims.aud !== audience) fail("audience_mismatch");
  if (claims.token_use !== "exchanged") fail("token_use_mismatch");
  if (!(claims.iat <= now + skew)) fail("iat is in the future");
  if (!(claims.exp > now - skew)) fail("token is already expired");
  if (claims.exp - claims.iat > 3600) fail("lifetime exceeds the documented maximum");
  if (claims.sub !== orbId) fail("subject_mismatch");
  if (claims.orb_id !== orbId) fail("orb_mismatch");
  if (String(claims.host_incarnation) !== incarnation) {
    fail("incarnation_mismatch");
  }
  if (claims.project_id !== projectId) fail("project_mismatch");
  if (!claims.jti) fail("no jti claim");
  if (claims.user_id || claims.email) fail("the token carries a user identity it must not have");

  process.stdout.write("verified\n");
})().catch(() => fail("local verification failed"));
VERIFY_JS

# Remote probe, run *inside another live orb* against the control-plane URL
# that orb is configured with. The bearer under test arrives on stdin; the mint
# URL is its only argument. Prints "<status> <code>".
#
# The mint route's error is a bare string (`{"error":"not_mintable"}`, see
# packages/protocol/src/workload-identity.ts), not the `{"error":{"code":...}}`
# shape of the browser API, so the code is read from `error` directly.
cat "$DIR/smoke_identity_http.cjs" > "$WORK_DIR/probe.js"
cat >> "$WORK_DIR/probe.js" <<'PROBE_JS'
let bearer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => (bearer += chunk));
process.stdin.on("end", async () => {
  const response = await smokeJson("probe", process.argv[1], {
    method: "POST",
    headers: { authorization: `Bearer ${bearer.trim()}`, "content-type": "application/json" },
    body: JSON.stringify({ audience: "urn:pi-orb-smoke:revocation-probe" }),
  });
  if (!response.ok) { process.exitCode = 6; return; }
  const code = response.body.error === "not_mintable" ? "not_mintable" : "";
  process.stdout.write(`${response.status} ${code}\n`);
});
PROBE_JS

b64() { # base64 with no line breaks, portable across BSD and GNU
  base64 < "$1" | tr -d '\n'
}
PROBE_B64=$(b64 "$WORK_DIR/probe.js")

# --- control-plane steps ----------------------------------------------------

create_project() {
  local pid=$1 name=$2 response got
  if [ "$PROJECT_IS_DISPOSABLE" != true ]; then
    response=$(api "/api/v1/projects/$pid") || fail "reuse-project" "API unavailable"
    jq -e --arg id "$pid" '.id == $id' <<<"$response" >/dev/null || fail "reuse-project" "trusted project does not exist"
    return 0
  fi
  fixture_record project "$pid" requested
  response=$(api /api/v1/projects \
    "$(printf '{"id":"%s","name":"%s","repositoryUrl":"%s"}' \
      "$pid" "$name" "https://github.com/octocat/Hello-World")") ||
    fail "create-project" "api.sh failed"
  got=$(printf '%s' "$response" | jget id) ||
    fail "create-project" "unparseable response"
  [ "$got" = "$pid" ] || fail "create-project" "unexpected response"
  fixture_record project "$pid" created
}

create_orb() {
  local pid=$1 oid=$2 response got
  fixture_record orb "$oid" requested
  response=$(api "/api/v1/projects/$pid/orbs" "$(printf '{"id":"%s"}' "$oid")") ||
    fail "create-orb" "api.sh failed"
  got=$(printf '%s' "$response" | jget id) ||
    fail "create-orb" "unparseable response"
  [ "$got" = "$oid" ] || fail "create-orb" "unexpected response"
  fixture_record orb "$oid" created
  say "orb created: $oid"
}

smoke_lifecycle_fail() { fail "$@"; }

# --- GCE steps --------------------------------------------------------------

orb_instance() { # the one live instance of an orb, by label
  python3 "$DIR/smoke_http.py" external instances-list "$1"
}

instance_metadata() { # instance_metadata <instance> <key>
  python3 "$DIR/smoke_http.py" external instance-describe "$1" |
    node -e '
const key = process.argv[1];
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", () => {
  let instance;
  try {
    instance = JSON.parse(input);
  } catch {
    process.stderr.write("instance metadata: gcloud returned invalid JSON\n");
    process.exitCode = 3;
    return;
  }
  const items = Array.isArray(instance.metadata?.items) ? instance.metadata.items : [];
  const matches = items.filter((item) => item.key === key);
  if (matches.length > 1) {
    process.stderr.write("instance metadata: duplicate key\n");
    process.exitCode = 3;
    return;
  }
  if (matches.length === 1 && matches[0].value != null) {
    process.stdout.write(String(matches[0].value));
  }
});
' "$2"
}

orb_ssh() { # orb_ssh <allowlisted step> <instance> <remote command>
  local step=$1
  shift
  python3 "$DIR/smoke_http.py" external "ssh-$step" "$@"
}

wait_for_ssh() {
  local instance=$1 limit=$(( $(date +%s) + SSH_READY_TIMEOUT ))
  [ "$limit" -le "$DEADLINE" ] || limit=$DEADLINE
  say "waiting for SSH through IAP (<= ${SSH_READY_TIMEOUT}s)"
  PI_ORB_SMOKE_DEADLINE="$limit" orb_ssh ready "$instance" true </dev/null >/dev/null ||
    fail "ssh-ready" "SSH through IAP unavailable"
}

# --- run --------------------------------------------------------------------

PROJECT_ID=${PI_ORB_SMOKE_PROJECT_ID:-$(uuidgen | tr '[:upper:]' '[:lower:]')}
# A supplied project id must already exist: create_project only verifies it.
PROJECT_NAME="wif-smoke"
if [ -n "${PI_ORB_SMOKE_PROJECT_ID:-}" ]; then
  PROJECT_IS_DISPOSABLE=false
else
  PROJECT_NAME="wif-smoke-$(date -u +%Y%m%d-%H%M%S)"
fi
MINT_ORB=$(uuidgen | tr '[:upper:]' '[:lower:]')
STOPPED_ORB=$(uuidgen | tr '[:upper:]' '[:lower:]')

say "workload-identity smoke"

say "project $PROJECT_ID (disposable=$PROJECT_IS_DISPOSABLE)"
if [ "$FEDERATE" != true ]; then
  note "federation legs disabled: set PI_ORB_SMOKE_WIF_AUDIENCE, \
PI_ORB_SMOKE_WIF_STS_AUDIENCE and PI_ORB_SMOKE_WIF_TEST_SA after running \
infra/bootstrap-pi-orb-oidc.sh. The smoke still mints and verifies against the \
live issuer, and still proves revocation — it does not prove GCP accepts the token."
fi

say "step 1/7: create the project and two orbs"
# Two orbs, booted concurrently so the second costs a VM but almost no wall
# clock. The second one exists because proving "a stopped orb cannot mint"
# needs both a stopped orb and a live orb to call from — and a stopped orb has
# no compute left to be that caller.
create_project "$PROJECT_ID" "$PROJECT_NAME"
create_orb "$PROJECT_ID" "$MINT_ORB"
create_orb "$PROJECT_ID" "$STOPPED_ORB"

say "step 2/7: wait for both orbs to reach running"
smoke_wait_for_state "$MINT_ORB" running "$RUNNING_TIMEOUT" "mint-orb-boot"
smoke_wait_for_state "$STOPPED_ORB" running "$RUNNING_TIMEOUT" "stopped-orb-boot"

say "step 3/7: locate the live compute for each orb"
MINT_INSTANCE=$(orb_instance "$MINT_ORB") ||
  fail "locate-instance" "gcloud could not list instances for $MINT_ORB"
STOPPED_INSTANCE=$(orb_instance "$STOPPED_ORB") ||
  fail "locate-instance" "gcloud could not list instances for $STOPPED_ORB"
[ "$(printf '%s\n' "$MINT_INSTANCE" | wc -w)" -eq 1 ] ||
  fail "locate-instance" "expected exactly one mint instance"
[ "$(printf '%s\n' "$STOPPED_INSTANCE" | wc -w)" -eq 1 ] ||
  fail "locate-instance" "expected exactly one stopped instance"
# The instance name is pi-orb-<orbId>-i<incarnation>; the suffix is the live
# incarnation, and the verifier asserts the token's claim equals it.
MINT_INCARNATION=${MINT_INSTANCE##*-i}
case "$MINT_INCARNATION" in
  "" | *[!0-9]*) fail "locate-instance" "invalid instance incarnation" ;;
esac
say "  mint instance located"
wait_for_ssh "$MINT_INSTANCE"

# Use the already-owned peer, not an optional tailnet client on the CI runner.
preview=$(api "/api/v1/orbs/$STOPPED_ORB" | jget previewHost) || fail "peer-preview" "cannot read preview host"
[[ "$preview" =~ ^[a-zA-Z0-9.-]+$ ]] && [ "${#preview}" -le 253 ] || fail "peer-preview" "invalid or absent preview host"
preview_deadline=$(( $(date +%s) + 60 ))
[ "$preview_deadline" -le "$DEADLINE" ] || preview_deadline=$DEADLINE
preview_response=$(PI_ORB_SMOKE_DEADLINE="$preview_deadline" orb_ssh preview "$MINT_INSTANCE" "sudo python3 - /usr/bin/tailscale '$preview' $(( $(date +%s) + 25 < preview_deadline ? $(date +%s) + 25 : preview_deadline ))" < "$DIR/smoke_preview.py") ||
  fail "peer-preview" "preview probe failed"
preview_code=$(printf '%s\n' "$preview_response" | tail -n1)
preview_body=$(printf '%s\n' "$preview_response" | sed '$d')
[ "$preview_code" = 200 ] && jq -e '.status == "ready"' <<<"$preview_body" >/dev/null 2>&1 ||
  fail "peer-preview" "peer did not return HTTP 200 ready"
say "peer preview health: HTTP 200 ready"

mint() {
  local audience=$1 out=$2
  # The CLI's contract is that stdout carries only the JWT; gcloud's own chatter
  # goes to stderr. Isolating the one JWT-shaped line keeps an ssh banner from
  # silently corrupting the token, and the token is never printed, echoed, or
  # placed in an argument list — only redirected into a mode-0600 file and piped.
  if ! orb_ssh mint "$MINT_INSTANCE" \
    "sudo systemd-run --quiet --pipe --wait --collect --uid=orb --property=EnvironmentFile=/run/pi-orb/environment --setenv=PI_ORB_ID_TOKEN_DIAGNOSTICS=1 /usr/local/bin/pi-orb id-token --audience '$audience'" \
    > "$WORK_DIR/mint.raw"; then
    return 1
  fi
  tr -d '\r' < "$WORK_DIR/mint.raw" |
    grep -E '^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$' | tail -n 1 > "$out" || true
  rm -f "$WORK_DIR/mint.raw"
  [ -s "$out" ]
}

say "step 4/7: mint through the in-orb CLI and verify against the live issuer"
if ! mint "$AUDIENCE" "$WORK_DIR/token"; then
  fail "mint" "the in-orb CLI produced no JWT"
fi
CLAIMS=$(node "$WORK_DIR/verify.js" "$ISSUER_URL" "$AUDIENCE" \
  "$PROJECT_ID" "$MINT_ORB" "$MINT_INCARNATION" \
  < "$WORK_DIR/token") || fail "verify" "the minted token did not verify"
say "  signature and identity verified"

say "step 5/7: exchange through GCP STS and call a read-only API"
if [ "$FEDERATE" != true ]; then
  note "steps 5 (STS exchange, read-only API call, wrong-audience rejection) skipped"
else
  # curl reads its request from a mode-0600 config file so the subject token
  # never enters an argument list.
  sts_exchange() { # sts_exchange <token-file> <out-file> ; prints the HTTP status
    local token status operation=${3:-sts}
    token=$(tr -d '\n' < "$1")
    cat > "$WORK_DIR/sts.conf" <<EOF
url = "https://sts.googleapis.com/v1/token"
header = "content-type: application/json"
data = "{\"audience\":\"$WIF_STS_AUDIENCE\",\"grantType\":\"urn:ietf:params:oauth:grant-type:token-exchange\",\"requestedTokenType\":\"urn:ietf:params:oauth:token-type:access_token\",\"scope\":\"https://www.googleapis.com/auth/cloud-platform\",\"subjectTokenType\":\"urn:ietf:params:oauth:token-type:jwt\",\"subjectToken\":\"$token\"}"
EOF
    status=$(python3 "$DIR/smoke_http.py" external "$operation" "$WORK_DIR/sts.conf" "$2")
    rm -f "$WORK_DIR/sts.conf"
    printf '%s' "$status"
  }

  status=$(sts_exchange "$WORK_DIR/token" "$WORK_DIR/sts.json")
  [ "$status" = "200" ] ||
    fail "sts-exchange" "STS exchange failed"
  federated=$(jget access_token < "$WORK_DIR/sts.json") ||
    fail "sts-exchange" "unparseable STS response"
  [ -n "$federated" ] || fail "sts-exchange" "STS returned no access token"
  say "  STS accepted the pi-orb identity"

  # Narrowly scoped impersonation: the federated principal may only mint tokens
  # for the read-only test account the bootstrap created.
  cat > "$WORK_DIR/impersonate.conf" <<EOF
url = "https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/$WIF_TEST_SA:generateAccessToken"
header = "authorization: Bearer $federated"
header = "content-type: application/json"
data = "{\"scope\":[\"https://www.googleapis.com/auth/cloud-platform\"],\"lifetime\":\"300s\"}"
EOF
  status=$(python3 "$DIR/smoke_http.py" external impersonate "$WORK_DIR/impersonate.conf" "$WORK_DIR/sa.json")
  rm -f "$WORK_DIR/impersonate.conf"
  [ "$status" = "200" ] ||
    fail "impersonate" "impersonation failed"
  sa_token=$(jget accessToken < "$WORK_DIR/sa.json") ||
    fail "impersonate" "unparseable generateAccessToken response"
  [ -n "$sa_token" ] || fail "impersonate" "no access token for $WIF_TEST_SA"
  say "  impersonation succeeded"

  # The acceptance criterion: an authorized read-only API call succeeds, with a
  # credential chain that began inside the orb and contains no stored secret.
  cat > "$WORK_DIR/read.conf" <<EOF
url = "https://cloudresourcemanager.googleapis.com/v1/projects/$PI_ORB_GCP_PROJECT"
header = "authorization: Bearer $sa_token"
EOF
  status=$(python3 "$DIR/smoke_http.py" external read "$WORK_DIR/read.conf" "$WORK_DIR/read.json")
  rm -f "$WORK_DIR/read.conf"
  [ "$status" = "200" ] ||
    fail "read-only-api" "read-only API call failed"
  got=$(jget projectId < "$WORK_DIR/read.json") ||
    fail "read-only-api" "unparseable API response"
  [ "$got" = "$PI_ORB_GCP_PROJECT" ] ||
    fail "read-only-api" "read-only project assertion failed"
  say "  read-only API call succeeded as the federated identity"

  # Negative: a token for another audience must die at STS. The provider's
  # allowed-audience list is the check; nothing downstream ever sees it.
  mint "$WRONG_AUDIENCE" "$WORK_DIR/wrong-token" ||
    fail "wrong-audience" "the CLI refused to mint for a syntactically valid audience"
  status=$(sts_exchange "$WORK_DIR/wrong-token" "$WORK_DIR/wrong-sts.json" sts-negative)
  [ "$status" = "400" ] || fail "wrong-audience" "typed STS audience rejection is unproven"
  say "  STS rejected the wrong-audience token"
  rm -f "$WORK_DIR/wrong-token" "$WORK_DIR/wrong-sts.json"
fi
rm -f "$WORK_DIR/token"

say "step 6/7: prove a stopped orb cannot mint"
# The bearer of the orb about to be stopped, read from its instance metadata —
# the same place the provider injected it. It is transported to the prober orb
# on stdin, so it never appears in an argument list on either machine.
STOPPED_BEARER=$(instance_metadata "$STOPPED_INSTANCE" pi-orb-config | node -e 'let s=""; process.stdin.on("data", c => s += c); process.stdin.on("end", () => { try { process.stdout.write(JSON.parse(s).PI_ORB_RUNTIME_TOKEN ?? ""); } catch { process.stderr.write("invalid instance config\n"); process.exitCode = 3; } })') ||
  fail "read-bearer" "gcloud could not describe $STOPPED_INSTANCE"
[ -n "$STOPPED_BEARER" ] || fail "read-bearer" "no runtime token on $STOPPED_INSTANCE"
# The control plane's URL as orbs see it, straight from the runtime environment the
# provider configured — no assumption about the deployment's topology. The
# `if !` form matters: `pipefail` makes a failed ssh fail the whole pipeline,
# and a plain assignment would abort the script before `fail` could say why.
if ! MINT_ROUTE=$(orb_ssh environment "$MINT_INSTANCE" \
  "sudo systemd-run --quiet --pipe --wait --collect --uid=orb --property=EnvironmentFile=/run/pi-orb/environment /usr/bin/printenv PI_ORB_CONTROL_PLANE_URL" |
  tr -d '\r' | tail -n 1); then
  fail "probe-setup" "could not read the control-plane URL from $MINT_INSTANCE over ssh"
fi
[ -n "$MINT_ROUTE" ] || fail "probe-setup" "could not read the control-plane URL from the orb"
MINT_ROUTE="${MINT_ROUTE%/}/runtime/v1/id-token"

probe() { # probe <bearer> ; prints "<status> <code>"
  printf '%s' "$1" | orb_ssh probe "$MINT_INSTANCE" \
    "sudo -u orb env PI_ORB_SMOKE_DEADLINE=$(( $(date +%s) + 25 < DEADLINE ? $(date +%s) + 25 : DEADLINE )) /usr/local/bin/node -e \"\$(printf %s $PROBE_B64 | base64 -d)\" '$MINT_ROUTE'" |
    tr -d '\r' | tail -n 1
}

if ! result=$(probe "$STOPPED_BEARER"); then
  fail "probe-baseline" "the in-VPC probe could not be run on $MINT_INSTANCE"
fi
case "$result" in
  200*) : ;;
  *) fail "probe-baseline" "running bearer assertion failed" ;;
esac
say "  baseline: the live bearer mints (HTTP 200)"

smoke_command_orb "$STOPPED_ORB" stop
smoke_wait_for_state "$STOPPED_ORB" stopped "$STOPPED_TIMEOUT" "stop-probe-orb"
if ! result=$(probe "$STOPPED_BEARER"); then
  fail "stopped-orb-mint" "the in-VPC probe could not be run on $MINT_INSTANCE"
fi
[ "$result" = "403 not_mintable" ] ||
  fail "stopped-orb-mint" "stopped bearer assertion failed"
say "  a stopped orb is refused: 403 not_mintable"

if ! result=$(probe "$(uuidgen | tr -d '-')$(uuidgen | tr -d '-')"); then
  fail "unknown-bearer" "the in-VPC probe could not be run on $MINT_INSTANCE"
fi
case "$result" in
  401*) : ;;
  *) fail "unknown-bearer" "unknown bearer assertion failed" ;;
esac
say "  an unknown bearer is refused: 401"

say "step 7/7: stop the minting orb and dispose of both"
smoke_command_orb "$MINT_ORB" stop
smoke_wait_for_state "$MINT_ORB" stopped "$STOPPED_TIMEOUT" "stop-mint-orb"

say "Identity assertions passed; verifying fixture deletion."
