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
#   PI_ORB_OPS_URL, PI_ORB_ISSUER_URL     default to the tofu outputs
#   PI_ORB_SMOKE_PROJECT_ID               reuse a fixed pi-orb project (the one
#                                         a project-scoped WIF grant names).
#                                         Creation is idempotent for identical
#                                         content, and a reused project is left
#                                         in place; a generated one is deleted.
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
# Talks to the ops service through api.sh (pi-orb-debug impersonation) and to
# GCE through gcloud, so it needs the same valid credentials as any other
# tooling here. No JWT, bearer, or access token is ever printed: tokens travel
# through pipes and mode-0600 files in a mode-0700 directory removed on exit.
set -euo pipefail
umask 077

DIR=$(cd "$(dirname "$0")" && pwd)
API="$DIR/api.sh"

OVERALL_TIMEOUT=${OVERALL_TIMEOUT:-1800} # 30 minutes, whole run
RUNNING_TIMEOUT=${RUNNING_TIMEOUT:-600}  # 10 minutes per boot
STOPPED_TIMEOUT=${STOPPED_TIMEOUT:-300}  # 5 minutes per stop
SSH_READY_TIMEOUT=${SSH_READY_TIMEOUT:-180} # SSH daemon + metadata key propagation
POLL_INTERVAL=${POLL_INTERVAL:-5}

START_TS=$(date +%s)
DEADLINE=$((START_TS + OVERALL_TIMEOUT))

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
  # Best effort, and never allowed to change the reported status: a smoke that
  # passed must not fail on tidy-up, and a smoke that failed must keep its own
  # first-failure message.
  if [ -n "$MINT_ORB" ]; then "$API" "/api/v1/orbs/$MINT_ORB" '' DELETE >/dev/null 2>&1 || true; fi
  if [ -n "$STOPPED_ORB" ]; then "$API" "/api/v1/orbs/$STOPPED_ORB" '' DELETE >/dev/null 2>&1 || true; fi
  if [ "$PROJECT_IS_DISPOSABLE" = true ] && [ -n "$PROJECT_ID" ]; then
    "$API" "/api/v1/projects/$PROJECT_ID" '' DELETE >/dev/null 2>&1 || true
  fi
  [ -n "$WORK_DIR" ] && rm -rf "$WORK_DIR"
  exit "$status"
}
trap cleanup EXIT

# --- preflight --------------------------------------------------------------

# node is not optional here the way jq is elsewhere: verifying an RS256
# signature against the served JWKS is the point of the mint leg, and a shell
# that cannot do that would be asserting nothing.
for command in curl gcloud node tofu uuidgen; do
  command -v "$command" >/dev/null 2>&1 ||
    fail "preflight" "missing required command '$command'"
done

: "${PI_ORB_GCP_PROJECT:?required}"
: "${PI_ORB_GCE_ZONE:?required}"

# `set -e` makes a failing command substitution abort the script *silently* at
# the assignment, before the diagnostic that explains it can run — so every
# assignment whose failure the operator must understand uses the `if !` form.
if [ -z "${PI_ORB_OPS_URL:-}" ]; then
  if ! PI_ORB_OPS_URL=$(cd "$DIR" && tofu output -raw ops_url); then
    fail "preflight" "no ops URL (set PI_ORB_OPS_URL, or make 'tofu output -raw ops_url' readable)"
  fi
fi
export PI_ORB_OPS_URL
[ -n "$PI_ORB_OPS_URL" ] || fail "preflight" "the ops URL is empty"

ISSUER_URL=${PI_ORB_ISSUER_URL:-}
if [ -z "$ISSUER_URL" ]; then
  if ! ISSUER_URL=$(cd "$DIR" && tofu output -raw issuer_url); then
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
# Same degradation as smoke.sh: python3 first (macOS ships it), jq as fallback.
if command -v python3 >/dev/null 2>&1; then
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
elif command -v jq >/dev/null 2>&1; then
  jget() {
    local doc
    doc=$(cat)
    printf '%s' "$doc" | jq -e . >/dev/null 2>&1 || return 3
    printf '%s' "$doc" | jq -r --arg p "$1" '
      ($p | split(".")) as $path
      | (getpath($path) // "")
      | if type == "object" or type == "array" then tojson else tostring end
    ' 2>/dev/null || return 3
  }
else
  fail "preflight" "needs python3 or jq to parse JSON responses"
fi

api() { # api <path> [json-body] [method]
  "$API" "$1" "${2-}" "${3-}"
}

# --- helper programs --------------------------------------------------------

# Local verifier: exactly the checks docs/workload-identity.md requires of a
# relying party, run against the *deployed* issuer rather than a fixture. The
# JWT arrives on stdin and never appears in argv, output, or a file.
cat > "$WORK_DIR/verify.js" <<'VERIFY_JS'
const { createPublicKey, createVerify } = require("node:crypto");

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

const getJson = async (url) => {
  const response = await fetch(url);
  if (!response.ok) fail(`GET ${url} answered ${response.status}`);
  return await response.json();
};

(async () => {
  const jwt = await read();
  const parts = jwt.split(".");
  if (parts.length !== 3) fail("stdin did not carry a three-part JWT");
  const header = decode(parts[0]);
  const claims = decode(parts[1]);

  // 1. Discovery is fetched from the configured issuer origin, and must claim
  //    to be that issuer. A document naming someone else is a misconfiguration
  //    a verifier must never follow.
  const discovery = await getJson(`${issuer}/.well-known/openid-configuration`);
  if (discovery.issuer !== issuer) fail(`discovery issuer ${discovery.issuer} != ${issuer}`);
  if (!String(discovery.jwks_uri).startsWith(issuer)) {
    fail(`jwks_uri ${discovery.jwks_uri} is not under the issuer origin`);
  }
  if (!(discovery.id_token_signing_alg_values_supported || []).includes("RS256")) {
    fail("discovery does not advertise RS256");
  }

  // 2. Signature, by `kid`, against the served key set.
  if (header.alg !== "RS256") fail(`unexpected alg ${header.alg}`);
  if (!header.kid) fail("no kid in the JWT header");
  const jwks = await getJson(discovery.jwks_uri);
  const jwk = (jwks.keys || []).find((key) => key.kid === header.kid);
  if (!jwk) fail(`kid ${header.kid} is not published in the JWKS`);
  const verifier = createVerify("RSA-SHA256");
  verifier.update(`${parts[0]}.${parts[1]}`);
  const signature = Buffer.from(parts[2].replace(/-/g, "+").replace(/_/g, "/"), "base64");
  if (!verifier.verify(createPublicKey({ key: jwk, format: "jwk" }), signature)) {
    fail("signature does not verify against the published key");
  }

  // 3. The claim rules a relying party owns. `iss`/`aud` exactly; a live
  //    lifetime; the workload token class; and the immutable pi-orb identity
  //    the caller could not have chosen — project, orb, and the compute
  //    incarnation, each cross-checked against what the control plane and GCE
  //    say the minting orb actually is. Asserting a claim is merely *present*
  //    would pass for any orb of the deployment, which is precisely the
  //    authorization mistake the recipes warn about.
  const now = Math.floor(Date.now() / 1000);
  const skew = 60;
  if (claims.iss !== issuer) fail(`iss ${claims.iss} != ${issuer}`);
  if (claims.aud !== audience) fail(`aud ${claims.aud} != ${audience}`);
  if (claims.token_use !== "exchanged") fail(`token_use ${claims.token_use} != exchanged`);
  if (!(claims.iat <= now + skew)) fail("iat is in the future");
  if (!(claims.exp > now - skew)) fail("token is already expired");
  if (claims.exp - claims.iat > 3600) fail("lifetime exceeds the documented maximum");
  if (claims.sub !== orbId) fail(`sub ${claims.sub} != ${orbId}`);
  if (claims.orb_id !== orbId) fail(`orb_id ${claims.orb_id} != ${orbId}`);
  if (String(claims.host_incarnation) !== incarnation) {
    fail(`host_incarnation ${claims.host_incarnation} != live incarnation ${incarnation}`);
  }
  if (claims.project_id !== projectId) fail(`project_id ${claims.project_id} != ${projectId}`);
  if (!claims.jti) fail("no jti claim");
  if (claims.user_id || claims.email) fail("the token carries a user identity it must not have");

  // Claims only — never the token.
  process.stdout.write(
    JSON.stringify({
      kid: header.kid,
      project_id: claims.project_id,
      orb_id: claims.orb_id,
      host_incarnation: claims.host_incarnation,
      ttl_seconds: claims.exp - claims.iat,
    }) + "\n",
  );
})().catch((error) => fail(String(error)));
VERIFY_JS

# Remote probe, run *inside another live orb* because the runtime service has
# internal ingress and is unreachable from this machine. The bearer under test
# arrives on stdin; the mint URL is its only argument. Prints "<status> <code>".
#
# The mint route's error envelope is `{"error":"not_mintable"}` — the code *is*
# the `error` field, a bare string (packages/protocol/src/workload-identity.ts).
# It is not the `{"error":{"code":...}}` shape the browser API uses, and reading
# `.error.code` here silently printed an empty code for every refusal, so the
# step-6 assertion could never match and the release gate could never pass.
cat > "$WORK_DIR/probe.js" <<'PROBE_JS'
let bearer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => (bearer += chunk));
process.stdin.on("end", async () => {
  const response = await fetch(process.argv[1], {
    method: "POST",
    headers: { authorization: `Bearer ${bearer.trim()}`, "content-type": "application/json" },
    body: JSON.stringify({ audience: "urn:pi-orb-smoke:revocation-probe" }),
  });
  const body = await response.json().catch(() => ({}));
  const code = typeof body.error === "string" ? body.error : "";
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
  response=$(api /api/v1/projects \
    "$(printf '{"id":"%s","name":"%s","repositoryUrl":"%s"}' \
      "$pid" "$name" "https://github.com/octocat/Hello-World")") ||
    fail "create-project" "api.sh failed"
  got=$(printf '%s' "$response" | jget id) ||
    fail "create-project" "unparseable response: $response"
  [ "$got" = "$pid" ] || fail "create-project" "unexpected response: $response"
}

create_orb() {
  local pid=$1 oid=$2 response got
  response=$(api "/api/v1/projects/$pid/orbs" "$(printf '{"id":"%s"}' "$oid")") ||
    fail "create-orb" "api.sh failed"
  got=$(printf '%s' "$response" | jget id) ||
    fail "create-orb" "unparseable response: $response"
  [ "$got" = "$oid" ] || fail "create-orb" "unexpected response: $response"
  say "orb created: $oid"
}

# wait_for_state <orb> <target> <timeout> <step>
wait_for_state() {
  local oid=$1 target=$2 timeout=$3 step=$4
  local limit=$(($(date +%s) + timeout))
  local last="" view state
  while :; do
    check_deadline "$step"
    view=$(api "/api/v1/orbs/$oid") || fail "$step" "api.sh failed while polling"
    state=$(printf '%s' "$view" | jget state) ||
      fail "$step" "unparseable orb view: $view"
    [ -n "$state" ] || fail "$step" "orb view carried no state: $view"
    if [ "$state" != "$last" ]; then
      say "  $oid: $state"
      last=$state
    fi
    case "$state" in
      "$target") return 0 ;;
      failed)
        fail "$step" "orb $oid failed; lastError: $(printf '%s' "$view" | jget lastError)"
        ;;
    esac
    if [ "$(date +%s)" -ge "$limit" ]; then
      fail "$step" "orb $oid stuck in '$state' after ${timeout}s (wanted '$target')"
    fi
    sleep "$POLL_INTERVAL"
  done
}

command_orb() { # command_orb <orb> <start|stop>
  local oid=$1 verb=$2 response err
  response=$(api "/api/v1/orbs/$oid/$verb" '{}') ||
    fail "$verb-orb" "api.sh failed"
  err=$(printf '%s' "$response" | jget error.code) ||
    fail "$verb-orb" "unparseable response: $response"
  [ -z "$err" ] || fail "$verb-orb" "control plane refused $verb: $response"
}

# --- GCE steps --------------------------------------------------------------

orb_instance() { # the one live instance of an orb, by label
  gcloud compute instances list --project "$PI_ORB_GCP_PROJECT" \
    --filter="zone:($PI_ORB_GCE_ZONE) AND labels.pi-orb-orb-id=$1" \
    --format='value(name)'
}

instance_metadata() { # instance_metadata <instance> <key>
  gcloud compute instances describe "$1" --project "$PI_ORB_GCP_PROJECT" \
    --zone "$PI_ORB_GCE_ZONE" \
    --format=json |
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
    process.stderr.write(`instance metadata: duplicate key ${key}\n`);
    process.exitCode = 3;
    return;
  }
  if (matches.length === 1 && matches[0].value != null) {
    process.stdout.write(String(matches[0].value));
  }
});
' "$2"
}

orb_ssh() { # orb_ssh <instance> <remote command>; stdin is forwarded
  # shellcheck disable=SC2086  # PI_ORB_SMOKE_SSH_FLAGS is a deliberate word list
  gcloud compute ssh "$1" --project "$PI_ORB_GCP_PROJECT" \
    --zone "$PI_ORB_GCE_ZONE" --tunnel-through-iap --quiet \
    ${PI_ORB_SMOKE_SSH_FLAGS:-} -- "$2"
}

wait_for_ssh() { # wait_for_ssh <instance>
  local instance=$1
  local limit=$(( $(date +%s) + SSH_READY_TIMEOUT ))
  local attempt=0
  local attempt_error="$WORK_DIR/ssh-ready-attempt.err"
  local first_error="$WORK_DIR/ssh-ready-first.err"
  local last_error="$WORK_DIR/ssh-ready-last.err"

  say "waiting for SSH through IAP on $instance (<= ${SSH_READY_TIMEOUT}s)"
  while :; do
    check_deadline "ssh-ready"
    attempt=$((attempt + 1))
    if orb_ssh "$instance" true </dev/null >/dev/null 2> "$attempt_error"; then
      say "  SSH ready after $attempt attempt(s)"
      return 0
    fi
    if [ "$attempt" -eq 1 ]; then cp "$attempt_error" "$first_error"; fi
    cp "$attempt_error" "$last_error"
    if [ "$(date +%s)" -ge "$limit" ]; then
      echo "first SSH attempt diagnostic:" >&2
      sed 's/^/  /' "$first_error" >&2
      echo "last SSH attempt diagnostic:" >&2
      sed 's/^/  /' "$last_error" >&2
      fail "ssh-ready" "SSH through IAP did not become ready after ${SSH_READY_TIMEOUT}s"
    fi
    sleep "$POLL_INTERVAL"
  done
}

# --- run --------------------------------------------------------------------

PROJECT_ID=${PI_ORB_SMOKE_PROJECT_ID:-$(uuidgen | tr '[:upper:]' '[:lower:]')}
# A supplied project id is the one a project-scoped WIF grant names, so it is
# reused rather than recreated. Its name must then be stable too: project
# creation is idempotent only for *identical* content, and a timestamped name
# would turn every rerun into a 409.
PROJECT_NAME="wif-smoke"
if [ -n "${PI_ORB_SMOKE_PROJECT_ID:-}" ]; then
  PROJECT_IS_DISPOSABLE=false
else
  PROJECT_NAME="wif-smoke-$(date -u +%Y%m%d-%H%M%S)"
fi
MINT_ORB=$(uuidgen | tr '[:upper:]' '[:lower:]')
STOPPED_ORB=$(uuidgen | tr '[:upper:]' '[:lower:]')

say "workload-identity smoke against $PI_ORB_OPS_URL"
say "issuer $ISSUER_URL, audience $AUDIENCE"
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
# needs both a stopped orb and a caller inside the VPC — and a stopped orb has
# no compute left to be that caller.
create_project "$PROJECT_ID" "$PROJECT_NAME"
create_orb "$PROJECT_ID" "$MINT_ORB"
create_orb "$PROJECT_ID" "$STOPPED_ORB"

say "step 2/7: wait for both orbs to reach running"
wait_for_state "$MINT_ORB" running "$RUNNING_TIMEOUT" "mint-orb-boot"
wait_for_state "$STOPPED_ORB" running "$RUNNING_TIMEOUT" "stopped-orb-boot"

say "step 3/7: locate the live compute for each orb"
MINT_INSTANCE=$(orb_instance "$MINT_ORB") ||
  fail "locate-instance" "gcloud could not list instances for $MINT_ORB"
STOPPED_INSTANCE=$(orb_instance "$STOPPED_ORB") ||
  fail "locate-instance" "gcloud could not list instances for $STOPPED_ORB"
[ "$(printf '%s\n' "$MINT_INSTANCE" | wc -w)" -eq 1 ] ||
  fail "locate-instance" "expected exactly one instance for $MINT_ORB, got '$MINT_INSTANCE'"
[ "$(printf '%s\n' "$STOPPED_INSTANCE" | wc -w)" -eq 1 ] ||
  fail "locate-instance" "expected exactly one instance for $STOPPED_ORB, got '$STOPPED_INSTANCE'"
# The instance name is pi-orb-<orbId>-i<incarnation>; the suffix is the live
# incarnation, and the verifier asserts the token's claim equals it.
MINT_INCARNATION=${MINT_INSTANCE##*-i}
case "$MINT_INCARNATION" in
  "" | *[!0-9]*) fail "locate-instance" "cannot read an incarnation from '$MINT_INSTANCE'" ;;
esac
say "  minting from $MINT_INSTANCE (incarnation $MINT_INCARNATION)"
wait_for_ssh "$MINT_INSTANCE"

mint() { # mint <audience> <out-file>
  local audience=$1 out=$2
  # The CLI's contract is that stdout carries only the JWT; gcloud's own chatter
  # goes to stderr. Isolating the one JWT-shaped line keeps an ssh banner from
  # silently corrupting the token, and the token is never printed, echoed, or
  # placed in an argument list — only redirected into a mode-0600 file and piped.
  if ! orb_ssh "$MINT_INSTANCE" \
    "sudo docker exec pi-orb-runtime pi-orb id-token --audience '$audience'" \
    > "$WORK_DIR/mint.raw" 2> "$WORK_DIR/mint.err"; then
    return 1
  fi
  tr -d '\r' < "$WORK_DIR/mint.raw" |
    grep -E '^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$' | tail -n 1 > "$out" || true
  rm -f "$WORK_DIR/mint.raw"
  [ -s "$out" ]
}

say "step 4/7: mint through the in-orb CLI and verify against the live issuer"
if ! mint "$AUDIENCE" "$WORK_DIR/token"; then
  echo "in-orb mint diagnostic:" >&2
  sed 's/^/  /' "$WORK_DIR/mint.err" >&2
  fail "mint" "the in-orb CLI produced no JWT"
fi
CLAIMS=$(node "$WORK_DIR/verify.js" "$ISSUER_URL" "$AUDIENCE" \
  "$PROJECT_ID" "$MINT_ORB" "$MINT_INCARNATION" \
  < "$WORK_DIR/token") || fail "verify" "the minted token did not verify against $ISSUER_URL"
say "  verified: $CLAIMS"

say "step 5/7: exchange through GCP STS and call a read-only API"
if [ "$FEDERATE" != true ]; then
  note "steps 5 (STS exchange, read-only API call, wrong-audience rejection) skipped"
else
  # The exchange itself. curl reads its request from a mode-0600 config file so
  # the subject token never enters an argument list.
  sts_exchange() { # sts_exchange <token-file> <out-file> ; prints the HTTP status
    local token status
    token=$(tr -d '\n' < "$1")
    cat > "$WORK_DIR/sts.conf" <<EOF
url = "https://sts.googleapis.com/v1/token"
header = "content-type: application/json"
data = "{\"audience\":\"$WIF_STS_AUDIENCE\",\"grantType\":\"urn:ietf:params:oauth:grant-type:token-exchange\",\"requestedTokenType\":\"urn:ietf:params:oauth:token-type:access_token\",\"scope\":\"https://www.googleapis.com/auth/cloud-platform\",\"subjectTokenType\":\"urn:ietf:params:oauth:token-type:jwt\",\"subjectToken\":\"$token\"}"
EOF
    # `|| true`: a transport failure must reach the caller as the status `000`
    # curl already prints, not abort the script at this assignment under `set
    # -e` before any diagnostic runs. Every caller distinguishes 000 explicitly.
    status=$(curl -s -K "$WORK_DIR/sts.conf" -o "$2" -w '%{http_code}' || true)
    rm -f "$WORK_DIR/sts.conf"
    printf '%s' "$status"
  }

  status=$(sts_exchange "$WORK_DIR/token" "$WORK_DIR/sts.json")
  [ "$status" = "200" ] ||
    fail "sts-exchange" "STS refused the pi-orb token: HTTP $status $(cat "$WORK_DIR/sts.json")"
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
  status=$(curl -s -K "$WORK_DIR/impersonate.conf" -o "$WORK_DIR/sa.json" -w '%{http_code}' || true)
  rm -f "$WORK_DIR/impersonate.conf"
  [ "$status" = "200" ] ||
    fail "impersonate" "generateAccessToken answered HTTP $status $(cat "$WORK_DIR/sa.json")"
  sa_token=$(jget accessToken < "$WORK_DIR/sa.json") ||
    fail "impersonate" "unparseable generateAccessToken response"
  [ -n "$sa_token" ] || fail "impersonate" "no access token for $WIF_TEST_SA"
  say "  impersonated $WIF_TEST_SA"

  # The acceptance criterion: an authorized read-only API call succeeds, with a
  # credential chain that began inside the orb and contains no stored secret.
  cat > "$WORK_DIR/read.conf" <<EOF
url = "https://cloudresourcemanager.googleapis.com/v1/projects/$PI_ORB_GCP_PROJECT"
header = "authorization: Bearer $sa_token"
EOF
  status=$(curl -s -K "$WORK_DIR/read.conf" -o "$WORK_DIR/read.json" -w '%{http_code}' || true)
  rm -f "$WORK_DIR/read.conf"
  [ "$status" = "200" ] ||
    fail "read-only-api" "the read-only API call answered HTTP $status $(cat "$WORK_DIR/read.json")"
  got=$(jget projectId < "$WORK_DIR/read.json") ||
    fail "read-only-api" "unparseable API response"
  [ "$got" = "$PI_ORB_GCP_PROJECT" ] ||
    fail "read-only-api" "read back project '$got', expected '$PI_ORB_GCP_PROJECT'"
  say "  read-only API call succeeded as the federated identity"

  # Negative: a token for another audience must die at STS. The provider's
  # allowed-audience list is the check; nothing downstream ever sees it.
  mint "$WRONG_AUDIENCE" "$WORK_DIR/wrong-token" ||
    fail "wrong-audience" "the CLI refused to mint for a syntactically valid audience"
  status=$(sts_exchange "$WORK_DIR/wrong-token" "$WORK_DIR/wrong-sts.json")
  # This is the only negative federation assertion, so it must be an explicit
  # rejection *by STS*. "anything that is not 200" also accepts curl's `000`
  # transport failure, which would report a DNS blip or a proxy hiccup as proof
  # that the audience check works — the one thing this step exists to prove.
  case "$status" in
    4??) ;;
    200) fail "wrong-audience" "STS accepted a token minted for '$WRONG_AUDIENCE'" ;;
    000)
      fail "wrong-audience" \
        "could not reach STS at all (curl transport failure); the audience rejection is unproven"
      ;;
    *)
      fail "wrong-audience" \
        "expected a 4xx rejection of '$WRONG_AUDIENCE' from STS, got HTTP $status $(cat "$WORK_DIR/wrong-sts.json")"
      ;;
  esac
  say "  STS rejected the wrong-audience token (HTTP $status)"
  rm -f "$WORK_DIR/wrong-token" "$WORK_DIR/wrong-sts.json"
fi
rm -f "$WORK_DIR/token"

say "step 6/7: prove a stopped orb cannot mint"
# The bearer of the orb about to be stopped, read from its instance metadata —
# the same place the provider injected it. It is transported to the prober orb
# on stdin, so it never appears in an argument list on either machine.
STOPPED_BEARER=$(instance_metadata "$STOPPED_INSTANCE" pi-orb-runtime-token) ||
  fail "read-bearer" "gcloud could not describe $STOPPED_INSTANCE"
[ -n "$STOPPED_BEARER" ] || fail "read-bearer" "no runtime token on $STOPPED_INSTANCE"
# The runtime service's URL as orbs see it, straight from the container the
# provider configured — no assumption about the deployment's topology. The
# `if !` form matters: `pipefail` makes a failed ssh fail the whole pipeline,
# and a plain assignment would abort the script before `fail` could say why.
if ! MINT_ROUTE=$(orb_ssh "$MINT_INSTANCE" \
  "sudo docker exec pi-orb-runtime printenv PI_ORB_CONTROL_PLANE_URL" 2>/dev/null |
  tr -d '\r' | tail -n 1); then
  fail "probe-setup" "could not read the control-plane URL from $MINT_INSTANCE over ssh"
fi
[ -n "$MINT_ROUTE" ] || fail "probe-setup" "could not read the control-plane URL from the orb"
MINT_ROUTE="${MINT_ROUTE%/}/runtime/v1/id-token"

probe() { # probe <bearer> ; prints "<status> <code>"
  printf '%s' "$1" | orb_ssh "$MINT_INSTANCE" \
    "sudo docker exec -i pi-orb-runtime node -e \"\$(printf %s $PROBE_B64 | base64 -d)\" '$MINT_ROUTE'" |
    tr -d '\r' | tail -n 1
}

if ! result=$(probe "$STOPPED_BEARER"); then
  fail "probe-baseline" "the in-VPC probe could not be run on $MINT_INSTANCE"
fi
case "$result" in
  200*) : ;;
  *) fail "probe-baseline" "a running orb's own bearer did not mint: $result" ;;
esac
say "  baseline: the live bearer mints (HTTP 200)"

command_orb "$STOPPED_ORB" stop
wait_for_state "$STOPPED_ORB" stopped "$STOPPED_TIMEOUT" "stop-probe-orb"
if ! result=$(probe "$STOPPED_BEARER"); then
  fail "stopped-orb-mint" "the in-VPC probe could not be run on $MINT_INSTANCE"
fi
[ "$result" = "403 not_mintable" ] ||
  fail "stopped-orb-mint" "expected '403 not_mintable' after the stop, got '$result'"
say "  a stopped orb is refused: $result"

if ! result=$(probe "$(uuidgen | tr -d '-')$(uuidgen | tr -d '-')"); then
  fail "unknown-bearer" "the in-VPC probe could not be run on $MINT_INSTANCE"
fi
case "$result" in
  401*) : ;;
  *) fail "unknown-bearer" "expected 401 for an unknown bearer, got '$result'" ;;
esac
say "  an unknown bearer is refused: $result"

say "step 7/7: stop the minting orb and dispose of both"
command_orb "$MINT_ORB" stop
wait_for_state "$MINT_ORB" stopped "$STOPPED_TIMEOUT" "stop-mint-orb"

echo
echo "WORKLOAD-IDENTITY SMOKE PASSED in $(($(date +%s) - START_TS))s"
echo "  issuer:      $ISSUER_URL"
echo "  audience:    $AUDIENCE"
echo "  claims:      $CLAIMS"
if [ "$FEDERATE" = true ]; then
  echo "  federation:  STS + $WIF_TEST_SA + a read-only API call all succeeded"
else
  echo "  federation:  SKIPPED (no WIF tier configured)"
fi
echo "  cleanup:     both orbs are deleted on exit$([ "$PROJECT_IS_DISPOSABLE" = true ] && echo ", along with the project")"
