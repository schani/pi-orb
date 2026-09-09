# Foundation root

This root owns the stable project foundation: enabled APIs, versioned state
bucket, Artifact Registry, service accounts, recurring build/deploy grants, and
the workload-identity trust that admits the deployer. Apply it only with the
separate organization/bootstrap identity. The recurring deployer cannot change
its own account, admission policy, project APIs, or state-bucket policy.

For a new project, an administrator first creates the state bucket (the backend
cannot create itself), then initializes and applies the root:

```sh
tofu -chdir=infra/foundation init \
  -backend-config=bucket=pi-orb-tfstate-PROJECT
tofu -chdir=infra/foundation plan -out=foundation.plan \
  -var=project=PROJECT -var=state_bucket=pi-orb-tfstate-PROJECT
tofu -chdir=infra/foundation apply foundation.plan
```

The existing project must use `./infra/foundation/adopt.sh`. It acquires the
same GCS release lock as deployment, saves both generation-pinned remote states
locally with mode 0600, and prints the exact state moves. `--execute` pushes the
validated projection foundation-first with generation preconditions. An
interruption can therefore leave duplicate ownership, never missing ownership;
a rerun recognizes identical resource IDs and completes the app-side removal.
The projected foundation reports schema version 0, so releases remain blocked
until an administrator reviews and applies the foundation plan. No cloud
resource is applied by adoption. State backups are retained at the printed path.

After `adopt.sh --execute`, initialize the new state and import each verified
unconditional legacy deployer membership before planning its removal:

```sh
PROJECT=playground-dev-6ae7
BUCKET=pi-orb-tfstate-$PROJECT
DEPLOYER=serviceAccount:pi-orb-amp-deployer@$PROJECT.iam.gserviceaccount.com
umask 077
PLAN_DIR=$(mktemp -d)
chmod 700 "$PLAN_DIR"
trap 'rm -rf "$PLAN_DIR"' EXIT
tofu -chdir=infra/foundation init -backend-config="bucket=$BUCKET"
for role in \
  roles/artifactregistry.writer \
  roles/iam.serviceAccountAdmin \
  roles/iam.serviceAccountUser \
  roles/compute.networkAdmin \
  roles/iap.admin \
  roles/resourcemanager.projectIamAdmin \
  roles/servicenetworking.networksAdmin \
  roles/serviceusage.serviceUsageAdmin; do
  tofu -chdir=infra/foundation import \
    -var="project=$PROJECT" -var="state_bucket=$BUCKET" \
    -var=adopt_legacy_deployer_grants=true \
    "google_project_iam_member.obsolete_deployer[\"$role\"]" \
    "$PROJECT $role $DEPLOYER"
done
tofu -chdir=infra/foundation plan -out="$PLAN_DIR/foundation-scoped.plan" \
  -var=project="$PROJECT" -var=state_bucket="$BUCKET" \
  -var=adopt_legacy_deployer_grants=true
```

Import only memberships confirmed in the live policy; omit absent ones. Review
the saved plan, require no stable-resource replacement, then apply it to install
the scoped replacement grants. Remove the old unconditional state-bucket grant
without matching the new conditioned grant:

```sh
tofu -chdir=infra/foundation apply "$PLAN_DIR/foundation-scoped.plan"
gcloud storage buckets remove-iam-policy-binding "gs://$BUCKET" \
  --member="$DEPLOYER" --role=roles/storage.objectAdmin --condition=None
```

Finally, plan with `adopt_legacy_deployer_grants` at its default `false`. The
only removals must be the imported obsolete deployer memberships. Apply that
exact saved plan:

```sh
tofu -chdir=infra/foundation plan -out="$PLAN_DIR/foundation-final.plan" \
  -var=project="$PROJECT" -var=state_bucket="$BUCKET"
tofu -chdir=infra/foundation apply "$PLAN_DIR/foundation-final.plan"
```

The old bootstrap script granted the deployer project IAM administration,
service-account administration/user, service-usage administration, and a
project-wide Artifact Registry writer role. It also held project-wide Compute
network, Service Networking, and IAP administration. For adoption, import those exact
member bindings as `google_project_iam_member.obsolete_deployer[...]` with
`adopt_legacy_deployer_grants=true`. Then return the variable to its default
`false`; the reviewed foundation plan removes only that deployer member from
those roles. Never replace this with authoritative role bindings, which
could revoke unrelated administrators. The old unconditional state-bucket
object-admin member must likewise be explicitly removed after the conditioned
`static-plane/` member and read-only `foundation/` member are applied.

The application VPC, subnets, and private-services connection are foundation
resources because IAM Conditions do not expose names for Compute networks,
subnets, or addresses. The recurring deployer receives `networkUser` on the
three exact subnets. Firewall administration is conditioned to the two
application firewall resources. IAP administration is conditioned to web
services, excluding IAP tunnels; IAM does not expose a supported resource-name
attribute for narrowing it to one Cloud Run service.
Neither grant can mutate the foundation image-build VPC or firewall. These
grants pass local provider validation; a bootstrap using only the WIF deployer must still
prove the complete permission set before production use.

Hosting-bucket deployment permissions are foundation-owned and apply to the shared
federated deployer, so every admitted orb in this repository project receives them
without a personal Google login. The application still owns the hosting bucket
and its control-plane object-access policy. A custom role limits bucket metadata
and IAM management to exactly `pi-orb-hosting-PROJECT`; neither new role includes
direct object permissions. Managing that bucket's IAM is nevertheless high trust:
the deployer can change who can access its files. A separate create-only role is
project-scoped because GCS checks `storage.buckets.create` on the project before
a bucket exists. It can create another bucket, but does not grant management of
other existing buckets. This is an explicit platform-granularity limitation, not
a claim that bucket creation can be restricted to one future name. Contract tests
pin the permission sets and exact-name/type management condition.

`.agents/resume` installs the committed non-secret executable-source configuration
and registers the same federated account on every start. A one-time administrator
login is only for reviewing/applying changes to foundation authority; never copy
that login to other orbs or store a personal refresh token in project secrets.
Verify the new grant in an empty HOME/gcloud configuration through the real resume
hook before revoking the administrator's temporary login. Already-running orbs
receive the updated shared IAM grant; they do not need new personal credentials.

The application root retains its `static-plane` state prefix and reads the `foundation` state prefix from
`var.foundation_state_bucket`. Its project, region, and zone must match the
foundation outputs. Releases should read `zone`, `state_bucket`,
`artifact_registry_repository`, network and subnet identities and CIDRs,
`image_build_subnetwork`, and `image_builder_service_account_email` from this
root rather than reconstructing them. The isolated build subnet and its builder-only IAP firewall let a fresh
project build the accepted native image before the application root exists.

IAP release access is restricted to SSH destinations in the isolated build
subnet and the exact orb `/20`. Builder, validator, and orb instances set
`block-project-ssh-keys=TRUE`, so `gcloud compute ssh` publishes a fresh caller's
key through instance metadata. The build role covers builder and validator
metadata; a separate scoped role permits workload-instance metadata writes.
Neither grant permits project SSH metadata changes. The tunnel condition uses the
documented `destination.ip` and `destination.port` attributes
([Google IAP TCP forwarding](https://cloud.google.com/iap/docs/using-tcp-forwarding)).
Google documents no CIDR operator for `destination.ip`, so the exact `/20`
prefixes are divided across bounded condition bindings; each remains below the
12-logical-operator IAM Conditions limit and still requires port 22.

The debug service account and its Token Creator binding remain outside this
root. Before the first scoped release, an administrator must verify that
`pi-orb-amp-deployer@PROJECT.iam.gserviceaccount.com` still has
`roles/iam.serviceAccountTokenCreator` on
`pi-orb-debug@PROJECT.iam.gserviceaccount.com`; `infra/bootstrap-amp-oidc.sh`
creates that service-account-level binding.
