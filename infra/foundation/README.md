# Foundation root

Owns the stable project foundation: enabled APIs, versioned state bucket,
Artifact Registry, service accounts, recurring build/deploy grants, networks and
the workload-identity trust that admits the deployer. Apply it only with a
separate administrator identity; the recurring deployer cannot change its own
account, admission policy, project APIs or state-bucket policy
(`docs/deployment.md`).

## New project

An administrator first creates the state bucket (the backend cannot create
itself), then:

```sh
tofu -chdir=infra/foundation init \
  -backend-config=bucket=pi-orb-tfstate-PROJECT
tofu -chdir=infra/foundation plan -out=foundation.plan \
  -var=project=PROJECT -var=state_bucket=pi-orb-tfstate-PROJECT
tofu -chdir=infra/foundation apply foundation.plan
```

Review every saved plan; require no stable-resource replacement. Use a temporary
administrator login only for this, verify the result through federation in an
empty HOME/gcloud configuration (the real `.agents/resume`), then revoke the
login. Never copy it to other orbs or store a personal refresh token.

## Adopting an existing project

`./infra/foundation/adopt.sh` acquires the global release lock, saves both
generation-pinned remote states locally (mode 0600) and prints the exact state
moves. `--execute` pushes the projection foundation-first with generation
preconditions; an interruption can leave duplicate ownership, never missing
ownership, and a rerun completes it. The projected foundation reports schema
version 0, so releases stay blocked until the foundation plan is reviewed and
applied. Adoption applies no cloud resource.

Then import each **verified** unconditional legacy deployer membership (omit
absent ones) before planning its removal:

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
tofu -chdir=infra/foundation apply "$PLAN_DIR/foundation-scoped.plan"
gcloud storage buckets remove-iam-policy-binding "gs://$BUCKET" \
  --member="$DEPLOYER" --role=roles/storage.objectAdmin --condition=None
tofu -chdir=infra/foundation plan -out="$PLAN_DIR/foundation-final.plan" \
  -var=project="$PROJECT" -var=state_bucket="$BUCKET"
tofu -chdir=infra/foundation apply "$PLAN_DIR/foundation-final.plan"
```

The final plan (variable back at default `false`) may remove only the imported
memberships. Never replace this with authoritative role bindings, which could
revoke unrelated administrators. Remove the unconditional state-bucket grant
only after the conditioned `static-plane/` and read-only `foundation/` members
are applied.

## Grants to the deployer

All grants go to the shared federated `pi-orb-amp-deployer`, so GitHub Actions
and every admitted project orb inherit them without personal logins. The release
never administers its own grants.

- **State bucket:** object access conditioned to `static-plane/`, read-only on
  `foundation/`.
- **Networks:** the deployer gets `networkUser` on the three exact
  subnets and firewall administration conditioned to the two application
  firewalls; it cannot touch the image-build VPC or firewall.
- **Hosting bucket:** a custom role limits bucket metadata and IAM management to
  exactly `pi-orb-hosting-PROJECT` (type and name condition). Bucket creation is
  a separate project-scoped role because GCS checks `storage.buckets.create` on
  the project; it can create other buckets but not manage existing ones. Neither
  grants object access. Managing that bucket's IAM is still high trust. The
  application owns the bucket and its control-plane access policy.
- **Logging configuration:** custom role `deployer_logging_exclusions` grants only
  `logging.exclusions.create/get/update/delete` and
  `logging.logMetrics.create/get/update/delete`, project-wide. No sinks, buckets,
  log deletion or IAM. Do not substitute `roles/logging.admin`. The application service depends on the actual callback
  exclusion and OAuth secret IAM, so a failed creation cannot publish a revision
  ahead of them.
- **Foundation plan reads:** custom role `piOrbFoundationPlanReader` grants
  `iam.workloadIdentityPools.get`, `iam.workloadIdentityPools.getAttestationRules`,
  `iam.workloadIdentityPoolProviders.get`, `storage.buckets.getIamPolicy`,
  `iam.serviceAccounts.get`, `iam.serviceAccounts.getIamPolicy`, `iam.roles.get`,
  `servicenetworking.services.get`, `resourcemanager.projects.getIamPolicy`,
  `artifactregistry.repositories.getIamPolicy`. No IAM writes.
- **Preview ingress:** Cloud Domains, Cloud DNS and Certificate Manager APIs; the
  public zone `pi-orb-preview` for `var.preview_domain` (`piorb.live`); `dns.admin`
  on that zone only; project `certificatemanager.editor` and
  `compute.loadBalancerAdmin` (project-wide load-balancer authority). The domain
  itself was registered once with `gcloud domains registrations register
  --cloud-dns-zone=pi-orb-preview`, outside Terraform (paid, with contact data).
- **Release SSH:** see below.

Contract tests pin the permission sets and conditions (`iam_contract.test.mjs`).

## Control-plane grants

`pi-orb-control-plane` gets `compute.instanceAdmin.v1` conditioned to
`…/instances/pi-orb-*`, `…/disks/pi-orb-*` and `pi-orb*` subnetworks, so a bug
cannot mutate foreign VMs; unconditioned `compute.viewer` for list, get, guest
attributes and operation waits; `compute.imageUser` on `pi-orb-*` images only;
`iam.serviceAccountUser` on the orb VM account; and `logging.logWriter`.

Verify release authority as the federated identity (read-only; runs in every
release before checks, with missing permissions and the foundation remedy in the log):

```sh
python3 -m infra.release_preflight playground-dev-6ae7
```

The debug service account and the deployer's Token Creator binding on it are
outside this root (`infra/bootstrap-amp-oidc.sh`). Verify that
`pi-orb-amp-deployer@PROJECT` has `roles/iam.serviceAccountTokenCreator` on
`pi-orb-debug@PROJECT` after foundation changes.

## GitHub deployment admission

`github.tf` admits only `schani/pi-orb/.github/workflows/deploy.yml` dispatched
manually from `main`: the provider checks repository ID `1307054237`, owner ID
`61363`, ref, event and workflow ref together. It grants `workloadIdentityUser`
on the existing deployer, no new project roles. No GitHub secret or key. An
already authenticated orb cannot grant new identities authority.

## Outputs and activation object

The control-plane account can read exactly `static-plane/releases/active.json`,
not Terraform state; only the release controller writes it.

The application root keeps prefix `static-plane` and reads the `foundation`
prefix from `var.foundation_state_bucket`; project, region and zone must match.
Releases read `zone`, `state_bucket`, `artifact_registry_repository`, network and
subnet identities and CIDRs, `image_build_subnetwork` and
`image_builder_service_account_email` from this root rather than reconstructing
them. The isolated build subnet and its builder-only IAP firewall let a fresh
project build the native image before the application root exists.

## Release SSH

Builder, validator and orb instances set `block-project-ssh-keys=TRUE`, so
`gcloud compute ssh` publishes a fresh caller key through instance metadata. The
build role covers builder and validator metadata; a separate scoped role permits
metadata writes on `pi-orb-*` workload instances. Neither permits project SSH
metadata changes. Release smokes always use IAP tunneling.

`deployer_iap_tunnel` admits port 22 only to the isolated build subnet and the
exact orb `/20`, using `destination.ip` and `destination.port`
([IAP TCP forwarding](https://cloud.google.com/iap/docs/using-tcp-forwarding)).
There is no CIDR operator, so the prefixes are split across bounded condition
bindings, each under the 12-logical-operator IAM Conditions limit and each
requiring port 22.

**Rendered-contract gate:** `infra/foundation/test-tofu.sh` (OpenTofu 1.13.2;
CI `checks` runs it). `infra/foundation/test.sh` runs it plus the Node
contracts that `npm run test:infra` also runs. `tests/release_ssh.tftest.hcl` uses a Google mock plan to pin the
complete `deployer_iap_tunnel` expression map: three exact keys, port 22 conjoined
with grouped exact IP prefixes, at most 12 rendered logical operators. It pins
rendered policy text, not CEL evaluation or live enforcement. The gate validates
a temporary copy of the module, then omits only `imports.tf` for the mock plan
(OpenTofu 1.13.2 crashes on mock imports). The backend is disabled and the
lockfile read-only; no cloud credentials.
