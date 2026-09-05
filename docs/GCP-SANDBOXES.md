# GCP sandbox host evaluation (2026-09-05)

Status: **not adopted (2026-09-05); retain the current GCE provider.**
The storage and operational tradeoffs outweigh the unmeasured startup benefit.
Evaluations remain for future reference; no cloud benchmarks were run.
AWS comparison: `docs/AWS-MICROVMS.md`. Decisions are recorded in
`docs/open-questions.md`, questions 37 and 47.

## Requirement and evaluated alternatives

An orb needs a durable workspace, not permanent compute. The user's observed
sessions are short; this investigation did not query production runtimes.
Preserve the whole `/workspace`, including repository, session, home, and
tailnet state, across replacement. A mounted network filesystem and an
attachable block disk satisfy different storage contracts.

For a **block disk**, GKE Agent Sandbox is the strongest documented candidate.
For **NFS**, Cloud Run instances deserve a benchmark alongside AWS MicroVMs:
their native mount support and existing GCP placement reduce integration work.
If revisited, compare orb-ready latency and filesystem behavior, not
advertised sandbox creation time. No alternative-provider work is planned.

## GKE Agent Sandbox

Google's managed controller runs isolated, stateful single-replica workloads
on Kubernetes, normally using gVisor. This provides an agent-sandbox service
rather than a managed Firecracker VM API. Warm pools keep pods ready for
claims. Kata is also possible, but Google excludes that third-party runtime
from its support and SLA. This adds a GKE cluster and provisioned warm capacity
to our operational surface. [Overview](https://docs.cloud.google.com/kubernetes-engine/docs/concepts/machine-learning/agent-sandbox).

**Workspace support is explicit:** retain an independently created PVC backed
by Persistent Disk/Hyperdisk and reference it from each new Sandbox. Deleting
the Sandbox preserves that PVC. Google documents multiple seconds for ordinary
disk attachment; the generic subsecond provisioning claim does not establish
subsecond reuse of an arbitrary existing disk. The examples require non-root
execution and dropped capabilities, which need adaptation from our root
runtime. [Storage guide](https://docs.cloud.google.com/kubernetes-engine/docs/how-to/agent-sandbox-storage).

The linked fast storage example uses a shared Filestore volume, per-tenant
directories, prewarmed pods, and a privileged node daemon that bind-mounts the
selected directory after claim. It avoids attaching a separate disk on the
critical path. This is custom infrastructure, with shared-capacity and quota
implications. [Reference implementation](https://github.com/kubernetes-sigs/agent-sandbox/tree/main/examples/latebind-storage-gke-sandbox).

Provider mapping: durable per-orb PVC plus incarnation-specific Sandbox;
Stop/discard deletes compute after drain, Start creates a successor on that
PVC, and permanent deletion removes both. The controller's reconciliation
must remain subordinate to orb lifecycle intent. API retries, old-controller
actions, and predecessor termination need the existing incarnation fences.
Adopting our existing zonal GCE disk also needs explicit ownership and zone
handling; a generic PVC example does not prove that migration.

## Cloud Run instances

Cloud Run now has a **Preview** singleton resource with individually managed
create, start, stop, delete, and enumeration operations. It is a closer match
to `OrbHostProvider` than routing one orb through an autoscaled service.
[Lifecycle API](https://docs.cloud.google.com/run/docs/instances/create-and-manage-instances).

Instances have documented NFS mounts over VPC networking, including Filestore
or a self-managed NFS server. The mount must succeed before the container
starts. Cloud Run mounts NFS without locking; writes can be buffered, so
filesystem compatibility and crash recovery matter. This is native network
filesystem support, not a Persistent Disk attachment API.
[NFS configuration](https://docs.cloud.google.com/run/docs/configuring/instances/nfs-volume-mounts).

Proposed mapping: one incarnation-specific instance over a durable per-orb NFS
directory, with provider endpoint/auth handled through runtime transport.
No reviewed source establishes snapshot-style, subsecond startup for this
resource. Do not transfer the nested-sandbox latency claim to instance launch.

## Cloud Run sandboxes

This separate **Preview** feature launches isolated child environments inside
an already running Cloud Run resource. Current documentation supports named
background sandboxes and writable bind mounts from the parent. The parent's
ordinary writable filesystem is ephemeral: a bind mount alone does not
preserve an orb across parent replacement.
[Sandbox documentation](https://docs.cloud.google.com/run/docs/code-execution).

A parent NFS mount bound into a child workspace is therefore a plausible
composition, **not a tested integration**. It also needs a parent supervisor,
per-orb routing, and recovery when that parent dies. Google's demonstration
averages 500 ms for starting, executing, and stopping a simple sandbox within
an existing service; it does not measure this workspace-backed architecture.
[Launch demonstration](https://cloud.google.com/blog/topics/developers-practitioners/google-cloud-run-sandboxes-are-in-public-preview/).

## Evaluation contract

The useful latency spans Start to the first accepted browser message, with
the existing workspace and history available. Separate compute allocation,
mount readiness, runtime initialization, credentials, setup/resume hooks, and
WebSocket handshake. Compare warm and cold capacity with representative Git,
dependency, and build workloads. Every fresh incarnation runs setup under
`docs/orb-setup-hook.md`, even with persistent home caches.

Storage must survive abrupt compute loss without relying on an exit-time
archive. A successor must not write until the predecessor is fenced; shared
NFS makes exclusive ownership our responsibility. A missing mount must fail
readiness rather than create an empty workspace on disposable storage.

Any adopted provider must retain durable lifecycle evidence for mount failure,
deadline stop, replacement, and provider termination, keyed by orb and
incarnation. User-affecting failures and forced stops need visible reasons.
New lifecycle paths require deterministic simulation and browser/runtime E2E
coverage under `docs/testing.md`. This research changed documentation only.
