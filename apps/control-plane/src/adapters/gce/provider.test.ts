import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { NoSimulationTask } from "determined";
import { errAsync, okAsync } from "neverthrow";
import { describe, expect, it } from "vitest";
import type { TailscaleAuthKeyMinter, TailscaleHostOptions } from "../tailscale/client.ts";
import type { GceApiTransport, GceResponse } from "./api.ts";
import {
  buildStartupScript,
  GceOrbHostProvider,
  mapInstanceStatus,
  metadataValue,
} from "./provider.ts";

const task = new NoSimulationTask("gce test", false);
const context = { signal: new AbortController().signal };
const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

interface Recorded {
  method: string;
  path: string;
  body?: Record<string, unknown>;
}

/** Scripted transport: matches each request in order against a handler. */
class FakeTransport implements GceApiTransport {
  readonly requests: Recorded[] = [];
  private readonly script: ((request: Recorded) => GceResponse)[];

  constructor(script: ((request: Recorded) => GceResponse)[]) {
    this.script = script;
  }

  async request(args: {
    method: "GET" | "POST" | "DELETE";
    path: string;
    body?: Record<string, unknown>;
    signal: AbortSignal;
  }): Promise<GceResponse> {
    const recorded: Recorded = {
      method: args.method,
      path: args.path,
      ...(args.body === undefined ? {} : { body: args.body }),
    };
    this.requests.push(recorded);
    const step = this.script.shift();
    if (step === undefined) throw new Error(`unscripted request: ${args.method} ${args.path}`);
    return step(recorded);
  }
}

function makeProvider(
  transport: GceApiTransport,
  tailscale?: TailscaleHostOptions,
  scriptGeneration?: number,
): GceOrbHostProvider {
  return new GceOrbHostProvider(transport, {
    projectId: "proj",
    zone: "us-central1-a",
    machineType: "n2d-highmem-4",
    subnetwork: "regions/us-central1/subnetworks/pi-orb-us-central1",
    serviceAccount: "orb-vm@proj.iam.gserviceaccount.com",
    runtimeImage: "us-central1-docker.pkg.dev/proj/pi-orb/runtime@sha256:abc",
    controlPlaneUrl: "https://runtime.example",
    ...(tailscale === undefined ? {} : { tailscale }),
    ...(scriptGeneration === undefined ? {} : { scriptGeneration }),
  });
}

const countingMinter = (): TailscaleAuthKeyMinter & { minted: () => number } => {
  let count = 0;
  return {
    mintAuthKey: () => {
      count += 1;
      return okAsync(`tskey-auth-${count}`);
    },
    minted: () => count,
  };
};

const tailscaleOptions = (minter: TailscaleAuthKeyMinter): TailscaleHostOptions => ({
  minter,
  tailnetDnsName: "tailnet.ts.net",
});

/** `bash -n` on a script body; null when it parses. */
function bashSyntaxError(script: string): string | null {
  const result = spawnSync("bash", ["-n"], { input: script, encoding: "utf8" });
  if (result.error !== undefined) return String(result.error);
  return result.status === 0 ? null : result.stderr || `bash -n exited ${String(result.status)}`;
}

const ok200 = (body: Record<string, unknown>): GceResponse => ({ status: 200, body });
const notFound: GceResponse = { status: 404, body: {} };
const done: GceResponse = { status: 200, body: { status: "DONE" } };

const provisionRequest = {
  orbId: "orb-1",
  bootstrap: { repositoryUrl: "https://github.com/o/r" },
};

/** The script hash a `makeProvider` provider expects for orb-1 (fresh stamp). */
const currentScriptHash = sha256(
  buildStartupScript({
    runtimeImage: "us-central1-docker.pkg.dev/proj/pi-orb/runtime@sha256:abc",
    orbId: provisionRequest.orbId,
    repositoryUrl: provisionRequest.bootstrap.repositoryUrl,
    controlPlaneUrl: "https://runtime.example",
    extraEnv: {},
  }),
);

const freshMetadataItems = [
  { key: "pi-orb-runtime-token", value: "tok" },
  { key: "pi-orb-script-sha256", value: currentScriptHash },
  { key: "pi-orb-repository-url", value: provisionRequest.bootstrap.repositoryUrl },
];

const existingInstance = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  name: "pi-orb-orb-1",
  status: "RUNNING",
  labels: { "pi-orb-orb-id": "orb-1" },
  metadata: { fingerprint: "fp-1", items: freshMetadataItems },
  networkInterfaces: [{ networkIP: "10.10.0.9" }],
  ...overrides,
});

describe("GceOrbHostProvider", () => {
  it("deletes the instance before the retained data disk and waits for both", async () => {
    const transport = new FakeTransport([
      () => ok200({ labels: { "pi-orb-orb-id": "orb-1" } }),
      () => ok200({ name: "delete-instance-op" }),
      () => done,
      () => ok200({ labels: { "pi-orb-orb-id": "orb-1" } }),
      () => ok200({ name: "delete-disk-op" }),
      () => done,
    ]);
    const result = await makeProvider(transport).destroy(task, "orb-1", context);
    expect(result.isOk(), JSON.stringify(result)).toBe(true);
    expect(transport.requests.map((request) => [request.method, request.path])).toEqual([
      ["GET", "projects/proj/zones/us-central1-a/instances/pi-orb-orb-1"],
      ["DELETE", "projects/proj/zones/us-central1-a/instances/pi-orb-orb-1"],
      ["POST", "projects/proj/zones/us-central1-a/operations/delete-instance-op/wait"],
      ["GET", "projects/proj/zones/us-central1-a/disks/pi-orb-data-orb-1"],
      ["DELETE", "projects/proj/zones/us-central1-a/disks/pi-orb-data-orb-1"],
      ["POST", "projects/proj/zones/us-central1-a/operations/delete-disk-op/wait"],
    ]);
  });

  it("refuses to delete a deterministic-name instance without the orb label", async () => {
    const transport = new FakeTransport([() => ok200({ labels: {} })]);
    const result = await makeProvider(transport).destroy(task, "orb-1", context);
    expect(result.isErr() && result.error.code).toBe("conflict");
    expect(transport.requests).toHaveLength(1);
  });

  it("creates a Spot COS instance and reports the minted token hash", async () => {
    const transport = new FakeTransport([
      () => notFound, // instance get
      () => notFound, // disk get
      () => ok200({ name: "op-disk" }), // disk insert
      () => done, // op wait
      () => ok200({ name: "op-inst" }), // instance insert
      () => done, // op wait
    ]);
    const provider = makeProvider(transport);
    const result = await provider.provision(task, provisionRequest, context);
    expect(result.isOk(), JSON.stringify(result)).toBe(true);
    const insert = transport.requests.find(
      (request) => request.method === "POST" && request.path.endsWith("/instances"),
    );
    expect(insert).toBeDefined();
    const body = insert?.body ?? {};
    expect((body["scheduling"] as Record<string, unknown>)["provisioningModel"]).toBe("SPOT");
    expect((body["scheduling"] as Record<string, unknown>)["instanceTerminationAction"]).toBe(
      "STOP",
    );
    const disks = body["disks"] as Record<string, unknown>[];
    expect(disks[1]?.["autoDelete"]).toBe(false);
    const items = (body["metadata"] as { items: { key: string; value: string }[] }).items;
    const token = items.find((item) => item.key === "pi-orb-runtime-token")?.value ?? "";
    expect(token).not.toBe("");
    if (result.isOk()) expect(result.value.runtimeTokenHash).toBe(sha256(token));
    const script = items.find((item) => item.key === "startup-script")?.value ?? "";
    expect(script).toContain("mkfs.ext4");
    expect(script).toContain("docker run");
    expect(script).toContain("PI_ORB_CONTROL_PLANE_URL='https://runtime.example'");
    expect(script).toContain("-e HOME=/workspace/home");
    expect(script).toContain('-v "$MNT":/workspace');
    // The token reaches the container from metadata, never inline.
    expect(script).not.toContain(token);
    // Evidence that outlives the VM: COS ships container stdout/stderr to
    // Cloud Logging, and guest attributes are off unless asked for.
    expect(items.find((item) => item.key === "google-logging-enabled")?.value).toBe("true");
    expect(items.find((item) => item.key === "enable-guest-attributes")?.value).toBe("TRUE");
    // Script-version stamp and the re-derivation input (open question 32),
    // plus the repair fence — 0 when the deploy did not set a generation.
    expect(items.find((item) => item.key === "pi-orb-script-sha256")?.value).toBe(sha256(script));
    expect(items.find((item) => item.key === "pi-orb-script-generation")?.value).toBe("0");
    expect(items.find((item) => item.key === "pi-orb-repository-url")?.value).toBe(
      "https://github.com/o/r",
    );
  });

  it("reuses an existing instance and reads its token back", async () => {
    const transport = new FakeTransport([() => ok200(existingInstance())]);
    const provider = makeProvider(transport);
    const result = await provider.provision(task, provisionRequest, context);
    expect(result.isOk()).toBe(true);
    if (result.isOk()) expect(result.value.runtimeTokenHash).toBe(sha256("tok"));
    expect(transport.requests.length).toBe(1);
  });

  it("starts a TERMINATED instance during provision (restart-in-place)", async () => {
    const transport = new FakeTransport([
      () => ok200(existingInstance({ status: "TERMINATED" })),
      () => ok200({ name: "op-start" }),
      () => done,
    ]);
    const provider = makeProvider(transport);
    const result = await provider.provision(task, provisionRequest, context);
    expect(result.isOk()).toBe(true);
    expect(transport.requests[1]?.path).toContain("/instances/pi-orb-orb-1/start");
  });

  it("repairs a stale startup script on a reused running instance", async () => {
    const staleItems = [
      { key: "pi-orb-runtime-token", value: "tok" },
      { key: "pi-orb-script-sha256", value: "stale-hash" },
      { key: "pi-orb-repository-url", value: "https://github.com/o/r" },
      { key: "ssh-keys", value: "someone:ssh-rsa AAAA" },
      // A host from before the observability keys existed, or with one turned off.
      { key: "google-logging-enabled", value: "false" },
    ];
    const transport = new FakeTransport([
      () => ok200(existingInstance({ metadata: { fingerprint: "fp-1", items: staleItems } })),
      () => ok200({ name: "op-stop" }), // stop for repair
      () => done,
      () =>
        ok200(
          existingInstance({
            status: "TERMINATED",
            metadata: { fingerprint: "fp-2", items: staleItems },
          }),
        ), // re-get for a fresh fingerprint
      () => ok200({ name: "op-meta" }), // setMetadata
      () => done,
      () => ok200({ name: "op-start" }), // start
      () => done,
    ]);
    const provider = makeProvider(transport);
    const result = await provider.provision(task, provisionRequest, context);
    expect(result.isOk(), JSON.stringify(result)).toBe(true);
    // The token is preserved by the repair, so the committed hash stays valid.
    if (result.isOk()) expect(result.value.runtimeTokenHash).toBe(sha256("tok"));
    const setMetadata = transport.requests.find((request) => request.path.endsWith("/setMetadata"));
    expect(setMetadata).toBeDefined();
    const body = setMetadata?.body ?? {};
    expect(body["fingerprint"]).toBe("fp-2");
    const items = body["items"] as { key: string; value: string }[];
    expect(items.find((item) => item.key === "pi-orb-runtime-token")?.value).toBe("tok");
    expect(items.find((item) => item.key === "pi-orb-script-sha256")?.value).toBe(
      currentScriptHash,
    );
    expect(items.find((item) => item.key === "startup-script")?.value).toContain("docker run");
    // Keys the provider does not manage survive untouched...
    expect(items.find((item) => item.key === "ssh-keys")?.value).toBe("someone:ssh-rsa AAAA");
    // ...while the observability keys are rewritten, exactly once, so a host
    // predating them adopts them on the repair that is its only upgrade path.
    expect(items.filter((item) => item.key === "google-logging-enabled")).toEqual([
      { key: "google-logging-enabled", value: "true" },
    ]);
    expect(items.filter((item) => item.key === "enable-guest-attributes")).toEqual([
      { key: "enable-guest-attributes", value: "TRUE" },
    ]);
  });

  it("stamps its own script generation on insert", async () => {
    const transport = new FakeTransport([
      () => notFound, // instance get
      () => ok200(existingInstance()), // disk exists
      () => ok200({ name: "op-inst" }),
      () => done,
    ]);
    const provider = makeProvider(transport, undefined, 7);
    const result = await provider.provision(task, provisionRequest, context);
    expect(result.isOk(), JSON.stringify(result)).toBe(true);
    const insert = transport.requests.find(
      (request) => request.method === "POST" && request.path.endsWith("/instances"),
    );
    const metadata = insert?.body?.["metadata"] as
      | { items: { key: string; value: string }[] }
      | undefined;
    const items = metadata?.items ?? [];
    expect(items.find((item) => item.key === "pi-orb-script-generation")?.value).toBe("7");
  });

  it("repairs an unstamped host forward and takes ownership of the fence", async () => {
    // The host predates generations entirely: it reads as 0, the lowest there
    // is, so the repair is forward and the stamp becomes this revision's.
    const transport = new FakeTransport([
      () =>
        ok200(
          existingInstance({
            status: "TERMINATED",
            metadata: {
              fingerprint: "fp-1",
              items: [
                { key: "pi-orb-runtime-token", value: "tok" },
                { key: "pi-orb-script-sha256", value: "stale-hash" },
                { key: "pi-orb-repository-url", value: provisionRequest.bootstrap.repositoryUrl },
              ],
            },
          }),
        ),
      () => ok200({ name: "op-meta" }),
      () => done,
      () => ok200({ name: "op-start" }),
      () => done,
    ]);
    const provider = makeProvider(transport, undefined, 3);
    const result = await provider.provision(task, provisionRequest, context);
    expect(result.isOk(), JSON.stringify(result)).toBe(true);
    const setMetadata = transport.requests.find((request) => request.path.endsWith("/setMetadata"));
    const items = (setMetadata?.body?.["items"] ?? []) as { key: string; value: string }[];
    expect(items.filter((item) => item.key === "pi-orb-script-generation")).toEqual([
      { key: "pi-orb-script-generation", value: "3" },
    ]);
    expect(items.find((item) => item.key === "pi-orb-script-sha256")?.value).toBe(
      currentScriptHash,
    );
  });

  it("repairs a host stamped with its own generation (hash still decides)", async () => {
    // Same generation, different script: a feature toggle or a config change
    // within one revision — and every local development host, which runs at
    // generation 0 forever.
    const transport = new FakeTransport([
      () =>
        ok200(
          existingInstance({
            status: "TERMINATED",
            metadata: {
              fingerprint: "fp-1",
              items: [
                { key: "pi-orb-runtime-token", value: "tok" },
                { key: "pi-orb-script-sha256", value: "stale-hash" },
                { key: "pi-orb-script-generation", value: "4" },
                { key: "pi-orb-repository-url", value: provisionRequest.bootstrap.repositoryUrl },
              ],
            },
          }),
        ),
      () => ok200({ name: "op-meta" }),
      () => done,
      () => ok200({ name: "op-start" }),
      () => done,
    ]);
    const provider = makeProvider(transport, undefined, 4);
    const result = await provider.provision(task, provisionRequest, context);
    expect(result.isOk(), JSON.stringify(result)).toBe(true);
    const setMetadata = transport.requests.find((request) => request.path.endsWith("/setMetadata"));
    expect(setMetadata).toBeDefined();
    const items = (setMetadata?.body?.["items"] ?? []) as { key: string; value: string }[];
    expect(items.find((item) => item.key === "pi-orb-script-generation")?.value).toBe("4");
  });

  it("never repairs a host stamped by a newer generation", async () => {
    // The rollover fence: an older revision meeting the new revision's host
    // leaves script, metadata and power state alone — no stop, no setMetadata,
    // no start (docs/postmortems/2026-08-06-rollover-repair-war-corrupt-image.md).
    const transport = new FakeTransport([
      () =>
        ok200(
          existingInstance({
            metadata: {
              fingerprint: "fp-1",
              items: [
                { key: "pi-orb-runtime-token", value: "tok" },
                { key: "pi-orb-script-sha256", value: "hash-of-a-newer-script" },
                { key: "pi-orb-script-generation", value: "9" },
                { key: "pi-orb-repository-url", value: provisionRequest.bootstrap.repositoryUrl },
              ],
            },
          }),
        ),
    ]);
    const provider = makeProvider(transport, undefined, 2);
    const result = await provider.provision(task, provisionRequest, context);
    expect(result.isOk(), JSON.stringify(result)).toBe(true);
    if (result.isOk()) expect(result.value.runtimeTokenHash).toBe(sha256("tok"));
    expect(transport.requests.length).toBe(1);
  });

  it("still boots a host stamped newer, without rewriting its script", async () => {
    // Fencing withholds the repair, not the start: the orb must come up on the
    // newer revision's script rather than stay down.
    const transport = new FakeTransport([
      () =>
        ok200(
          existingInstance({
            status: "TERMINATED",
            metadata: {
              fingerprint: "fp-1",
              items: [
                { key: "pi-orb-runtime-token", value: "tok" },
                { key: "pi-orb-script-sha256", value: "hash-of-a-newer-script" },
                { key: "pi-orb-script-generation", value: "9" },
                { key: "pi-orb-repository-url", value: provisionRequest.bootstrap.repositoryUrl },
              ],
            },
          }),
        ),
      () => ok200({ name: "op-start" }),
      () => done,
    ]);
    const provider = makeProvider(transport, undefined, 2);
    const result = await provider.start(
      task,
      { provider: "gce", resourceId: "pi-orb-orb-1" },
      context,
    );
    expect(result.isOk(), JSON.stringify(result)).toBe(true);
    expect(transport.requests.some((request) => request.path.endsWith("/setMetadata"))).toBe(false);
    expect(transport.requests[1]?.path).toContain("/instances/pi-orb-orb-1/start");
  });

  it("start() repairs a pre-stamp TERMINATED instance, recovering the repo URL", async () => {
    const legacyScript = "#!/bin/bash\n  -e PI_ORB_REPOSITORY_URL='https://github.com/o/r' \\\n";
    const transport = new FakeTransport([
      () =>
        ok200(
          existingInstance({
            status: "TERMINATED",
            metadata: {
              fingerprint: "fp-1",
              items: [
                { key: "pi-orb-runtime-token", value: "tok" },
                { key: "startup-script", value: legacyScript },
              ],
            },
          }),
        ),
      () => ok200({ name: "op-meta" }), // setMetadata (no stop needed)
      () => done,
      () => ok200({ name: "op-start" }),
      () => done,
    ]);
    const provider = makeProvider(transport);
    const result = await provider.start(
      task,
      { provider: "gce", resourceId: "pi-orb-orb-1" },
      context,
    );
    expect(result.isOk(), JSON.stringify(result)).toBe(true);
    const setMetadata = transport.requests.find((request) => request.path.endsWith("/setMetadata"));
    const items = (setMetadata?.body?.["items"] ?? []) as { key: string; value: string }[];
    expect(items.find((item) => item.key === "pi-orb-repository-url")?.value).toBe(
      "https://github.com/o/r",
    );
    expect(items.find((item) => item.key === "pi-orb-script-sha256")?.value).toBe(
      currentScriptHash,
    );
  });

  it("start() with a current stamp starts without touching metadata", async () => {
    const transport = new FakeTransport([
      () => ok200(existingInstance({ status: "TERMINATED" })),
      () => ok200({ name: "op-start" }),
      () => done,
    ]);
    const provider = makeProvider(transport);
    const result = await provider.start(
      task,
      { provider: "gce", resourceId: "pi-orb-orb-1" },
      context,
    );
    expect(result.isOk()).toBe(true);
    expect(transport.requests.some((request) => request.path.endsWith("/setMetadata"))).toBe(false);
  });

  it("maps capacity exhaustion to a non-retryable failure", async () => {
    const transport = new FakeTransport([
      () => notFound,
      () => ok200(existingInstance()), // disk exists
      () => ok200({ name: "op-inst" }),
      () => ({
        status: 200,
        body: {
          status: "DONE",
          error: { errors: [{ code: "ZONE_RESOURCE_POOL_EXHAUSTED", message: "no capacity" }] },
        },
      }),
    ]);
    const provider = makeProvider(transport);
    const result = await provider.provision(task, provisionRequest, context);
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.retryable).toBe(false);
      expect(result.error.message).toContain("ZONE_RESOURCE_POOL_EXHAUSTED");
    }
  });

  it("adopts the winner's token after losing a create race", async () => {
    const transport = new FakeTransport([
      () => notFound,
      () => ok200(existingInstance()), // disk exists
      () => ({ status: 409, body: {} }), // insert loses the race
      () =>
        ok200(
          existingInstance({
            metadata: { items: [{ key: "pi-orb-runtime-token", value: "winner" }] },
          }),
        ),
    ]);
    const provider = makeProvider(transport);
    const result = await provider.provision(task, provisionRequest, context);
    expect(result.isOk()).toBe(true);
    if (result.isOk()) expect(result.value.runtimeTokenHash).toBe(sha256("winner"));
  });

  it("rejects an instance whose orb label does not match", async () => {
    const transport = new FakeTransport([
      () => ok200(existingInstance({ labels: { "pi-orb-orb-id": "other" } })),
    ]);
    const provider = makeProvider(transport);
    const result = await provider.provision(task, provisionRequest, context);
    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.retryable).toBe(false);
  });

  it("loops the operation wait until DONE", async () => {
    const transport = new FakeTransport([
      () => ok200(existingInstance({ status: "TERMINATED" })),
      () => ok200({ name: "op-start" }),
      () => ok200({ status: "RUNNING" }),
      () => done,
    ]);
    const provider = makeProvider(transport);
    const result = await provider.provision(task, provisionRequest, context);
    expect(result.isOk()).toBe(true);
    expect(transport.requests.filter((request) => request.path.includes("/wait")).length).toBe(2);
  }, 15_000);

  it("observes states, addresses, and absence", async () => {
    const transport = new FakeTransport([
      () => ok200(existingInstance()),
      () => notFound,
      () => ok200(existingInstance({ status: "SUSPENDED" })),
    ]);
    const provider = makeProvider(transport);
    const ref = { provider: "gce", resourceId: "pi-orb-orb-1" };
    const running = await provider.observe(task, ref, context);
    expect(running.isOk() && running.value?.state).toBe("running");
    expect(running.isOk() && running.value?.runtimeAddress?.baseUrl).toBe("http://10.10.0.9:8080");
    const absent = await provider.observe(task, ref, context);
    expect(absent.isOk() && absent.value).toBeNull();
    const suspended = await provider.observe(task, ref, context);
    expect(suspended.isOk() && suspended.value?.state).toBe("stopped");
    expect(suspended.isOk() && suspended.value?.failure?.code).toBe("unsupported_state");
  });

  it("paginates listManagedHosts", async () => {
    const transport = new FakeTransport([
      () => ok200({ items: [existingInstance()], nextPageToken: "p2" }),
      () =>
        ok200({
          items: [existingInstance({ name: "pi-orb-orb-2", labels: { "pi-orb-orb-id": "orb-2" } })],
        }),
    ]);
    const provider = makeProvider(transport);
    const listed = await provider.listManagedHosts(task, context);
    expect(listed.isOk() && listed.value.length).toBe(2);
    expect(transport.requests[1]?.path).toContain("pageToken=p2");
  });

  it("maps every instance status", () => {
    expect(mapInstanceStatus("RUNNING")).toBe("running");
    expect(mapInstanceStatus("PROVISIONING")).toBe("starting");
    expect(mapInstanceStatus("STAGING")).toBe("starting");
    expect(mapInstanceStatus("REPAIRING")).toBe("starting");
    expect(mapInstanceStatus("STOPPING")).toBe("stopping");
    expect(mapInstanceStatus("SUSPENDING")).toBe("stopping");
    expect(mapInstanceStatus("TERMINATED")).toBe("stopped");
    expect(mapInstanceStatus("SUSPENDED")).toBe("stopped");
    expect(mapInstanceStatus("WEIRD")).toBe("failed");
  });

  it("emits a well-formed docker run with and without extra env", () => {
    const base = {
      runtimeImage: "img",
      orbId: "o",
      repositoryUrl: "https://x",
      controlPlaneUrl: "https://cp",
    };
    for (const extraEnv of [{}, { A: "1", B: "2" }]) {
      const script = buildStartupScript({ ...base, extraEnv });
      // No blank line may interrupt a backslash continuation.
      expect(script).not.toMatch(/\\\n\s*\n/);
      // The image is the final argument of the same docker run command.
      expect(script).toMatch(/\\\n {2}'img'\n/);
    }
  });

  it("reads startup diagnostics from guest attributes", async () => {
    const transport = new FakeTransport([
      () =>
        ok200({
          queryValue: { items: [{ key: "startup", value: "failed: line 12: docker run" }] },
        }),
      () => notFound, // no container attribute: the script never got that far
      () => notFound, // second diagnose: nothing written at all
      () => notFound,
    ]);
    const provider = makeProvider(transport);
    const ref = { provider: "gce", resourceId: "pi-orb-orb-1" };
    const found = await provider.diagnose(task, ref, context);
    expect(found.isOk() && found.value).toBe("startup-script: failed: line 12: docker run");
    expect(transport.requests[0]?.path).toContain("queryPath=pi-orb%2Fstartup");
    expect(transport.requests[1]?.path).toContain("queryPath=pi-orb%2Fcontainer");
    const absent = await provider.diagnose(task, ref, context);
    expect(absent.isOk() && absent.value).toBeNull();
  });

  it("folds container state into the diagnosis", async () => {
    const containerState =
      "status=restarting restartCount=47 lastExitCode=1 at=2026-08-06T06:20:00Z";
    const transport = new FakeTransport([
      () => ok200({ queryValue: { items: [{ key: "startup", value: "container-started" }] } }),
      () => ok200({ queryValue: { items: [{ key: "container", value: containerState }] } }),
    ]);
    const provider = makeProvider(transport);
    const found = await provider.diagnose(
      task,
      { provider: "gce", resourceId: "pi-orb-orb-1" },
      context,
    );
    expect(found.isOk() && found.value).toBe(
      `startup-script: container-started; container: ${containerState}`,
    );
  });

  it("keeps the startup evidence when the container query fails", async () => {
    // Supplementary evidence must never turn a known diagnosis into an Err —
    // an Err defers the caller's boot-failure decision another poll.
    const transport = new FakeTransport([
      () => ok200({ queryValue: { items: [{ key: "startup", value: "container-started" }] } }),
      () => ({ status: 500, body: {} }),
    ]);
    const provider = makeProvider(transport);
    const found = await provider.diagnose(
      task,
      { provider: "gce", resourceId: "pi-orb-orb-1" },
      context,
    );
    expect(found.isOk() && found.value).toBe("startup-script: container-started");
  });

  it("reports container state alone when no startup marker survives", async () => {
    const transport = new FakeTransport([
      () => notFound,
      () =>
        ok200({
          queryValue: {
            items: [{ key: "container", value: "status=absent restartCount=0 lastExitCode=0" }],
          },
        }),
    ]);
    const provider = makeProvider(transport);
    const found = await provider.diagnose(
      task,
      { provider: "gce", resourceId: "pi-orb-orb-1" },
      context,
    );
    expect(found.isOk() && found.value).toBe(
      "container: status=absent restartCount=0 lastExitCode=0",
    );
  });

  it("the startup script reports progress and failures", () => {
    const script = buildStartupScript({
      runtimeImage: "img",
      orbId: "o",
      repositoryUrl: "https://x",
      controlPlaneUrl: "https://cp",
      extraEnv: {},
    });
    expect(script).toContain("trap 'report \"failed: line $LINENO");
    expect(script).toContain("report disk-mounted");
    expect(script).toContain("iptables -w -A INPUT -p tcp --dport 8080 -j ACCEPT");
    expect(script).toContain("report container-started");
    expect(script).toContain("guest-attributes/pi-orb/startup");
  });

  it("keeps reporting container state after the script exits", () => {
    const script = buildStartupScript({
      runtimeImage: "img",
      orbId: "o",
      repositoryUrl: "https://x",
      controlPlaneUrl: "https://cp",
      extraEnv: {},
    });
    // A transient systemd unit, not a background child: the startup-script
    // unit's exit reaps its own cgroup.
    expect(script).toContain("systemd-run --unit=pi-orb-container-reporter --collect");
    // Re-running the script replaces the reporter instead of stacking one, and
    // cannot fail the boot under `set -euo pipefail`.
    expect(script).toContain("systemctl stop pi-orb-container-reporter.service");
    expect(script).toContain("systemctl reset-failed pi-orb-container-reporter.service");
    expect(script).toContain("|| report container-reporter-failed");
    // Dependency-free: docker inspect plus the same metadata-server curl.
    expect(script).toContain("docker inspect");
    expect(script).toContain("status={{.State.Status}}");
    expect(script).toContain("restartCount={{.RestartCount}}");
    expect(script).toContain("lastExitCode={{.State.ExitCode}}");
    expect(script).toContain("guest-attributes/pi-orb/container");
    expect(script).toContain("sleep 15");
  });

  it("emits a syntactically valid script, reporter included", () => {
    for (const tailscale of [
      undefined,
      { hostname: "pi-orb-o", previewHost: "pi-orb-o.tailnet.ts.net" },
    ]) {
      const script = buildStartupScript({
        runtimeImage: "img",
        orbId: "o",
        repositoryUrl: "https://x",
        controlPlaneUrl: "https://cp",
        extraEnv: { A: "1" },
        ...(tailscale === undefined ? {} : { tailscale }),
      });
      expect(bashSyntaxError(script)).toBeNull();
      // The reporter body sits in a quoted heredoc, so checking the outer
      // script says nothing about it; check it on its own.
      const reporter = /<<'REPORTER_EOF'\n([\s\S]*?)\nREPORTER_EOF\n/.exec(script)?.[1];
      expect(reporter).toBeDefined();
      expect(bashSyntaxError(reporter ?? "")).toBeNull();
    }
  });

  it("keeps the auth key out of the script and in metadata on insert", async () => {
    const minter = countingMinter();
    const transport = new FakeTransport([
      () => notFound, // instance get
      () => ok200(existingInstance()), // disk exists
      () => ok200({ name: "op-inst" }), // instance insert
      () => done,
    ]);
    const provider = makeProvider(transport, tailscaleOptions(minter));
    const result = await provider.provision(task, provisionRequest, context);
    expect(result.isOk(), JSON.stringify(result)).toBe(true);
    expect(minter.minted()).toBe(1);
    const insert = transport.requests.find(
      (request) => request.method === "POST" && request.path.endsWith("/instances"),
    );
    const metadata = insert?.body?.["metadata"] as
      | { items: { key: string; value: string }[] }
      | undefined;
    const items = metadata?.items ?? [];
    expect(items.find((item) => item.key === "pi-orb-tailscale-auth-key")?.value).toBe(
      "tskey-auth-1",
    );
    const script = items.find((item) => item.key === "startup-script")?.value ?? "";
    // The secret is fetched at boot, exactly like the runtime token; only the
    // pure functions of orbId + static config are literals.
    expect(script).not.toContain("tskey-auth-1");
    expect(script).toContain("instance/attributes/pi-orb-tailscale-auth-key");
    expect(script).toContain('-e PI_ORB_TAILSCALE_AUTH_KEY="$TS_AUTHKEY"');
    expect(script).toContain("-e PI_ORB_TAILSCALE_HOSTNAME='pi-orb-orb-1'");
    expect(script).toContain("-e PI_ORB_PREVIEW_HOST='pi-orb-orb-1.tailnet.ts.net'");
    // The stamp still describes the script that was written.
    expect(items.find((item) => item.key === "pi-orb-script-sha256")?.value).toBe(sha256(script));
  });

  it("fails provisioning retryably and inserts nothing when minting fails", async () => {
    const transport = new FakeTransport([
      () => notFound, // instance get
      () => ok200(existingInstance()), // disk exists
    ]);
    const provider = makeProvider(transport, {
      minter: {
        mintAuthKey: () =>
          errAsync({
            type: "tailscale_error" as const,
            code: "rejected" as const,
            message: "tailnet said no",
            retryable: false,
          }),
      },
      tailnetDnsName: "tailnet.ts.net",
    });
    const result = await provider.provision(task, provisionRequest, context);
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.retryable).toBe(true);
      expect(result.error.message).toContain("tailnet said no");
    }
    expect(
      transport.requests.some(
        (request) => request.method === "POST" && request.path.endsWith("/instances"),
      ),
    ).toBe(false);
  });

  it("preserves an existing auth key through a script repair", async () => {
    const minter = countingMinter();
    const staleItems = [
      { key: "pi-orb-runtime-token", value: "tok" },
      { key: "pi-orb-tailscale-auth-key", value: "tskey-auth-existing" },
      { key: "pi-orb-script-sha256", value: "stale-hash" },
      { key: "pi-orb-repository-url", value: provisionRequest.bootstrap.repositoryUrl },
    ];
    const transport = new FakeTransport([
      () =>
        ok200(
          existingInstance({
            status: "TERMINATED",
            metadata: { fingerprint: "fp-1", items: staleItems },
          }),
        ),
      () => ok200({ name: "op-meta" }), // setMetadata (no stop needed)
      () => done,
      () => ok200({ name: "op-start" }),
      () => done,
    ]);
    const provider = makeProvider(transport, tailscaleOptions(minter));
    const result = await provider.provision(task, provisionRequest, context);
    expect(result.isOk(), JSON.stringify(result)).toBe(true);
    // An existing host is never re-keyed: it keeps the identity it joined with.
    expect(minter.minted()).toBe(0);
    const setMetadata = transport.requests.find((request) => request.path.endsWith("/setMetadata"));
    const items = (setMetadata?.body?.["items"] ?? []) as { key: string; value: string }[];
    expect(items.find((item) => item.key === "pi-orb-tailscale-auth-key")?.value).toBe(
      "tskey-auth-existing",
    );
    expect(items.find((item) => item.key === "pi-orb-runtime-token")?.value).toBe("tok");
  });

  it("mints the key a pre-tailscale host is missing while repairing it", async () => {
    const minter = countingMinter();
    const transport = new FakeTransport([
      () => ok200(existingInstance({ status: "TERMINATED" })), // no tailscale key
      () => ok200({ name: "op-meta" }),
      () => done,
      () => ok200({ name: "op-start" }),
      () => done,
    ]);
    const provider = makeProvider(transport, tailscaleOptions(minter));
    const result = await provider.start(
      task,
      { provider: "gce", resourceId: "pi-orb-orb-1" },
      context,
    );
    expect(result.isOk(), JSON.stringify(result)).toBe(true);
    expect(minter.minted()).toBe(1);
    const setMetadata = transport.requests.find((request) => request.path.endsWith("/setMetadata"));
    const items = (setMetadata?.body?.["items"] ?? []) as { key: string; value: string }[];
    // Key and script land together: the new script curls that attribute under
    // `set -e`, so a repair without it would brick the host at boot.
    expect(items.find((item) => item.key === "pi-orb-tailscale-auth-key")?.value).toBe(
      "tskey-auth-1",
    );
    const script = items.find((item) => item.key === "startup-script")?.value ?? "";
    expect(script).toContain("instance/attributes/pi-orb-tailscale-auth-key");
  });

  it("start() re-derives the identical tailscale script (no repeat repair)", async () => {
    const minter = countingMinter();
    const tailscaleScriptHash = sha256(
      buildStartupScript({
        runtimeImage: "us-central1-docker.pkg.dev/proj/pi-orb/runtime@sha256:abc",
        orbId: provisionRequest.orbId,
        repositoryUrl: provisionRequest.bootstrap.repositoryUrl,
        controlPlaneUrl: "https://runtime.example",
        extraEnv: {},
        tailscale: {
          hostname: "pi-orb-orb-1",
          previewHost: "pi-orb-orb-1.tailnet.ts.net",
        },
      }),
    );
    const transport = new FakeTransport([
      () =>
        ok200(
          existingInstance({
            status: "TERMINATED",
            metadata: {
              fingerprint: "fp-1",
              items: [
                { key: "pi-orb-runtime-token", value: "tok" },
                { key: "pi-orb-tailscale-auth-key", value: "tskey-auth-existing" },
                { key: "pi-orb-script-sha256", value: tailscaleScriptHash },
                { key: "pi-orb-repository-url", value: provisionRequest.bootstrap.repositoryUrl },
              ],
            },
          }),
        ),
      () => ok200({ name: "op-start" }),
      () => done,
    ]);
    const provider = makeProvider(transport, tailscaleOptions(minter));
    const result = await provider.start(
      task,
      { provider: "gce", resourceId: "pi-orb-orb-1" },
      context,
    );
    expect(result.isOk(), JSON.stringify(result)).toBe(true);
    expect(transport.requests.some((request) => request.path.endsWith("/setMetadata"))).toBe(false);
    expect(minter.minted()).toBe(0);
  });

  it("emits no tailscale plumbing when the feature is off", () => {
    const script = buildStartupScript({
      runtimeImage: "img",
      orbId: "o",
      repositoryUrl: "https://x",
      controlPlaneUrl: "https://cp",
      extraEnv: {},
    });
    expect(script).not.toContain("TS_AUTHKEY");
    expect(script).not.toContain("PI_ORB_PREVIEW_HOST");
    expect(script).not.toMatch(/\\\n\s*\n/);
    expect(script).toMatch(/\\\n {2}'img'\n/);
  });

  it("keeps the tailscale docker run well-formed with extra env", () => {
    const script = buildStartupScript({
      runtimeImage: "img",
      orbId: "o",
      repositoryUrl: "https://x",
      controlPlaneUrl: "https://cp",
      extraEnv: { A: "1" },
      tailscale: { hostname: "pi-orb-o", previewHost: "pi-orb-o.tailnet.ts.net" },
    });
    expect(script).not.toMatch(/\\\n\s*\n/);
    expect(script).toMatch(/\\\n {2}'img'\n/);
  });

  it("reads metadata attributes defensively", () => {
    expect(metadataValue({}, "k")).toBeNull();
    expect(metadataValue({ metadata: { items: [{ key: "k", value: "v" }] } }, "k")).toBe("v");
    expect(metadataValue({ metadata: { items: [{ key: "k", value: 3 }] } }, "k")).toBeNull();
  });
});
