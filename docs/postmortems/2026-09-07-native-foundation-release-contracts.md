# First native foundation release contract failures — 2026-09-07

The first native rollout stopped three times at infrastructure boundaries. No
database resource changed. The release lock serialized every attempt, and each
attempt preserved its first log under `.context/native-deploy/`.

Foundation adoption first failed while creating the deployer's IAP tunnel
grant. Its condition joined seventeen subnet prefixes, exceeding Google IAM's
twelve-logical-operator limit. PR 29 split the same exact port-22 destinations
across three bindings and added a contract test for complete, non-overlapping
coverage within the operator limit. The remaining scoped plan then created only
those bindings before the final plan removed the eight imported broad project
grants. A fresh foundation plan was empty and its schema output was 1.

The first application release then stopped before creating an image because the
short Git hash began with a digit, which is not a valid first character in the
builder's GCE resource-name segment. PR 30 prefixes commit-derived image versions
with `v-`; its release test uses a digit-leading commit and applies the builder's
actual name constraint. Builder validation remains strict.

The next release built and validated image ID `1619087005851009754`, then its
application apply failed because the foundation exposed the Cloud Run egress
subnet as an HTTPS Compute API self-link. Cloud Run requires the
`projects/PROJECT/regions/REGION/subnetworks/NAME` resource name. PR 32 changes
only that output and tests the state-adoption projection, foundation expression,
and all four Cloud Run consumers.

That partial application created the foundation guard, updated the orb SSH
firewall, and removed the old orb VM Artifact Registry reader before all Cloud
Run service updates rejected the subnet. The release's mandatory IAP repair
completed and restored the exact `domain:heyglide.com` browser policy. The old
reader was restored so the unchanged container-based service remained usable;
remove that exact temporary restoration only after the native deployment and
its live smoke tests succeed. The protected Cloud SQL instance, database, user,
and password resources were no-ops in the reviewed plan.

The resulting rules are:

- Validate provider limits on the rendered IAM conditions, not only their
  intended resource set.
- Feed commit-derived identifiers through the strictest downstream naming
  contract before creating cloud resources.
- Test remote-state outputs in the exact string form required by each consumer;
  provider aliases such as `id` and `self_link` are not interchangeable API
  contracts.
