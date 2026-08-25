#!/usr/bin/env bash
# One-time, idempotent bootstrap of the GCP Workload Identity Federation tier
# that trusts *pi-orb's own* OIDC issuer (docs/workload-identity.md,
# "Federation integrations"). Run it with an existing project administrator
# identity; ordinary releases never invoke it.
#
# This lives outside the recurring OpenTofu root for the same reason
# `bootstrap-amp-oidc.sh` does (docs/deployment.md, "Amp-orb deployment
# identity"): a trust boundary must not be creatable, mutable, or destroyable by
# the routine plan that runs *using* it. Keeping the pool, the provider, and the
# test grant out of the plan means a bad apply cannot delete the thing that
# admits callers, and an operator reviewing a release plan never has to reason
# about whether it moved the federation trust.
#
# No resource here is ever deleted: pool, provider, and service account are
# created when absent and converged when present. The one thing the script does
# remove is a binding it previously created itself — a workload-identity
# admission from this pool, or a project role on its own test account, that the
# scope it was just given no longer covers. That is not destruction, it is what
# makes "the scope you asked for" true; `add-iam-policy-binding` alone would
# leave every past, broader grant standing. `--dry-run` lists those removals.
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: [VAR=... ...] ./infra/bootstrap-pi-orb-oidc.sh [--dry-run]

Creates (or converges) a workload-identity pool and OIDC provider trusting the
pi-orb issuer, plus a dedicated read-only test service account for the
federation smoke.

Required:
  PI_ORB_ISSUER_URL         Public issuer origin, exactly as minted tokens carry
                            it in `iss`. Defaults to `tofu -chdir=infra output
                            -raw issuer_url` when that state is reachable.

Authorization scope — set at least one, or the script refuses:
  PI_ORB_TRUSTED_PROJECT_ID pi-orb *project* ID (UUID) admitted by this
                            provider. The project-wide grant.
  PI_ORB_TRUSTED_ORB_ID     pi-orb *orb* ID (UUID). Narrows admission to one
                            orb; combine with the project ID for both.
  ALLOW_ANY_ORB=1           Explicit, deliberate escape hatch: admit every orb
                            of this pi-orb deployment. The audience is NOT an
                            authorization boundary — any orb can ask for any
                            audience — so this grants every orb whatever the
                            test service account can do.

Optional:
  PROJECT                   GCP project (default playground-dev-6ae7)
  AUDIENCE                  Allowed audience the workload must request
                            (default urn:pi-orb:gcp:<PROJECT>)
  POOL                      Pool id (default pi-orb-orbs)
  PROVIDER                  Provider id (default pi-orb-oidc)
  TEST_SA                   Read-only test account id (default pi-orb-oidc-test)
  TEST_SA_ROLE              Role granted to it (default roles/browser — project
                            metadata reads only, no data access, no mutations)
  --dry-run                 Print the planned identifiers and exit.

Re-running with different values converges the provider's audience, attribute
mapping, and attribute condition, and reconciles the two IAM bindings this
script owns: a previous, broader admission (including an ALLOW_ANY_ORB=1 pool
wildcard) and a previous TEST_SA_ROLE are revoked rather than left standing
beside the new ones. Nothing else in the project is touched. The issuer URI
cannot be changed after creation: pointing this pool at a different issuer is a
trust migration and the script refuses to do it silently.
EOF
}

DRY_RUN=false
while [ "$#" -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=true ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      echo "unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
  shift
done

PROJECT=${PROJECT:-playground-dev-6ae7}
POOL=${POOL:-pi-orb-orbs}
PROVIDER=${PROVIDER:-pi-orb-oidc}
TEST_SA=${TEST_SA:-pi-orb-oidc-test}
TEST_SA_ROLE=${TEST_SA_ROLE:-roles/browser}
AUDIENCE=${AUDIENCE:-urn:pi-orb:gcp:$PROJECT}
TRUSTED_PROJECT_ID=${PI_ORB_TRUSTED_PROJECT_ID:-}
TRUSTED_ORB_ID=${PI_ORB_TRUSTED_ORB_ID:-}
ALLOW_ANY_ORB=${ALLOW_ANY_ORB:-}

for command in gcloud; do
  command -v "$command" >/dev/null 2>&1 || {
    echo "bootstrap failed: missing required command '$command'" >&2
    exit 1
  }
done

ISSUER_URL=${PI_ORB_ISSUER_URL:-}
if [ -z "$ISSUER_URL" ]; then
  DIR=$(cd "$(dirname "$0")" && pwd)
  ISSUER_URL=$(tofu -chdir="$DIR" output -raw issuer_url 2>/dev/null || true)
fi
if [ -z "$ISSUER_URL" ]; then
  echo "bootstrap failed: PI_ORB_ISSUER_URL is required (and no issuer_url output was readable)" >&2
  exit 2
fi
case "$ISSUER_URL" in
  https://*) ;;
  *)
    echo "bootstrap failed: the issuer URL must be https (got '$ISSUER_URL')" >&2
    exit 2
    ;;
esac
case "$ISSUER_URL" in
  */)
    echo "bootstrap failed: the issuer URL must have no trailing slash — it is compared exactly" >&2
    exit 2
    ;;
esac

if [ -z "$TRUSTED_PROJECT_ID" ] && [ -z "$TRUSTED_ORB_ID" ] && [ "$ALLOW_ANY_ORB" != "1" ]; then
  echo "bootstrap failed: no authorization scope given" >&2
  echo "  The audience is not an authorization boundary: every orb of this" >&2
  echo "  deployment can request every audience. Set PI_ORB_TRUSTED_PROJECT_ID" >&2
  echo "  and/or PI_ORB_TRUSTED_ORB_ID, or pass ALLOW_ANY_ORB=1 deliberately." >&2
  exit 2
fi

# The attribute condition is the provider-side half of authorization. Two things
# always hold: the token must be a pi-orb workload-exchange token, and it must
# name a pi-orb identity this pool was told to trust. Immutable control-plane
# IDs only — never a name, repository, or anything a workload can influence.
condition="assertion.token_use == 'exchanged'"
if [ -n "$TRUSTED_PROJECT_ID" ]; then
  condition="$condition && assertion.project_id == '$TRUSTED_PROJECT_ID'"
fi
if [ -n "$TRUSTED_ORB_ID" ]; then
  condition="$condition && assertion.orb_id == '$TRUSTED_ORB_ID'"
fi

# `google.subject` is the orb ID (the token's `sub`), so it is what shows up as
# the delegated principal in Cloud Audit Logs — the provider-side correlation
# back to one pi-orb orb the observability requirements ask for. The three
# custom attributes are what IAM conditions and principalSets can bind to.
#
# `host_incarnation` is a JSON *number* in the token, and every mapped attribute
# must evaluate to a STRING: GCP evaluates the whole mapping on every exchange,
# so an unconverted number fails *all* exchanges with "The mapped attribute must
# be of type STRING", including ones no policy scopes by incarnation. `string()`
# is the CEL conversion the mapping language provides. The attribute *condition*
# below needs no such cast: it compares `assertion.*` values, not mapped ones.
mapping='google.subject=assertion.sub'
mapping="$mapping,attribute.project_id=assertion.project_id"
mapping="$mapping,attribute.orb_id=assertion.orb_id"
mapping="$mapping,attribute.host_incarnation=string(assertion.host_incarnation)"

TEST_SA_EMAIL="$TEST_SA@$PROJECT.iam.gserviceaccount.com"

# Read, not written — so a `--dry-run` resolves it too, and can therefore show
# the real principalSet and the real list of bindings a run would revoke. Only
# an actual run insists on succeeding; a dry run without credentials degrades to
# the `<project-number>` placeholder and reports what it could not inspect.
project_number=$(gcloud projects describe "$PROJECT" --format='value(projectNumber)' 2>/dev/null || true)
case "$project_number" in
  "" | *[!0-9]*)
    if [ "$DRY_RUN" != true ]; then
      echo "bootstrap failed: could not resolve the numeric project number for $PROJECT" >&2
      exit 1
    fi
    project_number=""
    ;;
esac

pool_root="projects/${project_number:-<project-number>}/locations/global/workloadIdentityPools/$POOL"
# The narrowest principalSet the given scope allows. One orb beats one project;
# the whole pool is only reachable through the explicit escape hatch above.
if [ -n "$TRUSTED_ORB_ID" ]; then
  principal_set="principalSet://iam.googleapis.com/$pool_root/attribute.orb_id/$TRUSTED_ORB_ID"
elif [ -n "$TRUSTED_PROJECT_ID" ]; then
  principal_set="principalSet://iam.googleapis.com/$pool_root/attribute.project_id/$TRUSTED_PROJECT_ID"
else
  principal_set="principalSet://iam.googleapis.com/$pool_root/*"
fi

# --- reconciling the two bindings this script owns ---------------------------
#
# `add-iam-policy-binding` is additive, and that is a trap for a script whose
# whole purpose is to express a scope: re-running with a *narrower* scope prints
# the narrow principalSet as `admitted:` while the previous, broader grant —
# a project-wide set, or the `ALLOW_ANY_ORB=1` pool wildcard — silently survives
# on the test account, so the deployment stays as open as its most generous
# past run. The same holds for TEST_SA_ROLE at the project level: switching to a
# narrower role leaves the old one bound beside it.
#
# So the requested scope is *reconciled*, not merely added. Both queries stay
# strictly inside this script's own two bindings: `roles/iam.workloadIdentityUser`
# members from *this* pool on the test account, and project roles held by the
# test account, which exists for nothing else. No other member, role, resource,
# or conditional binding is ever touched, and nothing is deleted anywhere else.

stale_admissions() { # principalSets from this pool that the requested scope does not cover
  [ -n "$project_number" ] || return 0
  # Not created yet on a first run: nothing to reconcile. Under pipefail a failed
  # policy read would otherwise abort the script before it prints its plan.
  gcloud iam service-accounts describe "$TEST_SA_EMAIL" --project="$PROJECT" >/dev/null 2>&1 || return 0
  gcloud iam service-accounts get-iam-policy "$TEST_SA_EMAIL" \
    --project="$PROJECT" --flatten='bindings[].members' \
    --filter='bindings.role=roles/iam.workloadIdentityUser' \
    --format='value(bindings.members)' 2>/dev/null |
    while read -r member; do
      case "$member" in
        "$principal_set") ;;
        "principalSet://iam.googleapis.com/$pool_root/"*) printf '%s\n' "$member" ;;
      esac
    done
}

stale_test_sa_roles() { # project roles on the test account other than the requested one
  gcloud projects get-iam-policy "$PROJECT" --flatten='bindings[].members' \
    --filter="bindings.members:$TEST_SA_EMAIL" \
    --format='value(bindings.role,bindings.members)' 2>/dev/null |
    while IFS=$'\t' read -r role member; do
      [ "$member" = "serviceAccount:$TEST_SA_EMAIL" ] || continue
      [ "$role" = "$TEST_SA_ROLE" ] || printf '%s\n' "$role"
    done
}

stale_members=$(stale_admissions)
stale_roles=$(stale_test_sa_roles)
revoking="(none)"
if [ -n "$stale_members" ] || [ -n "$stale_roles" ]; then
  revoking=$(printf '%s\n%s' "$stale_members" "$stale_roles" | sed '/^$/d' | sed '2,$s/^/                    /')
fi

cat >&2 <<EOF
bootstrap plan
  gcp project:      $PROJECT
  issuer:           $ISSUER_URL
  audience:         $AUDIENCE
  pool / provider:  $POOL / $PROVIDER
  attribute cond.:  $condition
  attribute map:    $mapping
  test account:     $TEST_SA_EMAIL ($TEST_SA_ROLE)
  admitted:         $principal_set
  revoking:         $revoking
EOF
if [ -z "$project_number" ]; then
  echo "bootstrap: could not read $PROJECT's policies; the revoking list above is incomplete" >&2
fi
if [ "$DRY_RUN" = true ]; then
  echo "bootstrap: --dry-run, nothing was changed" >&2
  exit 0
fi

gcloud services enable \
  iam.googleapis.com iamcredentials.googleapis.com sts.googleapis.com \
  cloudresourcemanager.googleapis.com \
  --project="$PROJECT" --quiet

if ! gcloud iam workload-identity-pools describe "$POOL" \
  --project="$PROJECT" --location=global >/dev/null 2>&1; then
  gcloud iam workload-identity-pools create "$POOL" \
    --project="$PROJECT" --location=global --display-name='pi-orb orbs' \
    --description='Keyless access from admitted pi-orb orbs'
  echo "created pool $POOL" >&2
fi

if gcloud iam workload-identity-pools providers describe "$PROVIDER" \
  --project="$PROJECT" --location=global \
  --workload-identity-pool="$POOL" >/dev/null 2>&1; then
  # The issuer URI is the trust anchor and cannot be edited in place. A mismatch
  # means this pool was bootstrapped against a different pi-orb deployment;
  # silently repointing it would move every existing grant to a new issuer.
  existing_issuer=$(gcloud iam workload-identity-pools providers describe "$PROVIDER" \
    --project="$PROJECT" --location=global --workload-identity-pool="$POOL" \
    --format='value(oidc.issuerUri)')
  if [ "$existing_issuer" != "$ISSUER_URL" ]; then
    echo "bootstrap failed: provider '$PROVIDER' already trusts a different issuer" >&2
    echo "  existing: $existing_issuer" >&2
    echo "  intended: $ISSUER_URL" >&2
    echo "Changing the issuer is a trust migration: create a new provider id" >&2
    echo "and move grants deliberately. This script will not repoint it." >&2
    exit 1
  fi
  gcloud iam workload-identity-pools providers update-oidc "$PROVIDER" \
    --project="$PROJECT" --location=global \
    --workload-identity-pool="$POOL" \
    --allowed-audiences="$AUDIENCE" \
    --attribute-mapping="$mapping" \
    --attribute-condition="$condition" --quiet >/dev/null
  echo "converged provider $PROVIDER" >&2
else
  gcloud iam workload-identity-pools providers create-oidc "$PROVIDER" \
    --project="$PROJECT" --location=global \
    --workload-identity-pool="$POOL" --display-name='pi-orb orb OIDC' \
    --issuer-uri="$ISSUER_URL" \
    --allowed-audiences="$AUDIENCE" \
    --attribute-mapping="$mapping" \
    --attribute-condition="$condition"
  echo "created provider $PROVIDER" >&2
fi

if ! gcloud iam service-accounts describe "$TEST_SA_EMAIL" \
  --project="$PROJECT" >/dev/null 2>&1; then
  gcloud iam service-accounts create "$TEST_SA" --project="$PROJECT" \
    --display-name='pi-orb OIDC federation test' \
    --description='Read-only identity admitted orbs may impersonate; used by infra/smoke-workload-identity.sh'
  echo "created service account $TEST_SA_EMAIL" >&2
fi

# Read-only by construction. The requirements admit a read-only test grant
# before any deployment-capable role: this account exists to prove the exchange
# works, so the worst outcome of a mistake here is that someone reads project
# metadata they could already see.
gcloud projects add-iam-policy-binding "$PROJECT" \
  --member="serviceAccount:$TEST_SA_EMAIL" --role="$TEST_SA_ROLE" \
  --condition=None --quiet >/dev/null

gcloud iam service-accounts add-iam-policy-binding "$TEST_SA_EMAIL" \
  --project="$PROJECT" --member="$principal_set" \
  --role='roles/iam.workloadIdentityUser' --quiet >/dev/null

# Revoke *after* adding, so narrowing a scope never leaves a window in which the
# account is reachable by nobody. The lists were read before anything was
# created, and each removal is announced: a silent revocation is as confusing as
# a silent survival.
if [ -n "$stale_members" ]; then
  printf '%s\n' "$stale_members" | while read -r member; do
    [ -n "$member" ] || continue
    echo "revoking stale admission: $member" >&2
    gcloud iam service-accounts remove-iam-policy-binding "$TEST_SA_EMAIL" \
      --project="$PROJECT" --member="$member" \
      --role='roles/iam.workloadIdentityUser' --quiet >/dev/null
  done
fi
if [ -n "$stale_roles" ]; then
  printf '%s\n' "$stale_roles" | while read -r role; do
    [ -n "$role" ] || continue
    echo "revoking stale test-account role: $role" >&2
    gcloud projects remove-iam-policy-binding "$PROJECT" \
      --member="serviceAccount:$TEST_SA_EMAIL" --role="$role" \
      --condition=None --quiet >/dev/null
  done
fi

sts_audience="//iam.googleapis.com/$pool_root/providers/$PROVIDER"
# `PI_ORB_SMOKE_PROJECT_ID` is the one scope variable the smoke reads: it makes
# the smoke create its disposable orbs inside the pi-orb project this pool
# trusts. There is deliberately no orb-scoped equivalent — the smoke's orbs are
# created and deleted per run, so an orb-scoped grant can never name one, and a
# variable the smoke ignores would be worse than none.
smoke_scope=""
if [ -n "$TRUSTED_PROJECT_ID" ]; then
  smoke_scope="  PI_ORB_SMOKE_PROJECT_ID='$TRUSTED_PROJECT_ID' \\
"
fi
cat <<EOF

BOOTSTRAP COMPLETE
  issuer:            $ISSUER_URL
  provider audience: $AUDIENCE
  STS audience:      $sts_audience
  test account:      $TEST_SA_EMAIL

Federation smoke:
  PI_ORB_SMOKE_WIF_AUDIENCE='$AUDIENCE' \\
  PI_ORB_SMOKE_WIF_STS_AUDIENCE='$sts_audience' \\
  PI_ORB_SMOKE_WIF_TEST_SA='$TEST_SA_EMAIL' \\
${smoke_scope}  ./infra/smoke-workload-identity.sh
EOF
if [ -n "$TRUSTED_ORB_ID" ]; then
  cat <<EOF
Note: this grant is scoped to orb $TRUSTED_ORB_ID, and the federation smoke
mints from a disposable orb it creates itself — so its STS legs will be refused
by the attribute condition. Bootstrap a project-scoped grant (a separate pool or
provider id) if you want the smoke to exercise the exchange.
EOF
fi
