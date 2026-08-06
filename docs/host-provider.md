# Orb host provider

How orb compute is provisioned and managed: the `OrbHostProvider` port, runtime readiness, the Docker and GCE implementations, and evaluated alternatives. The lifecycle state machine that drives these operations is specified in `docs/lifecycle.md`.

## The `OrbHostProvider` port

The abstraction is named `OrbHostProvider`. The control plane and lifecycle state machine depend only on this interface; Docker is one implementation and GCE can be another. No control-plane service or HTTP handler may invoke Docker directly.

The host provider only manages infrastructure. It does not know about Pi, Claude Code, conversations, prompts, or history replication.

```ts
type OrbHostState = "starting" | "running" | "stopping" | "stopped" | "failed";

type OrbHostProviderOperation = "provision" | "start" | "stop" | "observe" | "list";

interface OrbHostProviderError {
  type: "orb_host_provider_error";
  provider: string;
  operation: OrbHostProviderOperation;
  code: "unavailable" | "conflict" | "invalid_state" | "operation_failed" | "cancelled";
  message: string;
  retryable: boolean;
}

// In-process adapter context; never serialized on the wire.
interface OperationContext {
  signal: AbortSignal;
}

interface OrbHostRef {
  provider: string; // e.g. "docker" or "gce"
  resourceId: string; // container ID, instance name, etc.
}

interface ProvisionOrbHostRequest {
  orbId: string;
  bootstrap: {
    repositoryUrl: string;
  };
}

interface OrbHostObservation {
  ref: OrbHostRef;
  orbId: string;
  state: OrbHostState;

  // Ephemeral observation; never authoritative persisted state.
  runtimeAddress?: {
    baseUrl: string;
  };

  failure?: {
    code: string;
    message: string;
  };
}

interface OrbHostProvider {
  readonly kind: string;

  /**
   * Idempotent by orbId. Creates and starts the host, or returns the
   * existing matching host. Resolving means infrastructure is running,
   * not that the orb runtime has passed health checks.
   */
  provision(
    request: ProvisionOrbHostRequest,
    context: OperationContext,
  ): ResultAsync<OrbHostRef, OrbHostProviderError>;

  /** Idempotent. */
  start(ref: OrbHostRef, context: OperationContext): ResultAsync<void, OrbHostProviderError>;

  /** Gracefully stops compute while retaining its filesystem. Idempotent. */
  stop(ref: OrbHostRef, context: OperationContext): ResultAsync<void, OrbHostProviderError>;

  /**
   * Returns null only when the provider definitively reports that the
   * resource does not exist. Provider/transport uncertainty is Err.
   */
  observe(
    ref: OrbHostRef,
    context: OperationContext,
  ): ResultAsync<OrbHostObservation | null, OrbHostProviderError>;

  /** Used for reconciliation and leaked-resource discovery. */
  listManagedHosts(
    context: OperationContext,
  ): ResultAsync<OrbHostObservation[], OrbHostProviderError>;
}
```

Every finite provider call receives an `OperationContext`. The provider passes its signal to the underlying HTTP/process API and returns a typed `cancelled` error after cancellation is observed. Cancellation does not promise rollback of an external side effect: an ambiguous provision/start/stop is resolved by later idempotent `observe` and reconciliation.

There is intentionally no `unknown` host state. Failure to determine state is an error, not a durable state. There is also no `missing` state; definitive absence is represented by `observe()` returning `null`.

The interface intentionally omits:

- `destroy` and a `deleting` state: nothing in the first slice deletes an orb, so permanent host/filesystem removal is specified only when an orb-deletion feature exists;
- `restart`: the control plane composes `stop` and `start`;
- `exec`: runtime operations go through the orb runtime protocol;
- per-orb machine type, CPU, RAM, region, OS, or image configuration;
- harness-specific operations;
- runtime health and busy state, which belong to the runtime protocol.

Prescriptive infrastructure and provider-specific credential-delivery settings live in provider construction/configuration, for example:

```ts
new DockerOrbHostProvider({
  image: "pi-orb-runtime:<digest>",
  network: "pi-orb",
});

new GceOrbHostProvider({
  projectId: "playground-dev-6ae7",
  zone: "us-central1-a",
  machineType: "n2d-highmem-4",
  runtimeImage: "us-central1-docker.pkg.dev/…/pi-orb-runtime:<digest>",
});
```

The contract shared by every provider is: a persistent filesystem plus a host running the orb runtime container image with provider-delivered environment variables (the broker pair in `docs/credentials.md` plus, when port exposure is enabled, the Tailscale variables in `docs/ports.md`, whose auth key providers mint only at actual host creation). Where that container runs — the local Docker daemon or a Container-Optimized OS VM — never appears in the control plane or lifecycle engine.

`provision` returns the host ref together with `runtimeTokenHash` — the SHA-256 of the per-incarnation runtime token the host actually carries, minted at creation and read back from the delivery channel for existing hosts (docs/credentials.md). The lifecycle machine commits this observed hash next to the host ref and re-commits when either changes.

Decided shape of the future `GceOrbHostProvider` (not yet implemented):

- Each orb owns a separate persistent data disk, mirroring the Docker provider's volume/container split. The COS boot disk is disposable and is replaced on runtime-image upgrades without touching orb state.
- The runtime container is declared through COS instance metadata and pulled from Artifact Registry; COS restarts it on crash, providing the host-level supervision Docker's restart policy provides locally.
- `provision` creates the instance only when it does not exist. Recovery from a stop or a Spot preemption is `instances.start` on the same instance (restart-in-place); there is no recreate-and-reattach path in the common case.
- Spot preemption appears as instance state `TERMINATED`. Instance status alone does not distinguish preemption from other terminations, and the provider does not consult Cloud Logging to find out; it logs the cause as "likely preemption". Host-down detection, restart initiation, and restart outcome are all logged as structured lifecycle events.
- Networking: the control plane reaches the runtime on the instance's internal IP via Direct VPC egress from Cloud Run; the ephemeral public IP is outbound-only behind a deny-all-inbound firewall (see the infrastructure decisions below).
- Validated on real infrastructure (2026-07-30, during the Cloud Run WebSocket validation exercise): a COS VM with no external IP pulls the container from Artifact Registry over Private Google Access and serves WebSockets to Cloud Run via Direct VPC egress. Orb VMs run as the dedicated minimal service account `pi-orb-orb-vm` (Artifact Registry reader + log writer); the project's default compute service account is disabled, so the provider must always pass the dedicated one. The dev project has no default VPC — the validation created network `pi-orb` / subnet `pi-orb-us-central1` (10.10.0.0/20, Private Google Access), which the OpenTofu static plane should adopt.

The Docker provider publishes the runtime port to an ephemeral host-loopback port at container creation (`--publish 127.0.0.1:0:8080`) and reports the runtime address preferring that mapping, then the container's bridge-network IP, then the container name (decided and implemented 2026-08-06; E2E-validated on macOS Docker Desktop the same day). The loopback mapping is what makes a host-run control plane work on Docker Desktop, where bridge IPs are not host-routable; Docker re-picks the host port on every container start, which is safe because `runtimeAddress` is contractually an ephemeral observation re-read at observe time. The reverse direction uses the same mechanism on every platform: containers are created with `--add-host=host.docker.internal:host-gateway`, and the default control-plane URL handed to orbs is `http://host.docker.internal:<port>` (an explicitly configured URL still wins) — replacing the earlier bridge-gateway-IP derivation, which resolved to Docker Desktop's VM rather than the host and left booting runtimes unable to reach the credential broker. Containers created before 2026-08-06 lack both the published port and the host alias and are simply removed and re-provisioned per the POC stance. A container whose port mapping is absent still yields the bridge-IP/container-name forms, which remain correct on Linux and for a containerized control plane on the same network.

## Runtime readiness

`OrbHostProvider` state and runtime readiness are separate. `provision()`/`start()` succeeding means compute is running; an orb becomes `running` only after the control plane receives a ready response from the runtime.

The runtime starts its health server before doing slow initialization:

```ts
type RuntimeHealth =
  | {
      v: 1;
      orbId: string;
      runtimeInstanceId: string;
      status: "initializing";
      phase: "booting" | "cloning" | "loading_session" | "checking_auth";
    }
  | {
      v: 1;
      orbId: string;
      runtimeInstanceId: string;
      status: "ready";
      sessionId: string;
      checkoutCommit: string;
      activity: "idle" | "busy";
      operationId?: string;
    }
  | {
      v: 1;
      orbId: string;
      runtimeInstanceId: string;
      status: "failed";
      error: {
        code: string;
        message: string;
        retryable: boolean;
      };
    };
```

`GET /v1/health` returns HTTP 200 with this typed body whenever the process can serve HTTP. `initializing` and `failed` are reachable but not ready; the control plane interprets the discriminant instead of using status codes as lifecycle state. Network failure is distinct from a returned status.

Ready means all of the following:

- the runtime identity matches the requested orb;
- the repository exists in the authoritative filesystem at a resolved commit;
- the Pi session has been created or loaded from that filesystem;
- the configured Codex credential resolves successfully;
- history-pull and live WebSocket handlers are installed;
- the runtime can accept a new message when idle.

A fresh clone is written to a temporary directory and atomically renamed into place so a process crash cannot make a partial checkout look ready. Restart reuses a complete checkout/session and cleans or retries an incomplete temporary clone.

The runtime never replaces an existing session. Whether to create or load is decided solely from the persistent filesystem: if a session exists for this orb it must be loaded, and a session that exists but cannot be loaded is reported as `status: "failed"` with a non-retryable typed error such as `session_load_failed` — never treated as grounds for creating a fresh session. A new session may be created only when the filesystem contains none. This guarantees that the session identity the control plane records on first pull stays valid for the orb's entire life, so a session-header mismatch during replication can only mean a bug or filesystem corruption, never a legitimate replacement.

Expected initialization failures such as clone failure, invalid repository state, or unusable credentials are represented by `status: "failed"` long enough for the control plane to record the typed error. Unexpected process failure exits the process and is handled by provider supervision/reconciliation. Each provider configures its native runtime supervision while the host is meant to run (Docker restart policy initially, a system service on GCE later); an explicit provider `stop` disables/reconciles that supervision to stopped.

## Infrastructure decisions

- The first infrastructure backend is local Docker.
- The future cloud backend is raw Google Compute Engine, not Cloud Workstations.
- All cloud orbs will live in one GCP project rather than one GCP project per source project.
- The development GCP project has display name `playground-dev` and project ID `playground-dev-6ae7`.
- The current prescribed cloud location is the single hardcoded zone `us-central1-a`. No multi-zone or multi-region logic initially.
- The current prescribed GCE shape is Spot `n2d-highmem-4`: 4 vCPUs and 32 GiB RAM.
- Spot capacity exhaustion (`ZONE_RESOURCE_POOL_EXHAUSTED` on instance create or start) maps to a typed provisioning error that fails the orb and is shown to the user. There is no zone or on-demand fallback initially.
- Boot-failure detection (implemented; born from cloud smoke-testing): while an orb is `creating`/`starting`, the reconciler records a per-probe boot picture (host state, attempts, whether the runtime ever answered, last error) exposed to the UI as a `waiting_for_runtime` state detail. Because the runtime's health server starts before slow initialization, a running host whose runtime has never answered past `unreachableBootDeadlineMs` (3 minutes) fails fast as `runtime_never_answered` instead of burning the 15-minute deadline; the terminal error carries the probes plus provider diagnostics (`OrbHostProvider.diagnose`, reading the GCE guest-attribute startup markers). A transiently failing diagnose defers the failure one poll so evidence is never dropped. Deadline failures carry the same evidence. Covered by DST scenarios including the adversarial-scheduling case where a best-effort host stop is cancelled and repaired by the backstop sweep.
- Rollout caveat resolved (open question 32, implemented 2026-08-01): the GCE provider stamps `pi-orb-script-sha256` (and `pi-orb-repository-url`, the input needed to re-derive the script) into instance metadata at creation. Both `provision`-reuse and `start` compare the stamp against the script the current provider would generate; on mismatch — including pre-stamp instances, whose repository URL is recovered from the old script text — the host is repaired: stopped if running, `setMetadata` with the new script while preserving the runtime token (so the committed token hash stays valid), then started. This also delivers runtime-image upgrades to existing orbs on their next start, which restart-in-place previously never did. Residual: a draining stale revision can still "repair" a fresh host backward within its bounded drain window; the surviving revision repairs it forward on its next pass, and provision/start only run while the orb is `creating`/`starting`, so a ready runtime is never bounced. Field-validated during the 2026-08-01 rollout: the draining old revision restarted an orb VM un-repaired mid-rollover (the caveat's second observed occurrence), and the next stop/start through the new code repaired it — stamps present, new runtime image running.
- Spot preemption is handled purely as the existing crashed-host path: the provider observes the instance `TERMINATED`, and recovery starts the same instance again in place with its disks intact. Rejected for now: a best-effort history drain on the ~30-second preemption notice — it would convert most preemptions into near-clean stops, but the first cloud slice stays simple; the unreplicated tail is recovered on the next start as docs/history-replication.md already allows.
- Cloud orb VMs boot Container-Optimized OS and run the standard orb runtime container image pulled from Artifact Registry. The container is launched by a startup script rather than the konlet metadata declaration — konlet has no ordering guarantee against the data-disk mount the container depends on. Hard-won COS specifics encoded in that script: the root filesystem is read-only (docker credentials live on the stateful partition) and the COS host firewall admits only SSH by default (the script opens the runtime port). Startup progress and failures are reported through guest attributes. There is no baked VM image and no VM image pipeline. The orb environment is defined by the runtime container image on every provider (Debian 12 base, Node.js 24); which host runs that container is a provider implementation detail invisible to the control plane.
- Orb VMs use no Cloud NAT: each has an internal IP (used by the control plane) plus an ephemeral public IP for outbound traffic only, behind a deny-all-inbound firewall. Revisit NAT if orb count grows.
- Node.js 24 is prescribed.
- A simple TypeScript project should require no orb configuration file.
- Per-project machine sizing and arbitrary OS/package configuration are not part of the first slice.

## exe.dev as a host provider (evaluated 2026-08-05 — feasible with caveats; proposal, not decided)

exe.dev (https://exe.dev) was evaluated as a third `OrbHostProvider`. It offers microVMs (Cloud Hypervisor) booted directly from an OCI container image in ~2 seconds, with a persistent disk as the VM's root filesystem, SSH exec access, an HTTPS proxy per VM (`https://<vm>.exe.xyz`, ports 3000–9999 forwarded, gated by per-VM bearer tokens mintable offline by signing with the account SSH key), and an API that is the SSH CLI verbatim (`POST https://exe.dev/exec`, 30 s timeout, per-key rate limits, `--json` output). Custom images from private registries are supported (`new --image --registry-auth`), as are `--env` at create, `--setup-script` (≤10 KiB, first boot only), `--tag`, `--name`, `ls --json`, `rm`, `restart`, `cp`, `resize`. Pricing is a subscription over a shared resource pool (≈$20/mo, 25 VMs on the personal tier; team pools and a usage-based "Cloud Pool" exist), so idle VMs cost roughly nothing beyond disk.

What maps cleanly onto the port: `provision` → `new --name=pi-orb-<orbId> --image=<runtime image> --env` (the runtime image boots as-is — no startup script, no disk-mount choreography, no konlet-style ordering problem); ownership/enumeration → name prefix + tags with `ls --json` (a dedicated exe.dev account also gives hard tenancy isolation); definitive absence → VM not in `ls`; `diagnose` → SSH exec (strictly better than GCE guest attributes); runtime→control-plane broker calls → already provider-agnostic URL+bearer by design.

Three real impedance mismatches:

1. **No stop/start lifecycle.** The CLI has only `new`/`rm`/`restart`; VMs are always-on (the pricing model makes idle nearly free, which removes most of the motivation for idle auto-stop). Our `stop` (idle stop, unreachable-restart, orphan sweep, `stopping` drain) would have to be emulated — e.g. halt the runtime process over SSH and record "stopped" in a VM tag so `observe` stays truthful — a virtual lifecycle layered on tags + exec, or the provider could report stop as a no-op with idle-stop disabled for this provider.
2. **No durable-data/disposable-boot split.** The persistent disk *is* the rootfs instantiated from the image at create time. GCE delivers runtime-image upgrades to existing orbs by rewriting the startup script and recreating the disposable boot disk; exe.dev has no way to re-image a VM without `rm` (which destroys `/workspace`). Existing orbs would be pinned to their creation-time runtime image unless upgraded in place over SSH. Provision-reuse token readback would also go over SSH exec instead of instance metadata.
3. **Network path inversion.** The control plane would reach the runtime through exe.dev's authenticated HTTPS proxy (`https://pi-orb-<orbId>.exe.xyz:8080` + `X-Exedev-Authorization` bearer) instead of a private VPC IP — `runtimeAddress` would need to grow provider-supplied headers, WebSocket forwarding through their proxy needs empirical verification, and the runtime broker Cloud Run service would have to move from `ingress=internal` to public ingress (acceptable: orb-token bearer auth is the real gate and was designed for exactly this).

Unverified empirically: WS through the proxy, `ls --json` field shape (state/health), duplicate-`--name` behavior (needed for provision idempotency), whether an in-VM halt sticks, actual `/exec` rate limits (per-orb `observe` polling should be amortized into one periodic `ls` regardless), and private-registry auth against Artifact Registry (which wants short-lived tokens or a long-lived `_json_key`; mirroring the image to a PAT-authenticated registry may be simpler). Full writeup: [`docs/EXE-DEV.md`](docs/EXE-DEV.md). See open question 35.

## AWS Lambda MicroVMs as a host provider (evaluated 2026-08-05 — feasible via externalized durable state; proposal, not decided)

AWS Lambda MicroVMs (launched June 2026; docs: https://docs.aws.amazon.com/lambda/latest/dg/lambda-microvms-guide.html) were initially dismissed because of the hard maximum lifetime, then re-investigated on the premise that an orb can continue on a successor VM if the durable data survives. Conclusion: the lifetime cap is real and unavoidable — `maximumDurationInSeconds` caps a MicroVM at 28,800 s (8 h) spent in RUNNING **plus** SUSPENDED combined, TERMINATED is terminal, and there is no disk export, no volume attach/detach, and no image-from-running-VM API, so the local disk always dies with the VM. What makes it feasible anyway is that the durable-data/disposable-boot split can be reproduced with the durable side *outside* the VM: per-orb EFS (NFS through a customer-managed VPC egress connector; `additionalOsCapabilities: ["ALL"]` explicitly enables mounting filesystems) or, weaker, workspace sync to object storage from lifecycle hooks. The MicroVM becomes a disposable ≤8 h compute lease over an external filesystem, and the control plane rotates VMs proactively before the cap using the existing `stopping` drain machinery.

What the platform provides: Firecracker VMs booted from a pre-initialized disk+memory snapshot (image built by AWS from a Dockerfile zip in S3 on a managed AL2023 base; ~3 min builds, ~1–12 s to RUNNING measured by third parties), real lifecycle verbs (`run-microvm`, `suspend-microvm`, `resume-microvm`, `terminate-microvm`, `list-microvms`, `get-microvm` with `stateReason`), automatic idle suspend with optional auto-resume on traffic, per-VM public HTTPS endpoint with mandatory short-lived JWE auth tokens (`create-microvm-auth-token`, `X-aws-proxy-auth` header, port-scoped) and explicit WebSocket/HTTP2/gRPC/SSE support, lifecycle hooks (`/run`, `/suspend`, `/resume`, `/terminate`) POSTed to the app including on max-duration termination, per-VM 16 KB `runHookPayload` at run time, ARM64 only, sizes 0.5–8 GB baseline memory (4× vertical burst, vCPU = memory/2), disk 8–32 GB. Pricing is per-second (≈$0.126/h for the default 2 GB/1 vCPU baseline: $0.0000277/vCPU-s + $0.0000037/GB-s), suspended VMs cost only snapshot storage ($0.08/GB-month; suspend writes $0.0038/GB, resume reads $0.00155/GB). Regions: us-east-1, us-east-2, us-west-2, eu-west-1, ap-northeast-1 — cross-cloud from our GCP control plane, which is just public HTTPS API calls plus a new AWS credential surface, but EFS and the egress connector require owning an AWS VPC.

Mapping onto the port:

- **Durable data**: per-orb EFS access point mounted by the runtime in the `/run` hook (mounting during image build is useless — the NFS mount would be baked into a snapshot shared by all VMs, and NFS TCP state does not survive snapshot restore; `/resume` must revalidate the mount too). This preserves the GCE-style split better than exe.dev does: runtime-image upgrades are trivial (terminate, `run-microvm` from the new image version, remount the same EFS path).
- **`stop`**: short-term idle stop maps to `suspend-microvm` (state fully preserved, near-instant resume, ~zero cost) — but suspended time still burns the 8 h budget, so long-term stop must be flush + `terminate-microvm`, with "stopped" meaning "no VM exists; EFS holds the orb state" and `start` meaning "run a fresh VM + remount".
- **Rotation** (new lifecycle obligation no other provider has): the control plane must track VM age and proactively drain + terminate + re-run before the 8 h cap. The `/terminate` hook does fire on cap-exceeded termination, but its timeout is undocumented, so the hook is a backstop, not the plan.
- **`observe`/`list`**: `list-microvms` + `get-microvm`; definitive absence = not in list (plus EFS presence distinguishing "stopped" from "never existed"). Orb↔VM association goes through the run-hook payload and control-plane records; tags exist on images, per-VM tagging needs verification.
- **Network path**: same inversion as exe.dev — `runtimeAddress` grows provider-supplied headers (JWE token), the runtime broker needs public egress and token-refresh logic (tokens are minted per call with configurable expiry; maximum expiry undocumented), and WebSockets are officially supported (server-side connections can send headers, so the subprotocol workaround is browser-only).
- **Endpoint bandwidth is capped** (1–16 MB/s scaling with size) but applies only to endpoint traffic; git and package traffic uses the egress path.

Unverified empirically, in rough order of risk: (1) EFS/NFS mount through a VPC egress connector from inside a MicroVM — nothing documents it, it merely follows from "VPC egress + CAP_SYS_ADMIN"; (2) git/workspace performance on EFS; (3) NFS mount survival across suspend/resume; (4) `/terminate` hook timeout; (5) auth-token maximum expiry and mint rate limits; (6) account memory quota headroom (quota covers RUNNING+SUSPENDED combined). Full writeup: [`docs/AWS-MICROVMS.md`](docs/AWS-MICROVMS.md). See open question 37.

## Rejected: Cloud Workstations

Cloud Workstations was evaluated and rejected due to pricing and limited value relative to a custom control plane:

- normal Compute Engine charges;
- an additional `$0.05 × vCPU` per active workstation hour;
- a fixed `$0.20/hour` cluster fee;
- no documented Spot configuration in the stable or beta workstation configuration schema;
- we would still need custom health, history replication, restart recovery, and application control-plane logic.

## Rejected: suspend/resume

Suspend/resume was benchmarked on a Spot `n2d-highmem-4` in `us-central1-a`, using Debian 12 and Node.js 24. Across representative samples, resume generally saved only about 5–11 seconds relative to stop/start, with substantial variance. Suspend itself was slower than stop, though that latency could happen after the user left.

All tested resumes preserved process state, but the payoff did not justify another lifecycle path in the first version. One Spot preemption also occurred during the benchmark, reinforcing the need for full restart recovery.

Decision: implement stop/start only for now. All temporary benchmark cloud resources were deleted.
