import { createHash } from "node:crypto";
import { NoSimulationTask } from "determined";
import { describe, expect, it } from "vitest";
import type { GceApiTransport, GceResponse } from "./api.ts";
import { buildStartupScript, GceOrbHostProvider, mapInstanceStatus, metadataValue } from "./provider.ts";

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
    method: "GET" | "POST";
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

function makeProvider(transport: GceApiTransport): GceOrbHostProvider {
  return new GceOrbHostProvider(transport, {
    projectId: "proj",
    zone: "us-central1-a",
    machineType: "n2d-highmem-4",
    subnetwork: "regions/us-central1/subnetworks/pi-orb-us-central1",
    serviceAccount: "orb-vm@proj.iam.gserviceaccount.com",
    runtimeImage: "us-central1-docker.pkg.dev/proj/pi-orb/runtime@sha256:abc",
    controlPlaneUrl: "https://runtime.example",
  });
}

const ok200 = (body: Record<string, unknown>): GceResponse => ({ status: 200, body });
const notFound: GceResponse = { status: 404, body: {} };
const done: GceResponse = { status: 200, body: { status: "DONE" } };

const existingInstance = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  name: "pi-orb-orb-1",
  status: "RUNNING",
  labels: { "pi-orb-orb-id": "orb-1" },
  metadata: { items: [{ key: "pi-orb-runtime-token", value: "tok" }] },
  networkInterfaces: [{ networkIP: "10.10.0.9" }],
  ...overrides,
});

const provisionRequest = {
  orbId: "orb-1",
  bootstrap: { repositoryUrl: "https://github.com/o/r" },
};

describe("GceOrbHostProvider", () => {
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
    // The token reaches the container from metadata, never inline.
    expect(script).not.toContain(token);
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
      expect(script).toMatch(/\\\n  'img'\n/);
    }
  });

  it("reads metadata attributes defensively", () => {
    expect(metadataValue({}, "k")).toBeNull();
    expect(metadataValue({ metadata: { items: [{ key: "k", value: "v" }] } }, "k")).toBe("v");
    expect(metadataValue({ metadata: { items: [{ key: "k", value: 3 }] } }, "k")).toBeNull();
  });
});
