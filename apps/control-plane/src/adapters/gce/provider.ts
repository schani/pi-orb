import { createHash, randomBytes } from "node:crypto";
import { CONTROL_PLANE_URL_ENV, RUNTIME_TOKEN_ENV } from "@pi-orb/protocol";
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
} from "../../domain/ports.ts";
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
}

const ORB_LABEL = "pi-orb-orb-id";
const TOKEN_METADATA_KEY = "pi-orb-runtime-token";
const SCRIPT_HASH_METADATA_KEY = "pi-orb-script-sha256";
const REPO_URL_METADATA_KEY = "pi-orb-repository-url";
const DATA_DEVICE = "pi-orb-data";

const instanceName = (orbId: string): string => `pi-orb-${orbId}`;
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
  readonly repositoryUrl: string;
  readonly controlPlaneUrl: string;
  readonly extraEnv: Readonly<Record<string, string>>;
}): string {
  // Each entry carries its own trailing continuation so an empty map never
  // leaves a blank line inside the docker run command.
  const extra = Object.entries(options.extraEnv)
    .map(([key, value]) => `  -e ${key}='${value}' \\\n`)
    .join("");
  return `#!/bin/bash
set -euo pipefail
report() {
  curl -sf -X PUT -H 'Metadata-Flavor: Google' --data "$1" \\
    'http://metadata.google.internal/computeMetadata/v1/instance/guest-attributes/pi-orb/startup' || true
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
# COS mounts / read-only; docker config must live on the stateful partition.
export DOCKER_CONFIG=/var/lib/pi-orb-docker
mkdir -p "$DOCKER_CONFIG"
docker-credential-gcr configure-docker --registries=$(echo '${options.runtimeImage}' | cut -d/ -f1)
docker rm -f pi-orb-runtime >/dev/null 2>&1 || true
docker run --detach --name pi-orb-runtime --restart unless-stopped \\
  --network host \\
  -v "$MNT":/workspace \\
  -e PI_ORB_ID='${options.orbId}' \\
  -e PI_ORB_REPOSITORY_URL='${options.repositoryUrl}' \\
  -e ${RUNTIME_TOKEN_ENV}="$TOKEN" \\
  -e ${CONTROL_PLANE_URL_ENV}='${options.controlPlaneUrl}' \\
${extra}  '${options.runtimeImage}'
report container-started
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
    method: "GET" | "POST",
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

  private expectedScript(orbId: string, repositoryUrl: string): string {
    return buildStartupScript({
      runtimeImage: this.options.runtimeImage,
      orbId,
      repositoryUrl,
      controlPlaneUrl: this.options.controlPlaneUrl,
      extraEnv: this.options.extraEnv ?? {},
    });
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
   * never interrupts a ready runtime. A draining stale revision can still
   * "repair" a fresh host backward during its bounded drain window; the
   * surviving revision repairs it forward on its next pass.
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
    const script = this.expectedScript(orbId, repositoryUrl);
    const expectedHash = sha256Hex(script);
    if (metadataValue(instance, SCRIPT_HASH_METADATA_KEY) === expectedHash) return ok("current");

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
    const preserved = items.filter(
      (item) =>
        item.key !== "startup-script" &&
        item.key !== SCRIPT_HASH_METADATA_KEY &&
        item.key !== REPO_URL_METADATA_KEY,
    );
    const updated = await this.request(
      operation,
      "POST",
      this.zonePath(`instances/${name}/setMetadata`),
      context,
      {
        fingerprint,
        items: [
          ...preserved,
          { key: "startup-script", value: script },
          { key: SCRIPT_HASH_METADATA_KEY, value: expectedHash },
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
    task.log(`gce host ${name} startup script repaired to ${expectedHash.slice(0, 12)}`);
    return ok("repaired");
  }

  private toObservation(instance: Record<string, unknown>): OrbHostObservation | null {
    const labels = (instance["labels"] ?? {}) as Record<string, unknown>;
    const orbId = labels[ORB_LABEL];
    if (typeof orbId !== "string") return null;
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
      const name = instanceName(request.orbId);
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
        return ok({ ref, runtimeTokenHash: sha256Hex(token) });
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
      const startupScript = buildStartupScript({
        runtimeImage: this.options.runtimeImage,
        orbId: request.orbId,
        repositoryUrl: request.bootstrap.repositoryUrl,
        controlPlaneUrl: this.options.controlPlaneUrl,
        extraEnv: this.options.extraEnv ?? {},
      });
      const inserted = await this.request(
        "provision",
        "POST",
        this.zonePath("instances"),
        context,
        {
          name,
          machineType: this.zonePath(`machineTypes/${this.options.machineType}`),
          labels: { [ORB_LABEL]: request.orbId },
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
              { key: "startup-script", value: startupScript },
              // Script-version stamp plus the input needed to re-derive the
              // script on later starts (ensureCurrentScript).
              { key: SCRIPT_HASH_METADATA_KEY, value: sha256Hex(startupScript) },
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
        return ok({ ref, runtimeTokenHash: sha256Hex(token) });
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
      return ok({ ref, runtimeTokenHash: sha256Hex(runtimeToken) });
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
    ref: OrbHostRef,
    context: OperationContext,
  ): ResultAsync<void, OrbHostProviderError> {
    const run = async (): Promise<Result<void, OrbHostProviderError>> => {
      // Restart-in-place is where a stale startup script would otherwise
      // survive forever: check the stamp before booting (open question 32).
      const got = await this.request(
        "start",
        "GET",
        this.zonePath(`instances/${ref.resourceId}`),
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
      const labels = (instance["labels"] ?? {}) as Record<string, unknown>;
      const orbId = labels[ORB_LABEL];
      if (typeof orbId !== "string") {
        return err(
          providerError(
            "start",
            "conflict",
            `instance ${ref.resourceId} is not a pi-orb host`,
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
            `instance ${ref.resourceId} carries no repository URL`,
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
      return this.startByName(task, ref.resourceId, context);
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

  diagnose(
    _task: SimulationTask,
    ref: OrbHostRef,
    context: OperationContext,
  ): ResultAsync<string | null, OrbHostProviderError> {
    return this.request(
      "observe",
      "GET",
      this.zonePath(`instances/${ref.resourceId}/getGuestAttributes?queryPath=pi-orb%2Fstartup`),
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
        if (entry["key"] === "startup" && typeof entry["value"] === "string") {
          return ok<string | null, OrbHostProviderError>(`startup-script: ${entry["value"]}`);
        }
      }
      return ok<string | null, OrbHostProviderError>(null);
    });
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
