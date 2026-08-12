import { createHash, randomBytes } from "node:crypto";
import {
  CONTROL_PLANE_URL_ENV,
  PREVIEW_HOST_ENV,
  previewHost,
  RUNTIME_TOKEN_ENV,
  TAILSCALE_AUTH_KEY_ENV,
  TAILSCALE_HOSTNAME_ENV,
  tailscaleHostname,
} from "@pi-orb/protocol";
import type { SimulationTask } from "determined";
import { err, ok, type Result, ResultAsync } from "neverthrow";
import type { OrbHostProviderError } from "../../domain/errors.ts";
import type {
  OperationContext,
  OrbHostObservation,
  OrbHostProvider,
  OrbHostRef,
  OrbHostState,
  ProvisionedOrbHost,
  ProvisionOrbHostRequest,
  StartOrbHostRequest,
} from "../../domain/ports.ts";
import type { TailscaleHostOptions } from "../tailscale/client.ts";
import type { GceApiTransport, GceResponse } from "./api.ts";

export interface GceOrbHostProviderOptions {
  readonly projectId: string;
  readonly zone: string;
  /** e.g. "n2d-highmem-4"; provisioned as Spot with STOP on preemption. */
  readonly machineType: string;
  /** Full or partial subnetwork URL, e.g. "regions/us-central1/subnetworks/pi-orb-us-central1". */
  readonly subnetwork: string;
  /** Dedicated minimal service account for orb VMs (docs/credentials.md). */
  readonly serviceAccount: string;
  /** Orb runtime container image (digest-pinned in deployment). */
  readonly runtimeImage: string;
  /** Broker base URL as reachable from orb VMs (the runtime-role service). */
  readonly controlPlaneUrl: string;
  readonly dataDiskSizeGb?: number;
  readonly extraEnv?: Readonly<Record<string, string>>;
  /**
   * Tailscale port exposure (docs/ports.md). Enabling it changes the startup
   * script text, so `ensureCurrentScript` repairs existing hosts onto it once
   * — and mints the auth key they are missing while doing so.
   */
  readonly tailscale?: TailscaleHostOptions;
  /**
   * Deploy-monotonic script generation (docs/host-provider.md). Stamped into
   * instance metadata and used to fence script repairs: a revision never
   * repairs a host stamped by a *newer* one, which is what turns the deploy
   * rollover from a repair war into a one-way upgrade
   * (docs/postmortems/2026-08-06-rollover-repair-war-corrupt-image.md).
   * Absent means 0 — see the note on `stampedGeneration` for why that is the
   * safe direction to fail.
   */
  readonly scriptGeneration?: number;
}

const ORB_LABEL = "pi-orb-orb-id";
const INCARNATION_LABEL = "pi-orb-host-incarnation";
const TOKEN_METADATA_KEY = "pi-orb-runtime-token";
const SCRIPT_HASH_METADATA_KEY = "pi-orb-script-sha256";
/**
 * The generation of the control-plane revision that last wrote the script.
 * Decimal string; absent or unparseable reads as 0.
 */
const SCRIPT_GENERATION_METADATA_KEY = "pi-orb-script-generation";
const REPO_URL_METADATA_KEY = "pi-orb-repository-url";
/** The auth key lives in metadata, never in the script: it is per-orb state
 * and would otherwise make `pi-orb-script-sha256` differ for every host. */
const TAILSCALE_KEY_METADATA_KEY = "pi-orb-tailscale-auth-key";
/**
 * Guest attributes are off by default. Without this key every `report()` PUT
 * from the startup script 404s (swallowed by its `|| true`) and `diagnose`
 * has nothing to read — which is how the 2026-08-06 crash loop stayed
 * invisible (docs/postmortems/2026-08-06-rollover-repair-war-corrupt-image.md).
 */
const GUEST_ATTRIBUTES_METADATA_KEY = "enable-guest-attributes";
/**
 * COS's logging agent ships container stdout/stderr to Cloud Logging: the one
 * evidence channel that outlives the VM, which matters because the lifecycle
 * machinery stops failed hosts aggressively (same postmortem).
 */
const LOGGING_METADATA_KEY = "google-logging-enabled";
const DATA_DEVICE = "pi-orb-data";
/**
 * Guest-attribute paths this provider writes from the VM and reads back. A
 * guest attribute is `namespace/key`, so both live directly under the `pi-orb`
 * namespace and each `getGuestAttributes?queryPath=…` returns one item.
 */
const STARTUP_ATTRIBUTE = { path: "pi-orb/startup", key: "startup" } as const;
const CONTAINER_ATTRIBUTE = { path: "pi-orb/container", key: "container" } as const;
const GUEST_ATTRIBUTES_URL =
  "http://metadata.google.internal/computeMetadata/v1/instance/guest-attributes";
/** Transient systemd unit that owns the container-state reporter loop. */
const REPORTER_UNIT = "pi-orb-container-reporter";

/**
 * Observability metadata every host must carry. Written on insert and
 * rewritten by `ensureCurrentScript`, so hosts created before these existed
 * adopt them on their next repair rather than staying blind forever.
 */
const observabilityMetadataItems = (): { key: string; value: string }[] => [
  { key: GUEST_ATTRIBUTES_METADATA_KEY, value: "TRUE" },
  { key: LOGGING_METADATA_KEY, value: "true" },
];

/**
 * The generation stamped on an instance. Anything unreadable is 0, the lowest
 * generation there is, so an unstamped host (every host created before this
 * existed) is repaired forward by the first revision that meets it instead of
 * being fenced off from repairs forever.
 */
export function stampedGeneration(instance: Record<string, unknown>): number {
  const raw = metadataValue(instance, SCRIPT_GENERATION_METADATA_KEY);
  if (raw === null) return 0;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

const legacyInstanceName = (orbId: string): string => `pi-orb-${orbId}`;
const instanceName = (orbId: string, incarnation: number): string =>
  `${legacyInstanceName(orbId)}-i${incarnation}`;

function instanceIncarnation(instance: Record<string, unknown>): number | null {
  const labels = (instance["labels"] ?? {}) as Record<string, unknown>;
  const raw = labels[INCARNATION_LABEL];
  if (raw === undefined || raw === null) return 0;
  if (typeof raw !== "string" || !/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : null;
}
const diskName = (orbId: string): string => `pi-orb-data-${orbId}`;

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function providerError(
  operation: OrbHostProviderError["operation"],
  code: OrbHostProviderError["code"],
  message: string,
  retryable: boolean,
): OrbHostProviderError {
  return { type: "orb_host_provider_error", provider: "gce", operation, code, message, retryable };
}

/** GCE instance status → OrbHostState (docs/host-provider.md). */
export function mapInstanceStatus(status: string): OrbHostState {
  switch (status) {
    case "RUNNING":
      return "running";
    case "PROVISIONING":
    case "STAGING":
    case "REPAIRING":
      return "starting";
    case "STOPPING":
    case "SUSPENDING":
      return "stopping";
    case "TERMINATED":
    case "SUSPENDED":
      return "stopped";
    default:
      return "failed";
  }
}

/** Read a metadata attribute from an instance resource. */
export function metadataValue(instance: Record<string, unknown>, key: string): string | null {
  const metadata = instance["metadata"] as Record<string, unknown> | undefined;
  const items = metadata?.["items"];
  if (!Array.isArray(items)) return null;
  for (const item of items) {
    const entry = item as Record<string, unknown>;
    if (entry["key"] === key && typeof entry["value"] === "string") return entry["value"];
  }
  return null;
}

/**
 * Startup script: mount the persistent data disk, then run the orb runtime
 * container with docker (replacing konlet — the declaration mechanism has no
 * ordering against the disk mount, docs/host-provider.md). The runtime token is read
 * back from instance metadata so it never appears in the script body.
 */
export function buildStartupScript(options: {
  readonly runtimeImage: string;
  readonly orbId: string;
  readonly incarnation?: number;
  readonly repositoryUrl: string;
  readonly controlPlaneUrl: string;
  readonly extraEnv: Readonly<Record<string, string>>;
  /**
   * Present only when tailscale port exposure is configured. Hostname and
   * preview host are pure functions of the orb id and static config, so they
   * are literals here; the secret auth key is read from metadata like the
   * runtime token.
   */
  readonly tailscale?: { readonly hostname: string; readonly previewHost: string };
}): string {
  // Each entry carries its own trailing continuation so an empty map never
  // leaves a blank line inside the docker run command.
  const extra = Object.entries(options.extraEnv)
    .map(([key, value]) => `  -e ${key}='${value}' \\\n`)
    .join("");
  const tailscaleFetch =
    options.tailscale === undefined
      ? ""
      : `TS_AUTHKEY=$(curl -sf -H 'Metadata-Flavor: Google' \\
  'http://metadata.google.internal/computeMetadata/v1/instance/attributes/${TAILSCALE_KEY_METADATA_KEY}')
`;
  const tailscaleEnv =
    options.tailscale === undefined
      ? ""
      : `  -e ${TAILSCALE_AUTH_KEY_ENV}="$TS_AUTHKEY" \\\n` +
        `  -e ${TAILSCALE_HOSTNAME_ENV}='${options.tailscale.hostname}' \\\n` +
        `  -e ${PREVIEW_HOST_ENV}='${options.tailscale.previewHost}' \\\n`;
  return `#!/bin/bash
set -euo pipefail
report() {
  curl -sf -X PUT -H 'Metadata-Flavor: Google' --data "$1" \\
    '${GUEST_ATTRIBUTES_URL}/${STARTUP_ATTRIBUTE.path}' || true
}
trap 'report "failed: line $LINENO: $BASH_COMMAND"' ERR
report starting
DISK=/dev/disk/by-id/google-${DATA_DEVICE}
MNT=/mnt/disks/orb-data
if ! blkid "$DISK" >/dev/null 2>&1; then
  mkfs.ext4 -m 0 -E lazy_itable_init=0,lazy_journal_init=0,discard "$DISK"
fi
mkdir -p "$MNT"
mountpoint -q "$MNT" || mount -o discard,defaults "$DISK" "$MNT"
report disk-mounted
# COS's host firewall admits only SSH by default; open the runtime port.
iptables -w -A INPUT -p tcp --dport 8080 -j ACCEPT
report port-opened
TOKEN=$(curl -sf -H 'Metadata-Flavor: Google' \\
  'http://metadata.google.internal/computeMetadata/v1/instance/attributes/${TOKEN_METADATA_KEY}')
${tailscaleFetch}# COS mounts / read-only; docker config must live on the stateful partition.
export DOCKER_CONFIG=/var/lib/pi-orb-docker
mkdir -p "$DOCKER_CONFIG"
docker-credential-gcr configure-docker --registries=$(echo '${options.runtimeImage}' | cut -d/ -f1)
# Never destroy the runnable container before the replacement image is local.
# Stop it first so an old runtime/protocol cannot answer readiness during the
# pull, but retain it as durable evidence/recovery material if every pull fails.
RUNTIME_IMAGE='${options.runtimeImage}'
PULL_ATTEMPTS=3
PULL_BACKOFF_SECONDS=5
docker stop pi-orb-runtime >/dev/null 2>&1 || true
for ((attempt = 1; attempt <= PULL_ATTEMPTS; attempt++)); do
  report "image-pull-attempt $attempt/$PULL_ATTEMPTS"
  if docker pull "$RUNTIME_IMAGE"; then
    report image-pulled
    break
  fi
  if (( attempt == PULL_ATTEMPTS )); then
    report "image-pull-failed attempts=$PULL_ATTEMPTS"
    exit 1
  fi
  sleep $((PULL_BACKOFF_SECONDS * attempt))
done
docker rm -f pi-orb-runtime >/dev/null 2>&1 || true
docker run --pull=never --detach --name pi-orb-runtime --restart unless-stopped \\
  --network host \\
  -v "$MNT":/workspace \\
  -e PI_ORB_ID='${options.orbId}' \\
  -e PI_ORB_HOST_INCARNATION='${options.incarnation ?? 0}' \\
  -e PI_ORB_REPOSITORY_URL='${options.repositoryUrl}' \\
  -e ${RUNTIME_TOKEN_ENV}="$TOKEN" \\
  -e ${CONTROL_PLANE_URL_ENV}='${options.controlPlaneUrl}' \\
${tailscaleEnv}${extra}  -e HOME=/workspace/home \\
  "$RUNTIME_IMAGE"
# Keep successful retry recovery reconstructable after the per-attempt markers
# above have been overwritten in the single startup guest attribute.
report "container-started imagePullAttempts=$attempt"
# The startup script ends here, but a container that crash-loops afterwards is
# invisible to the control plane (docs/postmortems/2026-08-06-rollover-repair-war-corrupt-image.md).
# Keep publishing its state for as long as the VM lives.
REPORTER=/var/lib/${REPORTER_UNIT}.sh
# COS runs this script from a systemd unit whose exit reaps everything left in
# its cgroup, so a plain background child (even under setsid/nohup) dies with
# it; only a transient unit owned by PID 1 survives. Re-running the script must
# replace that unit rather than stack a second reporter, and must never be the
# thing that fails the boot. Stop first: bash reads a script file lazily, so
# rewriting it under a running reporter would corrupt that reporter.
systemctl stop ${REPORTER_UNIT}.service >/dev/null 2>&1 || true
systemctl reset-failed ${REPORTER_UNIT}.service >/dev/null 2>&1 || true
cat >"$REPORTER" <<'REPORTER_EOF'
#!/bin/bash
# Best-effort by construction: neither a missing container nor an unreachable
# metadata server may end the loop.
while true; do
  STATE=$(docker inspect \\
    -f 'status={{.State.Status}} restartCount={{.RestartCount}} lastExitCode={{.State.ExitCode}}' \\
    pi-orb-runtime 2>/dev/null || echo 'status=absent restartCount=0 lastExitCode=0')
  curl -sf -X PUT -H 'Metadata-Flavor: Google' \\
    --data "$STATE at=$(date -u +%Y-%m-%dT%H:%M:%SZ)" \\
    '${GUEST_ATTRIBUTES_URL}/${CONTAINER_ATTRIBUTE.path}' || true
  sleep 15
done
REPORTER_EOF
systemd-run --unit=${REPORTER_UNIT} --collect \\
  --property=Restart=always --property=RestartSec=15 \\
  /bin/bash "$REPORTER" || report container-reporter-failed
`;
}

/**
 * `GceOrbHostProvider` (docs/host-provider.md/docs/host-provider.md): one Spot COS VM plus one
 * persistent data disk per orb. Read-back token model: the token lives in
 * instance metadata; provision reports the hash of what the instance
 * actually carries. Restart-in-place: recovery from stop or preemption is
 * `instances.start` on the same instance and disks.
 */
export class GceOrbHostProvider implements OrbHostProvider {
  readonly kind = "gce";
  private readonly api: GceApiTransport;
  private readonly options: GceOrbHostProviderOptions;

  constructor(api: GceApiTransport, options: GceOrbHostProviderOptions) {
    this.api = api;
    this.options = options;
  }

  private zonePath(suffix: string): string {
    return `projects/${this.options.projectId}/zones/${this.options.zone}/${suffix}`;
  }

  private request(
    operation: OrbHostProviderError["operation"],
    method: "GET" | "POST" | "DELETE",
    path: string,
    context: OperationContext,
    body?: Record<string, unknown>,
  ): ResultAsync<GceResponse, OrbHostProviderError> {
    return ResultAsync.fromPromise(
      this.api.request({
        method,
        path,
        ...(body === undefined ? {} : { body }),
        signal: context.signal,
      }),
      (error) => {
        const message = error instanceof Error ? error.message : String(error);
        if (context.signal.aborted) return providerError(operation, "cancelled", message, true);
        return providerError(operation, "unavailable", message, true);
      },
    );
  }

  /**
   * Poll a zonal operation to DONE (HTTP acceptance is not completion). The
   * `wait` endpoint may return early; loop until DONE or cancellation. An
   * operation error surfaces typed — capacity exhaustion is non-retryable
   * by decision (docs/host-provider.md): the orb fails to the user.
   */
  private async waitOperation(
    task: SimulationTask,
    operation: OrbHostProviderError["operation"],
    opName: string,
    context: OperationContext,
  ): Promise<Result<void, OrbHostProviderError>> {
    for (;;) {
      if (context.signal.aborted) {
        return err(providerError(operation, "cancelled", "cancelled waiting for operation", true));
      }
      const waited = await this.request(
        operation,
        "POST",
        this.zonePath(`operations/${opName}/wait`),
        context,
      );
      if (waited.isErr()) return err(waited.error);
      const body = waited.value.body;
      if (body["status"] !== "DONE") {
        await task.sleep(1_000, "gce operation pending");
        continue;
      }
      const opError = body["error"] as
        | { errors?: { code?: string; message?: string }[] }
        | undefined;
      const first = opError?.errors?.[0];
      if (first !== undefined) {
        const code = String(first.code ?? "");
        const capacity =
          code === "ZONE_RESOURCE_POOL_EXHAUSTED" || code === "RESOURCE_POOL_EXHAUSTED";
        return err(
          providerError(
            operation,
            "operation_failed",
            `${code}: ${String(first.message ?? "operation failed")}`,
            !capacity,
          ),
        );
      }
      return ok(undefined);
    }
  }

  /**
   * The one script generator for this provider: insert, script-hash repair,
   * and `start()`'s re-derivation all go through it, so the three can never
   * disagree about what the current script is.
   */
  private expectedScript(orbId: string, incarnation: number, repositoryUrl: string): string {
    const tailscale = this.options.tailscale;
    return buildStartupScript({
      runtimeImage: this.options.runtimeImage,
      orbId,
      incarnation,
      repositoryUrl,
      controlPlaneUrl: this.options.controlPlaneUrl,
      extraEnv: this.options.extraEnv ?? {},
      ...(tailscale === undefined
        ? {}
        : {
            tailscale: {
              hostname: tailscaleHostname(orbId),
              previewHost: previewHost(orbId, tailscale.tailnetDnsName),
            },
          }),
    });
  }

  /**
   * Mint the per-orb tailnet auth key, or nothing when the feature is off. A
   * mint failure is retryable whatever its cause: the reconciler provisions
   * again rather than failing the orb over a tailnet hiccup.
   */
  private async mintTailscaleKey(
    operation: OrbHostProviderError["operation"],
    orbId: string,
    incarnation: number,
    context: OperationContext,
  ): Promise<Result<string | null, OrbHostProviderError>> {
    const tailscale = this.options.tailscale;
    if (tailscale === undefined) return ok(null);
    const key = await tailscale.minter.mintAuthKey(orbId, incarnation, context.signal);
    if (key.isErr()) {
      return err(
        providerError(
          operation,
          "operation_failed",
          `tailscale auth key mint failed: ${key.error.message}`,
          true,
        ),
      );
    }
    return ok(key.value);
  }

  /**
   * Bring a reused instance's startup script up to date (docs/host-provider.md rollout
   * caveat, open question 32). The stamped script hash is compared with the
   * script this provider would generate; a mismatch means the instance was
   * created by a different control-plane revision — or predates stamping —
   * and would boot the wrong runtime image. Repair stops the instance if
   * needed, rewrites the script metadata while preserving the runtime token
   * (so the committed token hash stays valid), and starts it. Provision and
   * start only run while the orb is `creating`/`starting`, so the bounce
   * never interrupts a ready runtime.
   *
   * Repairs are fenced forward-only by `pi-orb-script-generation`: a revision
   * that meets a host stamped by a *newer* generation leaves it alone. Without
   * that fence two revisions with different expected scripts each read the
   * other's script as damage, and every repair's stop re-arms the other side —
   * the war that hard-bounced a VM through its first image pull on 2026-08-06
   * (docs/postmortems/2026-08-06-rollover-repair-war-corrupt-image.md). Equal
   * generations still repair on hash mismatch, which is what local development
   * (always generation 0) and same-revision config changes need.
   */
  private async ensureCurrentScript(
    task: SimulationTask,
    operation: OrbHostProviderError["operation"],
    instance: Record<string, unknown>,
    orbId: string,
    repositoryUrl: string,
    context: OperationContext,
  ): Promise<Result<"current" | "repaired", OrbHostProviderError>> {
    const name = String(instance["name"] ?? "");
    const script = this.expectedScript(orbId, instanceIncarnation(instance) ?? 0, repositoryUrl);
    const expectedHash = sha256Hex(script);
    if (metadataValue(instance, SCRIPT_HASH_METADATA_KEY) === expectedHash) return ok("current");
    const generation = this.options.scriptGeneration ?? 0;
    const stamped = stampedGeneration(instance);
    if (stamped > generation) {
      // A newer revision owns this host's script. Its script is the one that
      // should boot, so the mismatch is not damage — it is the future.
      task.log(`gce host ${name} carries newer script generation ${stamped}; skipping repair`);
      return ok("current");
    }

    let current = instance;
    const status = String(current["status"] ?? "");
    if (status !== "TERMINATED" && status !== "SUSPENDED") {
      const stopped = await this.request(
        operation,
        "POST",
        this.zonePath(`instances/${name}/stop`),
        context,
      );
      if (stopped.isErr()) return err(stopped.error);
      if (stopped.value.status !== 200) {
        return err(
          providerError(
            operation,
            "operation_failed",
            `stop for script repair HTTP ${stopped.value.status}`,
            true,
          ),
        );
      }
      const waited = await this.waitOperation(
        task,
        operation,
        String(stopped.value.body["name"] ?? ""),
        context,
      );
      if (waited.isErr()) return err(waited.error);
      // The metadata fingerprint may have moved; re-read before mutating.
      const reread = await this.request(
        operation,
        "GET",
        this.zonePath(`instances/${name}`),
        context,
      );
      if (reread.isErr()) return err(reread.error);
      if (reread.value.status !== 200) {
        return err(
          providerError(
            operation,
            "unavailable",
            `instance re-get HTTP ${reread.value.status}`,
            true,
          ),
        );
      }
      current = reread.value.body;
    }

    const metadata = (current["metadata"] ?? {}) as Record<string, unknown>;
    const fingerprint = metadata["fingerprint"];
    if (typeof fingerprint !== "string") {
      return err(
        providerError(operation, "unavailable", "instance metadata has no fingerprint", true),
      );
    }
    const items = Array.isArray(metadata["items"])
      ? (metadata["items"] as { key?: unknown; value?: unknown }[])
      : [];
    // Everything not rewritten below survives the repair (the runtime token
    // and the tailscale auth key most importantly). The observability keys are
    // rewritten rather than merely preserved so hosts created before they
    // existed adopt them here — the repair is the only upgrade path they get.
    const rewritten = new Set<unknown>([
      "startup-script",
      SCRIPT_HASH_METADATA_KEY,
      SCRIPT_GENERATION_METADATA_KEY,
      REPO_URL_METADATA_KEY,
      GUEST_ATTRIBUTES_METADATA_KEY,
      LOGGING_METADATA_KEY,
    ]);
    const preserved = items.filter((item) => !rewritten.has(item.key));
    // Preserved above (like the runtime token) when the host already has one.
    // When it does not, the repair is what turns tailscale on for this host,
    // and the new script would `curl -sf` a metadata key that does not exist
    // — fatal under `set -e`. Mint it here so script and metadata land in the
    // same setMetadata call.
    const adopted =
      metadataValue(current, TAILSCALE_KEY_METADATA_KEY) === null
        ? await this.mintTailscaleKey(operation, orbId, instanceIncarnation(current) ?? 0, context)
        : ok<string | null, OrbHostProviderError>(null);
    if (adopted.isErr()) return err(adopted.error);
    const updated = await this.request(
      operation,
      "POST",
      this.zonePath(`instances/${name}/setMetadata`),
      context,
      {
        fingerprint,
        items: [
          ...preserved,
          ...observabilityMetadataItems(),
          ...(adopted.value === null
            ? []
            : [{ key: TAILSCALE_KEY_METADATA_KEY, value: adopted.value }]),
          { key: "startup-script", value: script },
          { key: SCRIPT_HASH_METADATA_KEY, value: expectedHash },
          // The repair takes ownership of the script, so it takes ownership of
          // the fence too: from here on, older revisions leave this host alone.
          { key: SCRIPT_GENERATION_METADATA_KEY, value: String(generation) },
          { key: REPO_URL_METADATA_KEY, value: repositoryUrl },
        ],
      },
    );
    if (updated.isErr()) return err(updated.error);
    if (updated.value.status !== 200) {
      return err(
        providerError(
          operation,
          "operation_failed",
          `setMetadata HTTP ${updated.value.status}`,
          true,
        ),
      );
    }
    const metadataWaited = await this.waitOperation(
      task,
      operation,
      String(updated.value.body["name"] ?? ""),
      context,
    );
    if (metadataWaited.isErr()) return err(metadataWaited.error);
    const started = await this.startByName(task, name, context);
    if (started.isErr()) return err(started.error);
    task.log(
      `gce host ${name} startup script repaired to ${expectedHash.slice(0, 12)} ` +
        `(generation ${stamped} -> ${generation})`,
    );
    return ok("repaired");
  }

  private toObservation(instance: Record<string, unknown>): OrbHostObservation | null {
    const labels = (instance["labels"] ?? {}) as Record<string, unknown>;
    const orbId = labels[ORB_LABEL];
    if (typeof orbId !== "string") return null;
    const incarnation = instanceIncarnation(instance);
    if (incarnation === null) return null;
    const status = String(instance["status"] ?? "");
    const state = mapInstanceStatus(status);
    const interfaces = instance["networkInterfaces"];
    const internalIp =
      Array.isArray(interfaces) &&
      typeof (interfaces[0] as Record<string, unknown>)?.["networkIP"] === "string"
        ? String((interfaces[0] as Record<string, unknown>)["networkIP"])
        : "";
    return {
      ref: { provider: "gce", resourceId: String(instance["name"] ?? "") },
      orbId,
      incarnation,
      state,
      ...(state === "running" && internalIp !== ""
        ? { runtimeAddress: { baseUrl: `http://${internalIp}:8080` } }
        : {}),
      ...(status === "SUSPENDED" || status === "SUSPENDING"
        ? { failure: { code: "unsupported_state", message: `instance is ${status}` } }
        : {}),
    };
  }

  provision(
    task: SimulationTask,
    request: ProvisionOrbHostRequest,
    context: OperationContext,
  ): ResultAsync<ProvisionedOrbHost, OrbHostProviderError> {
    const run = async (): Promise<Result<ProvisionedOrbHost, OrbHostProviderError>> => {
      const name = instanceName(request.orbId, request.incarnation);
      const ref: OrbHostRef = { provider: "gce", resourceId: name };

      const existing = await this.request(
        "provision",
        "GET",
        this.zonePath(`instances/${name}`),
        context,
      );
      if (existing.isErr()) return err(existing.error);
      if (existing.value.status === 200) {
        const instance = existing.value.body;
        const labels = (instance["labels"] ?? {}) as Record<string, unknown>;
        if (labels[ORB_LABEL] !== request.orbId) {
          return err(
            providerError(
              "provision",
              "conflict",
              `instance ${name} is not labeled for this orb`,
              false,
            ),
          );
        }
        const incarnation = instanceIncarnation(instance);
        if (incarnation !== request.incarnation) {
          return err(
            providerError(
              "provision",
              "conflict",
              `instance ${name} carries incarnation ${String(incarnation)}, expected ${request.incarnation}`,
              false,
            ),
          );
        }
        const token = metadataValue(instance, TOKEN_METADATA_KEY);
        if (token === null) {
          return err(
            providerError(
              "provision",
              "operation_failed",
              `instance ${name} carries no runtime token`,
              false,
            ),
          );
        }
        const freshness = await this.ensureCurrentScript(
          task,
          "provision",
          instance,
          request.orbId,
          request.bootstrap.repositoryUrl,
          context,
        );
        if (freshness.isErr()) return err(freshness.error);
        if (
          freshness.value === "current" &&
          (instance["status"] === "TERMINATED" || instance["status"] === "SUSPENDED")
        ) {
          const started = await this.startByName(task, name, context);
          if (started.isErr()) return err(started.error);
        }
        task.log(`gce host ${name} reused (read-back token)`);
        return ok({ ref, incarnation, runtimeTokenHash: sha256Hex(token) });
      }
      if (existing.value.status !== 404) {
        return err(
          providerError(
            "provision",
            "unavailable",
            `instance get HTTP ${existing.value.status}`,
            true,
          ),
        );
      }

      // Ensure the persistent data disk (autoDelete=false; survives the VM).
      const disk = await this.request(
        "provision",
        "GET",
        this.zonePath(`disks/${diskName(request.orbId)}`),
        context,
      );
      if (disk.isErr()) return err(disk.error);
      if (disk.value.status === 404) {
        const created = await this.request("provision", "POST", this.zonePath("disks"), context, {
          name: diskName(request.orbId),
          sizeGb: String(this.options.dataDiskSizeGb ?? 50),
          type: this.zonePath("diskTypes/pd-balanced"),
          labels: { [ORB_LABEL]: request.orbId },
        });
        if (created.isErr()) return err(created.error);
        if (created.value.status === 200) {
          const waited = await this.waitOperation(
            task,
            "provision",
            String(created.value.body["name"] ?? ""),
            context,
          );
          if (waited.isErr()) return err(waited.error);
        } else if (created.value.status !== 409) {
          return err(
            providerError(
              "provision",
              "operation_failed",
              `disk insert HTTP ${created.value.status}`,
              true,
            ),
          );
        }
      }

      const runtimeToken = randomBytes(32).toString("hex");
      // Minted only for an instance actually about to be inserted; a reused
      // one keeps the key it was created with (read-back model).
      const tailscaleKey = await this.mintTailscaleKey(
        "provision",
        request.orbId,
        request.incarnation,
        context,
      );
      if (tailscaleKey.isErr()) return err(tailscaleKey.error);
      const startupScript = this.expectedScript(
        request.orbId,
        request.incarnation,
        request.bootstrap.repositoryUrl,
      );
      const inserted = await this.request(
        "provision",
        "POST",
        this.zonePath("instances"),
        context,
        {
          name,
          machineType: this.zonePath(`machineTypes/${this.options.machineType}`),
          labels: {
            [ORB_LABEL]: request.orbId,
            [INCARNATION_LABEL]: String(request.incarnation),
          },
          scheduling: {
            provisioningModel: "SPOT",
            instanceTerminationAction: "STOP",
          },
          disks: [
            {
              boot: true,
              autoDelete: true,
              initializeParams: {
                sourceImage: "projects/cos-cloud/global/images/family/cos-stable",
                diskSizeGb: "20",
              },
            },
            {
              source: this.zonePath(`disks/${diskName(request.orbId)}`),
              deviceName: DATA_DEVICE,
              autoDelete: false,
            },
          ],
          networkInterfaces: [
            {
              subnetwork: `projects/${this.options.projectId}/${this.options.subnetwork}`,
              // Ephemeral external IP for outbound only (no NAT, docs/host-provider.md); the
              // VPC firewall denies all inbound except the control plane.
              accessConfigs: [{ type: "ONE_TO_ONE_NAT", name: "External NAT" }],
            },
          ],
          serviceAccounts: [
            {
              email: this.options.serviceAccount,
              scopes: ["https://www.googleapis.com/auth/cloud-platform"],
            },
          ],
          metadata: {
            items: [
              { key: TOKEN_METADATA_KEY, value: runtimeToken },
              ...observabilityMetadataItems(),
              ...(tailscaleKey.value === null
                ? []
                : [{ key: TAILSCALE_KEY_METADATA_KEY, value: tailscaleKey.value }]),
              { key: "startup-script", value: startupScript },
              // Script-version stamp plus the input needed to re-derive the
              // script on later starts (ensureCurrentScript), plus the
              // generation that fences repairs forward-only.
              { key: SCRIPT_HASH_METADATA_KEY, value: sha256Hex(startupScript) },
              {
                key: SCRIPT_GENERATION_METADATA_KEY,
                value: String(this.options.scriptGeneration ?? 0),
              },
              { key: REPO_URL_METADATA_KEY, value: request.bootstrap.repositoryUrl },
            ],
          },
        },
      );
      if (inserted.isErr()) return err(inserted.error);
      if (inserted.value.status === 409) {
        // Lost a create race: adopt the winner's token.
        const winner = await this.request(
          "provision",
          "GET",
          this.zonePath(`instances/${name}`),
          context,
        );
        if (winner.isErr()) return err(winner.error);
        const token =
          winner.value.status === 200 ? metadataValue(winner.value.body, TOKEN_METADATA_KEY) : null;
        if (token === null) {
          return err(providerError("provision", "conflict", "racing instance has no token", true));
        }
        const incarnation = instanceIncarnation(winner.value.body);
        if (incarnation !== request.incarnation) {
          return err(providerError("provision", "conflict", "racing incarnation mismatch", false));
        }
        return ok({ ref, incarnation, runtimeTokenHash: sha256Hex(token) });
      }
      if (inserted.value.status !== 200) {
        return err(
          providerError(
            "provision",
            "operation_failed",
            `instance insert HTTP ${inserted.value.status}`,
            true,
          ),
        );
      }
      const waited = await this.waitOperation(
        task,
        "provision",
        String(inserted.value.body["name"] ?? ""),
        context,
      );
      if (waited.isErr()) return err(waited.error);
      task.log(`provisioned gce host ${name}`);
      return ok({
        ref,
        incarnation: request.incarnation,
        runtimeTokenHash: sha256Hex(runtimeToken),
      });
    };
    return new ResultAsync(run());
  }

  private async startByName(
    task: SimulationTask,
    name: string,
    context: OperationContext,
  ): Promise<Result<void, OrbHostProviderError>> {
    const started = await this.request(
      "start",
      "POST",
      this.zonePath(`instances/${name}/start`),
      context,
    );
    if (started.isErr()) return err(started.error);
    if (started.value.status !== 200) {
      return err(
        providerError("start", "operation_failed", `start HTTP ${started.value.status}`, true),
      );
    }
    return this.waitOperation(task, "start", String(started.value.body["name"] ?? ""), context);
  }

  start(
    task: SimulationTask,
    request: StartOrbHostRequest,
    context: OperationContext,
  ): ResultAsync<void, OrbHostProviderError> {
    const run = async (): Promise<Result<void, OrbHostProviderError>> => {
      // Restart-in-place is where a stale startup script would otherwise
      // survive forever: check the stamp before booting (open question 32).
      const got = await this.request(
        "start",
        "GET",
        this.zonePath(`instances/${request.ref.resourceId}`),
        context,
      );
      if (got.isErr()) return err(got.error);
      if (got.value.status !== 200) {
        // Absence here is transient from the reconciler's viewpoint: the
        // next observe sees null and reprovisions.
        return err(
          providerError("start", "operation_failed", `instance get HTTP ${got.value.status}`, true),
        );
      }
      const instance = got.value.body;
      if (instanceIncarnation(instance) !== request.expectedIncarnation) {
        return err(providerError("start", "conflict", "instance incarnation mismatch", false));
      }
      const labels = (instance["labels"] ?? {}) as Record<string, unknown>;
      const orbId = labels[ORB_LABEL];
      if (typeof orbId !== "string") {
        return err(
          providerError(
            "start",
            "conflict",
            `instance ${request.ref.resourceId} is not a pi-orb host`,
            false,
          ),
        );
      }
      const repositoryUrl =
        metadataValue(instance, REPO_URL_METADATA_KEY) ??
        // Pre-stamp instances carry the URL only inside the script text.
        /-e PI_ORB_REPOSITORY_URL='([^']*)'/.exec(
          metadataValue(instance, "startup-script") ?? "",
        )?.[1] ??
        null;
      if (repositoryUrl === null) {
        return err(
          providerError(
            "start",
            "operation_failed",
            `instance ${request.ref.resourceId} carries no repository URL`,
            false,
          ),
        );
      }
      const freshness = await this.ensureCurrentScript(
        task,
        "start",
        instance,
        orbId,
        repositoryUrl,
        context,
      );
      if (freshness.isErr()) return err(freshness.error);
      // A repair already started the instance.
      if (freshness.value === "repaired") return ok(undefined);
      return this.startByName(task, request.ref.resourceId, context);
    };
    return new ResultAsync(run());
  }

  stop(
    task: SimulationTask,
    ref: OrbHostRef,
    context: OperationContext,
  ): ResultAsync<void, OrbHostProviderError> {
    const run = async (): Promise<Result<void, OrbHostProviderError>> => {
      const stopped = await this.request(
        "stop",
        "POST",
        this.zonePath(`instances/${ref.resourceId}/stop`),
        context,
      );
      if (stopped.isErr()) return err(stopped.error);
      // Absent or already-stopped is idempotent success.
      if (stopped.value.status === 404) return ok(undefined);
      if (stopped.value.status !== 200) {
        return err(
          providerError("stop", "operation_failed", `stop HTTP ${stopped.value.status}`, true),
        );
      }
      return this.waitOperation(task, "stop", String(stopped.value.body["name"] ?? ""), context);
    };
    return new ResultAsync(run());
  }

  /**
   * Enumerate this orb's instances by exact ownership label, validating name
   * and ownership for every entry. The incarnation stamp is parsed but left
   * nullable: deletion-grade `destroy` is authorized by ownership alone, so a
   * mangled stamp must not leave the orb permanently undeletable. Fence
   * decisions go through the strict `listFencedOrbInstances` variant instead.
   */
  private async listExactOrbInstances(
    operation: OrbHostProviderError["operation"],
    orbId: string,
    context: OperationContext,
  ): Promise<Result<{ name: string; incarnation: number | null }[], OrbHostProviderError>> {
    const instances: { name: string; incarnation: number | null }[] = [];
    let pageToken: string | undefined;
    do {
      const query = new URLSearchParams({ filter: `labels.${ORB_LABEL}=${orbId}` });
      if (pageToken !== undefined) query.set("pageToken", pageToken);
      const page = await this.request(
        operation,
        "GET",
        this.zonePath(`instances?${query.toString()}`),
        context,
      );
      if (page.isErr()) return err(page.error);
      if (page.value.status !== 200) {
        return err(
          providerError(operation, "unavailable", `instance list HTTP ${page.value.status}`, true),
        );
      }
      const items = page.value.body["items"];
      if (Array.isArray(items)) {
        for (const item of items) {
          const instance = item as Record<string, unknown>;
          const labels = (instance["labels"] ?? {}) as Record<string, unknown>;
          if (labels[ORB_LABEL] !== orbId) {
            return err(
              providerError(
                operation,
                "conflict",
                `filtered instance is not labeled for orb ${orbId}`,
                false,
              ),
            );
          }
          const name = instance["name"];
          if (typeof name !== "string" || name === "") {
            return err(
              providerError(
                operation,
                "conflict",
                `filtered instance for orb ${orbId} has no name`,
                false,
              ),
            );
          }
          instances.push({ name, incarnation: instanceIncarnation(instance) });
        }
      }
      const next = page.value.body["nextPageToken"];
      pageToken = typeof next === "string" ? next : undefined;
    } while (pageToken !== undefined);
    return ok(instances);
  }

  /**
   * Strict variant for the discard fence: every instance must carry a valid
   * incarnation stamp, because guessing could delete a newer incarnation.
   */
  private async listFencedOrbInstances(
    operation: OrbHostProviderError["operation"],
    orbId: string,
    context: OperationContext,
  ): Promise<Result<{ name: string; incarnation: number }[], OrbHostProviderError>> {
    const listed = await this.listExactOrbInstances(operation, orbId, context);
    if (listed.isErr()) return err(listed.error);
    const instances: { name: string; incarnation: number }[] = [];
    for (const instance of listed.value) {
      if (instance.incarnation === null) {
        return err(
          providerError(
            operation,
            "conflict",
            `instance ${instance.name} has an invalid incarnation label`,
            false,
          ),
        );
      }
      instances.push({ name: instance.name, incarnation: instance.incarnation });
    }
    return ok(instances);
  }

  private async deleteInstance(
    task: SimulationTask,
    operation: "discard" | "destroy",
    name: string,
    context: OperationContext,
  ): Promise<Result<void, OrbHostProviderError>> {
    const removed = await this.request(
      operation,
      "DELETE",
      this.zonePath(`instances/${name}`),
      context,
    );
    if (removed.isErr()) return err(removed.error);
    if (removed.value.status === 404) return ok(undefined);
    if (removed.value.status !== 200) {
      return err(
        providerError(
          operation,
          "operation_failed",
          `instance delete HTTP ${removed.value.status}`,
          true,
        ),
      );
    }
    return this.waitOperation(task, operation, String(removed.value.body["name"] ?? ""), context);
  }

  discardCompute(
    task: SimulationTask,
    request: { orbId: string; throughIncarnation: number },
    context: OperationContext,
  ): ResultAsync<void, OrbHostProviderError> {
    const run = async (): Promise<Result<void, OrbHostProviderError>> => {
      const listed = await this.listFencedOrbInstances("discard", request.orbId, context);
      if (listed.isErr()) return err(listed.error);
      for (const instance of listed.value) {
        if (instance.incarnation > request.throughIncarnation) continue;
        const removed = await this.deleteInstance(task, "discard", instance.name, context);
        if (removed.isErr()) return err(removed.error);
      }
      const verified = await this.listFencedOrbInstances("discard", request.orbId, context);
      if (verified.isErr()) return err(verified.error);
      if (verified.value.some((instance) => instance.incarnation <= request.throughIncarnation)) {
        return err(
          providerError("discard", "unavailable", "discarded instance is still visible", true),
        );
      }
      return ok(undefined);
    };
    return new ResultAsync(run());
  }

  destroy(
    task: SimulationTask,
    orbId: string,
    context: OperationContext,
  ): ResultAsync<void, OrbHostProviderError> {
    const run = async (): Promise<Result<void, OrbHostProviderError>> => {
      // Deletion-grade: exact ownership authorizes removal; the incarnation
      // stamp — valid or mangled — is irrelevant to destroying everything.
      const instances = await this.listExactOrbInstances("destroy", orbId, context);
      if (instances.isErr()) return err(instances.error);
      for (const instance of instances.value) {
        const removed = await this.deleteInstance(task, "destroy", instance.name, context);
        if (removed.isErr()) return err(removed.error);
      }

      const dataDiskName = diskName(orbId);
      const gotDisk = await this.request(
        "destroy",
        "GET",
        this.zonePath(`disks/${dataDiskName}`),
        context,
      );
      if (gotDisk.isErr()) return err(gotDisk.error);
      if (gotDisk.value.status === 404) return ok(undefined);
      if (gotDisk.value.status !== 200) {
        return err(
          providerError(
            "destroy",
            "unavailable",
            `data disk get HTTP ${gotDisk.value.status}`,
            true,
          ),
        );
      }
      const diskLabels = (gotDisk.value.body["labels"] ?? {}) as Record<string, unknown>;
      if (diskLabels[ORB_LABEL] !== orbId) {
        return err(
          providerError(
            "destroy",
            "conflict",
            `data disk ${dataDiskName} is not labeled for orb ${orbId}`,
            false,
          ),
        );
      }
      const disk = await this.request(
        "destroy",
        "DELETE",
        this.zonePath(`disks/${dataDiskName}`),
        context,
      );
      if (disk.isErr()) return err(disk.error);
      if (disk.value.status === 404) return ok(undefined);
      if (disk.value.status !== 200) {
        return err(
          providerError(
            "destroy",
            "operation_failed",
            `data disk delete HTTP ${disk.value.status}`,
            true,
          ),
        );
      }
      return this.waitOperation(task, "destroy", String(disk.value.body["name"] ?? ""), context);
    };
    return new ResultAsync(run());
  }

  observe(
    _task: SimulationTask,
    ref: OrbHostRef,
    context: OperationContext,
  ): ResultAsync<OrbHostObservation | null, OrbHostProviderError> {
    return this.request(
      "observe",
      "GET",
      this.zonePath(`instances/${ref.resourceId}`),
      context,
    ).andThen((response) => {
      if (response.status === 404) return ok(null);
      if (response.status !== 200) {
        return err(
          providerError("observe", "unavailable", `instance get HTTP ${response.status}`, true),
        );
      }
      return ok(this.toObservation(response.body));
    });
  }

  /** One guest-attribute query; null whenever the attribute was never written. */
  private guestAttribute(
    resourceId: string,
    attribute: { readonly path: string; readonly key: string },
    context: OperationContext,
  ): ResultAsync<string | null, OrbHostProviderError> {
    const query = encodeURIComponent(attribute.path);
    return this.request(
      "observe",
      "GET",
      this.zonePath(`instances/${resourceId}/getGuestAttributes?queryPath=${query}`),
      context,
    ).andThen((response) => {
      // 404: instance gone or no attribute written yet — nothing known.
      if (response.status === 404) return ok<string | null, OrbHostProviderError>(null);
      if (response.status !== 200) {
        return err(
          providerError("observe", "unavailable", `guest attributes HTTP ${response.status}`, true),
        );
      }
      const items = (response.body["queryValue"] as Record<string, unknown> | undefined)?.["items"];
      if (!Array.isArray(items)) return ok<string | null, OrbHostProviderError>(null);
      for (const item of items) {
        const entry = item as Record<string, unknown>;
        if (entry["key"] === attribute.key && typeof entry["value"] === "string") {
          return ok<string | null, OrbHostProviderError>(entry["value"]);
        }
      }
      return ok<string | null, OrbHostProviderError>(null);
    });
  }

  diagnose(
    _task: SimulationTask,
    ref: OrbHostRef,
    context: OperationContext,
  ): ResultAsync<string | null, OrbHostProviderError> {
    const run = async (): Promise<Result<string | null, OrbHostProviderError>> => {
      const startup = await this.guestAttribute(ref.resourceId, STARTUP_ATTRIBUTE, context);
      if (startup.isErr()) return err(startup.error);
      // Container state is supplementary evidence: a failure reading it must
      // never make the whole diagnosis uncertain (the caller defers its
      // decision a poll on Err) and so suppress the startup markers.
      const container = await this.guestAttribute(
        ref.resourceId,
        CONTAINER_ATTRIBUTE,
        context,
      ).unwrapOr(null);
      const parts: string[] = [];
      if (startup.value !== null) parts.push(`startup-script: ${startup.value}`);
      if (container !== null) parts.push(`container: ${container}`);
      return ok(parts.length === 0 ? null : parts.join("; "));
    };
    return new ResultAsync(run());
  }

  listManagedHosts(
    _task: SimulationTask,
    context: OperationContext,
  ): ResultAsync<OrbHostObservation[], OrbHostProviderError> {
    const run = async (): Promise<Result<OrbHostObservation[], OrbHostProviderError>> => {
      const observations: OrbHostObservation[] = [];
      let pageToken: string | undefined;
      do {
        const query = new URLSearchParams({ filter: `labels.${ORB_LABEL}:*` });
        if (pageToken !== undefined) query.set("pageToken", pageToken);
        const page = await this.request(
          "list",
          "GET",
          this.zonePath(`instances?${query.toString()}`),
          context,
        );
        if (page.isErr()) return err(page.error);
        if (page.value.status !== 200) {
          return err(
            providerError("list", "unavailable", `instance list HTTP ${page.value.status}`, true),
          );
        }
        const items = page.value.body["items"];
        if (Array.isArray(items)) {
          for (const item of items) {
            const observation = this.toObservation(item as Record<string, unknown>);
            if (observation !== null) observations.push(observation);
          }
        }
        const next = page.value.body["nextPageToken"];
        pageToken = typeof next === "string" ? next : undefined;
      } while (pageToken !== undefined);
      return ok(observations);
    };
    return new ResultAsync(run());
  }
}
