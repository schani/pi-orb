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

The application root retains its `static-plane` state prefix and reads the `foundation` state prefix from
`var.foundation_state_bucket`. Its project, region, and zone must match the
foundation outputs. Releases should read `zone`, `state_bucket`,
`artifact_registry_repository`, network and subnet identities and CIDRs,
`image_build_subnetwork`, and `image_builder_service_account_email` from this
root rather than reconstructing them. The isolated build subnet and its builder-only IAP firewall let a fresh
project build the accepted native image before the application root exists.

IAP build access is restricted to SSH destinations in the isolated build subnet.
Its condition uses the documented `destination.ip` and `destination.port`
attributes, with the subnet and address prefix defined together
([Google IAP TCP forwarding](https://cloud.google.com/iap/docs/using-tcp-forwarding)).
