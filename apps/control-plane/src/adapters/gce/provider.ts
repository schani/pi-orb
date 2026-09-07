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
import { specFingerprintOf } from "../spec-fingerprint.ts";
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
  /** Exact immutable Compute Engine image resource, e.g. projects/p/global/images/pi-orb-20260905. */
  readonly imageResource: string;
  /** Numeric Compute Engine image ID recorded by the accepted image manifest. */
  readonly imageId: string;
  /** Broker base URL as reachable from orb VMs (the runtime-role service). */
  readonly controlPlaneUrl: string;
  readonly dataDiskSizeGb?: number;
  readonly extraEnv?: Readonly<Record<string, string>>;
  /** Tailscale port exposure; enabling it changes the immutable specification. */
  readonly tailscale?: TailscaleHostOptions;
  /** Deploy-monotone generation used to fence replacement decisions. */
  readonly specGeneration?: number;
}

const ORB_LABEL = "pi-orb-orb-id";
const INCARNATION_LABEL = "pi-orb-host-incarnation";
const SPEC_FINGERPRINT_METADATA_KEY = "pi-orb-host-spec-fingerprint";
const TOKEN_METADATA_KEY = "pi-orb-runtime-token";
/** Per-orb secret state, excluded from the host-spec fingerprint. */
const TAILSCALE_KEY_METADATA_KEY = "pi-orb-tailscale-auth-key";
/** Guest attributes are off by default. */
const GUEST_ATTRIBUTES_METADATA_KEY = "enable-guest-attributes";
const LOGGING_METADATA_KEY = "google-logging-enabled";
const CONFIG_METADATA_KEY = "pi-orb-config";
const DATA_DEVICE = "pi-orb-data";
/** The boot disk is disposable — the workspace lives on the data disk. */
const BOOT_DISK_SIZE_GB = "20";
const DEFAULT_DATA_DISK_SIZE_GB = 50;
/** Spot with STOP on preemption; the retained data disk survives the stop. */
const SCHEDULING = {
  provisioningModel: "SPOT",
  instanceTerminationAction: "STOP",
} as const;
const SERVICE_ACCOUNT_SCOPES = ["https://www.googleapis.com/auth/cloud-platform"] as const;
/**
 * Guest-attribute paths this provider writes from the VM and reads back. A
 * guest attribute is `namespace/key`, so both live directly under the `pi-orb`
 * namespace and each `getGuestAttributes?queryPath=…` returns one item.
 */
const BOOT_STATUS_ATTRIBUTE = {
  path: "pi-orb/boot-status",
  key: "boot-status",
} as const;

/** Non-secret launch facts shared by the insert body and the fingerprint. */
interface GceLaunchSpec {
  readonly imageResource: string;
  readonly imageId: string;
  readonly runtimeConfig: Readonly<Record<string, string>>;
  readonly bootImage: string;
  readonly bootDiskSizeGb: string;
  readonly machineType: string;
  readonly subnetwork: string;
  readonly serviceAccount: string;
  readonly scopes: readonly string[];
  readonly scheduling: {
    readonly provisioningModel: string;
    readonly instanceTerminationAction: string;
  };
  readonly dataDiskSizeGb: number;
}

/**
 * Observability metadata every immutable host carries from insertion.
 */
const observabilityMetadataItems = (): { key: string; value: string }[] => [
  { key: GUEST_ATTRIBUTES_METADATA_KEY, value: "TRUE" },
  { key: LOGGING_METADATA_KEY, value: "true" },
];

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
  return {
    type: "orb_host_provider_error",
    provider: "gce",
    operation,
    code,
    message,
    retryable,
  };
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
 * One Spot native Debian VM plus one persistent data disk per orb. The image
 * contains the runtime; instance metadata supplies per-orb configuration.
 */
export class GceOrbHostProvider implements OrbHostProvider {
  readonly kind = "gce";
  readonly specGeneration: number;
  private readonly api: GceApiTransport;
  private readonly options: GceOrbHostProviderOptions;

  constructor(api: GceApiTransport, options: GceOrbHostProviderOptions) {
    this.api = api;
    this.options = options;
    this.specGeneration = options.specGeneration ?? 0;
  }

  desiredSpecFingerprint(input: {
    readonly orbId: string;
    readonly repositoryUrl: string;
  }): string {
    // Rendered at incarnation 0 on purpose: the fingerprint describes the
    // desired specification, not which incarnation happens to carry it, so
    // rotating an incarnation must not read as a specification change.
    return specFingerprintOf({
      v: 1,
      ...this.launchSpec({
        orbId: input.orbId,
        incarnation: 0,
        repositoryUrl: input.repositoryUrl,
      }),
    });
  }

  /**
   * The one source of an orb host's non-secret launch facts: every field feeds
   * both the instance-insert body and `desiredSpecFingerprint`, so a host
   * cannot carry a setting the fingerprint does not cover — drift between the
   * two would leave stale compute looking current (docs/compute-replacement.md).
   *
   * Zone and project are deliberately absent. The data disk is zonal, so
   * compute replacement cannot move an orb: a replacement in the new zone would
   * come up on a fresh, empty workspace. A zone or project move is an explicit
   * operator migration, out of scope for this mechanism.
   */
  private launchSpec(input: {
    readonly orbId: string;
    readonly incarnation: number;
    readonly repositoryUrl: string;
  }): GceLaunchSpec {
    return {
      imageResource: this.options.imageResource,
      imageId: this.options.imageId,
      runtimeConfig: this.expectedConfig(input.orbId, input.incarnation, input.repositoryUrl),
      bootImage: this.options.imageResource,
      bootDiskSizeGb: BOOT_DISK_SIZE_GB,
      machineType: this.options.machineType,
      subnetwork: this.options.subnetwork,
      serviceAccount: this.options.serviceAccount,
      scopes: SERVICE_ACCOUNT_SCOPES,
      scheduling: SCHEDULING,
      dataDiskSizeGb: this.options.dataDiskSizeGb ?? DEFAULT_DATA_DISK_SIZE_GB,
    };
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
   * The insert body and fingerprint share this configuration composition.
   */
  private expectedConfig(
    orbId: string,
    incarnation: number,
    repositoryUrl: string,
  ): Readonly<Record<string, string>> {
    const tailscale = this.options.tailscale;
    return {
      ...(this.options.extraEnv ?? {}),
      PI_ORB_ID: orbId,
      PI_ORB_HOST_INCARNATION: String(incarnation),
      PI_ORB_REPOSITORY_URL: repositoryUrl,
      [CONTROL_PLANE_URL_ENV]: this.options.controlPlaneUrl,
      ...(tailscale === undefined
        ? {}
        : {
            [TAILSCALE_HOSTNAME_ENV]: tailscaleHostname(orbId),
            [PREVIEW_HOST_ENV]: previewHost(orbId, tailscale.tailnetDnsName),
          }),
    };
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
      specFingerprint: metadataValue(instance, SPEC_FINGERPRINT_METADATA_KEY),
      state,
      ...(state === "running" && internalIp !== ""
        ? { runtimeAddress: { baseUrl: `http://${internalIp}:8080` } }
        : {}),
      ...(status === "SUSPENDED" || status === "SUSPENDING"
        ? {
            failure: {
              code: "unsupported_state",
              message: `instance is ${status}`,
            },
          }
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
      const specFingerprint = this.desiredSpecFingerprint({
        orbId: request.orbId,
        repositoryUrl: request.bootstrap.repositoryUrl,
      });
      const spec = this.launchSpec({
        orbId: request.orbId,
        incarnation: request.incarnation,
        repositoryUrl: request.bootstrap.repositoryUrl,
      });

      const image = await this.request("provision", "GET", spec.imageResource, context);
      if (image.isErr()) return err(image.error);
      if (image.value.status !== 200) {
        return err(
          providerError(
            "provision",
            "operation_failed",
            `image get HTTP ${image.value.status}`,
            image.value.status >= 500,
          ),
        );
      }
      if (String(image.value.body["id"] ?? "") !== spec.imageId) {
        return err(
          providerError(
            "provision",
            "conflict",
            `image ${spec.imageResource} has id ${String(image.value.body["id"] ?? "missing")}, expected ${spec.imageId}`,
            false,
          ),
        );
      }

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
        if (metadataValue(instance, SPEC_FINGERPRINT_METADATA_KEY) !== specFingerprint) {
          return err(
            providerError(
              "provision",
              "conflict",
              `instance ${name} specification mismatch`,
              false,
            ),
          );
        }
        if (instance["status"] === "TERMINATED" || instance["status"] === "SUSPENDED") {
          const started = await this.startByName(task, name, context);
          if (started.isErr()) return err(started.error);
        }
        task.log(`gce host ${name} reused (read-back token)`);
        return ok({
          ref,
          incarnation,
          runtimeTokenHash: sha256Hex(token),
          specFingerprint,
          specGeneration: this.specGeneration,
        });
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
          sizeGb: String(spec.dataDiskSizeGb),
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
      const inserted = await this.request(
        "provision",
        "POST",
        this.zonePath("instances"),
        context,
        {
          name,
          machineType: this.zonePath(`machineTypes/${spec.machineType}`),
          labels: {
            [ORB_LABEL]: request.orbId,
            [INCARNATION_LABEL]: String(request.incarnation),
          },
          scheduling: spec.scheduling,
          disks: [
            {
              boot: true,
              autoDelete: true,
              initializeParams: {
                sourceImage: spec.bootImage,
                diskSizeGb: spec.bootDiskSizeGb,
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
              subnetwork: `projects/${this.options.projectId}/${spec.subnetwork}`,
              // Ephemeral external IP for outbound only (no NAT, docs/host-provider.md); the
              // VPC firewall denies all inbound except the control plane.
              accessConfigs: [{ type: "ONE_TO_ONE_NAT", name: "External NAT" }],
            },
          ],
          serviceAccounts: [{ email: spec.serviceAccount, scopes: spec.scopes }],
          metadata: {
            items: [
              { key: TOKEN_METADATA_KEY, value: runtimeToken },
              ...observabilityMetadataItems(),
              ...(tailscaleKey.value === null
                ? []
                : [
                    {
                      key: TAILSCALE_KEY_METADATA_KEY,
                      value: tailscaleKey.value,
                    },
                  ]),
              {
                key: CONFIG_METADATA_KEY,
                value: JSON.stringify({
                  ...spec.runtimeConfig,
                  [RUNTIME_TOKEN_ENV]: runtimeToken,
                  ...(tailscaleKey.value === null
                    ? {}
                    : { [TAILSCALE_AUTH_KEY_ENV]: tailscaleKey.value }),
                }),
              },
              { key: SPEC_FINGERPRINT_METADATA_KEY, value: specFingerprint },
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
        if (metadataValue(winner.value.body, SPEC_FINGERPRINT_METADATA_KEY) !== specFingerprint) {
          return err(
            providerError("provision", "conflict", "racing specification mismatch", false),
          );
        }
        return ok({
          ref,
          incarnation,
          runtimeTokenHash: sha256Hex(token),
          specFingerprint,
          specGeneration: this.specGeneration,
        });
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
        specFingerprint,
        specGeneration: this.specGeneration,
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
      // Compute is immutable: a stale instance is replaced, never repaired.
      // Verify the incarnation and specification stamps before booting so a
      // restart-in-place cannot resurrect an instance the caller believes it
      // already replaced (docs/compute-replacement.md).
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
      if (typeof labels[ORB_LABEL] !== "string") {
        return err(
          providerError(
            "start",
            "conflict",
            `instance ${request.ref.resourceId} is not a pi-orb host`,
            false,
          ),
        );
      }
      if (
        metadataValue(instance, SPEC_FINGERPRINT_METADATA_KEY) !== request.expectedSpecFingerprint
      ) {
        return err(providerError("start", "conflict", "instance specification mismatch", false));
      }
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
      const query = new URLSearchParams({
        filter: `labels.${ORB_LABEL}=${orbId}`,
      });
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
      instances.push({
        name: instance.name,
        incarnation: instance.incarnation,
      });
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
      const status = await this.guestAttribute(ref.resourceId, BOOT_STATUS_ATTRIBUTE, context);
      if (status.isErr()) return err(status.error);
      if (status.value === null) return ok(null);
      try {
        const parsed = JSON.parse(status.value) as Record<string, unknown>;
        if (
          parsed["schemaVersion"] !== 1 ||
          !["workspace", "bootstrap", "runtime"].includes(String(parsed["phase"] ?? "")) ||
          !["starting", "ready", "failed"].includes(String(parsed["status"] ?? ""))
        ) {
          return ok(`boot-status: invalid: ${status.value}`);
        }
        const detail = [parsed["code"], parsed["message"]]
          .filter((value): value is string => typeof value === "string" && value !== "")
          .map((value) => value.slice(0, 500))
          .join(": ");
        const fields =
          typeof parsed["details"] === "object" && parsed["details"] !== null
            ? ` ${JSON.stringify(parsed["details"]).slice(0, 1_000)}`
            : "";
        return ok(
          `boot-status: ${String(parsed["phase"])} ${String(parsed["status"])}${detail === "" ? "" : `: ${detail}`}${fields}`,
        );
      } catch {
        return ok(`boot-status: invalid: ${status.value.slice(0, 1_000)}`);
      }
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
