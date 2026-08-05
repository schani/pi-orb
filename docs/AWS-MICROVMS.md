# AWS Lambda MicroVMs as an orb host provider — evaluation (2026-08-05)

Status: **feasible via externalized durable state — proposal, not decided.**
Summary lives in `docs/host-provider.md`; the decision is tracked as open
question 37. This document is the full writeup.

The service was initially dismissed because of its hard maximum lifetime. This
re-evaluation started from the premise that the lifetime cap is acceptable if
an orb can continue on a successor VM, provided the durable data comes along.
The investigation confirms the premise — with the important correction that
the disks cannot literally be brought along; they must live outside the VM
from the start.

## What Lambda MicroVMs are

AWS Lambda MicroVMs (launched June 2026) are serverless Firecracker VMs
purpose-built for exactly our workload class — the docs name "interactive
development environments" and "AI code execution sandboxes" as primary use
cases. Docs entry point:
https://docs.aws.amazon.com/lambda/latest/dg/lambda-microvms-guide.html

- **Image model**: you upload a zip (Dockerfile + artifacts) to S3; AWS builds
  it on a managed Amazon Linux 2023 base, boots the app, waits for an optional
  `/ready` hook, then captures a **disk + memory snapshot** of the fully
  initialized environment. Every MicroVM starts by restoring that snapshot
  (~3 min builds; third-party measurements: ~1.2 s `run-microvm` API call,
  ~12 s to RUNNING, ~0.9 s first request). Images are versioned;
  `update-microvm-image` produces new versions.
- **Lifecycle verbs**: `run-microvm`, `suspend-microvm`, `resume-microvm`,
  `terminate-microvm`, `list-microvms`, `get-microvm` (with `stateReason` for
  unexpected terminations). States: PENDING → RUNNING ⇄ SUSPENDED →
  TERMINATED.
- **Suspend/resume**: automatic via idle policy (`maxIdleDurationSeconds`,
  `autoResumeEnabled`, `suspendedDurationSeconds`) or explicit API. Suspend
  checkpoints memory and disk; resume restores both (~1.9 s measured, same
  PIDs, counters intact). Auto-resume holds the triggering request until the
  app is back.
- **Lifecycle hooks**: HTTP endpoints the app exposes
  (`/aws/lambda-microvms/runtime/v1/{run,suspend,resume,terminate}`), POSTed
  by Lambda at each transition. `/run` receives a per-VM `runHookPayload`
  (≤16 KB string passed to `run-microvm`) plus the `microvmId`; traffic is
  only forwarded after `/run` returns 200.
- **Networking**: each VM gets a unique public HTTPS endpoint. All requests
  require a JWE auth token (`create-microvm-auth-token`, `X-aws-proxy-auth`
  header, scoped to ports and an expiry). WebSockets, HTTP/2, gRPC, and SSE
  are officially supported; port selection via `X-aws-proxy-port` header or a
  `lambda-microvms.port.N` WebSocket subprotocol. Egress defaults to public
  internet; a customer-managed **VPC egress connector** (ENIs in your VPC)
  routes outbound traffic through your VPC instead.
- **OS capabilities**: `additionalOsCapabilities: ["ALL"]` grants elevated
  Linux capabilities inside the VM boundary — the docs explicitly name
  **mounting filesystems** as an enabled operation.
- **Shape**: ARM64 only. Baselines 0.5/1/2/4/8 GB memory (vCPU = memory/2),
  automatic vertical burst to 4× baseline, disk 8–32 GB by size tier.
  Endpoint bandwidth 1–16 MB/s scaling with size (endpoint traffic only).
- **Pricing** (per-second): $0.0000276944/vCPU-s + $0.0000036667/GB-s — the
  default 2 GB / 1 vCPU baseline is ≈ $0.126/h running. Suspended VMs cost
  only snapshot storage ($0.08/GB-month; suspend writes $0.0038/GB, resume
  reads $0.00155/GB). Terminated VMs cost nothing. Burst above baseline is
  billed only for active use.
- **Regions**: us-east-1, us-east-2, us-west-2, eu-west-1, ap-northeast-1.
- **Quota**: account-level cap on total memory across RUNNING + SUSPENDED
  VMs per region (Service Quotas increasable).

## The lifetime cap, precisely

`maximumDurationInSeconds` ranges 1–28,800 s (**8 hours**) and bounds the time
a VM may spend in RUNNING **plus** SUSPENDED combined. Consequences:

- Suspend does not stop the clock. It makes idle time nearly free, but the VM
  still dies within 8 h of creation.
- TERMINATED is terminal: no resume, no restart, no salvage.
- There is **no disk escape hatch**: no volume attach/detach, no disk export,
  no snapshot-a-running-VM-into-an-image API. The suspend checkpoint is
  internal to one VM's life. The local disk always dies with the VM.
- The `/terminate` hook **does** fire on cap-exceeded termination (the state
  transition table lists `maximumDurationInSeconds exceeded` as a trigger for
  RUNNING → TERMINATING, and TERMINATING runs the hook before releasing
  resources), but the hook's timeout is undocumented.

So "continue on a new VM by bringing in the disks" is not something the
platform offers. What it does offer is enough to make the disks never local in
the first place.

## The proposed continuation architecture: externalized durable state

Reproduce the durable-data/disposable-boot split (Docker volume/container, GCE
data-disk/boot-disk) with the durable side outside the VM:

- **Per-orb EFS access point** as the durable filesystem, mounted over NFS
  from inside the MicroVM through a VPC egress connector.
  `additionalOsCapabilities: ["ALL"]` provides the mount capability; the
  connector provides reachability to EFS mount targets in our VPC.
- The MicroVM's local disk (the snapshot rootfs) is the disposable boot —
  runtime image, tools, caches.
- The mount must happen in the **`/run` hook**, not at image build: a mount
  performed during the build would be baked into the shared snapshot, and NFS
  TCP state does not survive snapshot restore anyway. `/resume` must
  revalidate the mount after suspend/resume for the same reason.
- **Rotation**: the control plane tracks VM age and proactively drains
  (existing `stopping` machinery), terminates, `run-microvm`s a successor,
  and remounts the same EFS path — all before the 8 h cap. The `/terminate`
  hook is a flush backstop, not the plan.

A weaker fallback if EFS turns out not to work: sync the workspace to object
storage from the `/suspend` and `/terminate` hooks and restore in `/run`. This
loses deltas on crash and depends on the undocumented terminate-hook timeout,
so it is not the proposed design.

Notable upside: this gives a **cleaner runtime-image upgrade story than any
current provider** — terminate, run from the new image version, remount. No
startup-script rewriting (GCE), no rootfs-is-the-data problem (exe.dev).

## How it maps onto `OrbHostProvider`

Checked against the port in `apps/control-plane/src/domain/ports.ts` and the
contract in `docs/host-provider.md`.

| Port requirement | MicroVMs mapping | Fit |
|---|---|---|
| `provision` idempotent by orbId | `run-microvm` + create per-orb EFS access point; orbId via `runHookPayload`; idempotency is ours to build (no name/dedup parameter documented) | Workable — needs control-plane-side dedup |
| Runtime delivery (OCI image + env) | Dockerfile-built MicroVM image; env at image level, per-orb values via `runHookPayload` (16 KB) | Good — per-orb config moves from env to run payload |
| `observe` with definitive absence | `get-microvm` / `list-microvms`; absent from list is definitive; EFS presence distinguishes "stopped" from "never existed" | Good |
| `listManagedHosts` with orb association | `list-microvms` + control-plane records; per-VM tagging unverified | Workable |
| `stop` (retain filesystem) | Short-term: `suspend-microvm` (state intact, ~free). Long-term: flush + `terminate-microvm`; "stopped" = no VM, EFS holds the data | Good — better than exe.dev, but see the rotation obligation |
| `start` (restart in place) | Resume if suspended; otherwise `run-microvm` a fresh VM + remount EFS | Good |
| Token readback on provision-reuse | No instance metadata store; deliver via `runHookPayload`, read back via runtime | Workable |
| `diagnose` (optional) | `get-microvm` `stateReason` + CloudWatch logs; Lambda-provided shell-access connector exists | Good |
| Control plane → runtime HTTP/WS | Public endpoint + JWE token header; WS officially supported | Works with the same contract extension exe.dev needs |
| Runtime → control plane broker | Outbound HTTPS (default internet egress or via VPC) | Already provider-agnostic |

## The real impedance mismatches

### 1. The rotation obligation (new lifecycle work, unique to this provider)

No other evaluated provider imposes a deadline on healthy hosts. The lifecycle
machine must learn VM age tracking, a proactive drain-terminate-rerun-remount
sequence, and a successor-handoff so the orb's identity (runtime token,
history cursor, endpoint) survives the swap. Suspended orbs also burn the
budget, so "idle-stopped" orbs older than the cap must be converted to
"terminated with EFS state" even while idle.

### 2. Durable state is a second AWS system, not a provider feature

EFS access points, mount targets, security groups, and the VPC egress
connector are all our infrastructure. Provision becomes a two-resource
operation (VM + EFS access point) with the usual partial-failure cases. Git
workload performance on EFS/NFS is an open empirical question.

### 3. Network path inversion (shared with exe.dev)

`runtimeAddress` must grow provider-supplied headers (the JWE token), the
runtime broker needs public egress and token-refresh logic (tokens are minted
per call with configurable expiry; the maximum expiry is undocumented), and
per-connection auth-token minting adds an AWS API call to the connect path.
The WebSocket subprotocol workaround is browser-only; our broker connects
server-side and can send headers.

### 4. Cross-cloud operations

The control plane runs on GCP; MicroVMs, EFS, and the connector live in AWS.
API calls are public HTTPS (fine), but this adds an AWS account, IAM roles
(build role, execution role, connector operator role), VPC, and EFS to the
operational surface, plus AWS credentials in the control plane. Five AWS
regions are available; none is a GCP region, so control-plane↔runtime latency
crosses providers (likely negligible for our chatty-but-small protocol).

### 5. Platform constraints

ARM64 only (runtime image must build for arm64 — fine for Node). Disk capped
at 8–32 GB. Baseline memory capped at 8 GB (32 GB burst). Endpoint bandwidth
1–16 MB/s — applies only to endpoint traffic; git/package traffic uses egress.
Base images have a deprecation lifecycle (DEPRECATED 60 d → EXPIRING 30 d →
EXPIRED: existing images stop running), so periodic image rebuilds are
mandatory operational hygiene.

## Cost sketch

Running at the 2 GB / 1 vCPU default: ≈ $0.126/h — several times a comparable
GCE e2 instance, but billed per second with near-free suspension. For the
interactive orb pattern (short active bursts, long idle), suspend-on-idle plus
rotation-to-terminated for long idle should make effective cost dominated by
storage: $0.08/GB-month for suspended snapshots, standard EFS rates
(~$0.30/GB-month) for orb state. Suspend/resume cycling costs pennies
($0.0038/GB written per suspend, $0.00155/GB read per resume).

## What must be verified empirically (in order of risk)

1. **EFS/NFS mount through a VPC egress connector from inside a MicroVM.**
   Nothing documents this combination; it merely follows from "VPC egress +
   mount capability". This is the load-bearing assumption — if it fails, the
   design degrades to hook-driven object-store sync.
2. **Git/workspace performance on EFS** for realistic orb workloads.
3. **NFS mount survival across suspend/resume** (stateful TCP under snapshot
   restore; `/resume` revalidation strategy).
4. **`/terminate` hook timeout** — how much flush time exists at the cap.
5. **Auth token maximum expiry and mint rate limits** for the broker.
6. **Per-VM tagging/enumeration fields** on `list-microvms`, and behavior
   under concurrent `run-microvm` calls for the same orb (idempotency).
7. **Account memory quota** default and increase turnaround.

## Sources

- Guide: https://docs.aws.amazon.com/lambda/latest/dg/lambda-microvms-guide.html
- Core concepts / lifecycle: https://docs.aws.amazon.com/lambda/latest/dg/microvms-how-it-works.html
- Running / hooks / auth / WS: https://docs.aws.amazon.com/lambda/latest/dg/microvms-launching.html
- Networking / connectors / bandwidth: https://docs.aws.amazon.com/lambda/latest/dg/microvms-networking.html
- Images / sizing / capabilities: https://docs.aws.amazon.com/lambda/latest/dg/microvms-images.html
- Best practices: https://docs.aws.amazon.com/lambda/latest/dg/microvms-best-practices.html
- Launch post: https://aws.amazon.com/blogs/aws/run-isolated-sandboxes-with-full-lifecycle-control-aws-lambda-introduces-microvms/
- Pricing: https://aws.amazon.com/lambda/pricing/
- Third-party measurements (latency, suspend/resume behavior, regions):
  https://dev.to/aws-builders/aws-lambda-microvms-i-tested-the-new-stateful-serverless-primitive-40jf
