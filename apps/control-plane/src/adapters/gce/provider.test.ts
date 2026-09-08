import { createHash } from "node:crypto";
import { NoSimulationTask } from "determined";
import { errAsync, okAsync } from "neverthrow";
import { describe, expect, it } from "vitest";
import type { TailscaleAuthKeyMinter, TailscaleHostOptions } from "../tailscale/client.ts";
import type { GceApiTransport, GceResponse } from "./api.ts";
import {
  GceOrbHostProvider,
  type GceOrbHostProviderOptions,
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
  private readonly image: GceResponse;

  constructor(
    script: ((request: Recorded) => GceResponse)[],
    image: GceResponse = { status: 200, body: { id: "123456789" } },
  ) {
    this.script = script;
    this.image = image;
  }

  async request(args: {
    method: "GET" | "POST" | "DELETE";
    path: string;
    body?: Record<string, unknown>;
    signal: AbortSignal;
  }): Promise<GceResponse> {
    if (
      args.method === "GET" &&
      args.path === "projects/projxx/global/images/pi-orb-native-20260905"
    ) {
      return this.image;
    }
    if (args.method === "GET" && args.path === "projects/projxx/global/images/pi-orb-other") {
      return { status: 200, body: { id: "123456789" } };
    }
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
  specGeneration?: number,
): GceOrbHostProvider {
  return new GceOrbHostProvider(transport, {
    projectId: "proj",
    zone: "us-central1-a",
    machineType: "n2d-highmem-4",
    subnetwork: "regions/us-central1/subnetworks/pi-orb-us-central1",
    serviceAccount: "orb-vm@proj.iam.gserviceaccount.com",
    imageResource: "projects/projxx/global/images/pi-orb-native-20260905",
    imageId: "123456789",
    controlPlaneUrl: "https://runtime.example",
    ...(tailscale === undefined ? {} : { tailscale }),
    ...(specGeneration === undefined ? {} : { specGeneration }),
  });
}

const countingMinter = (): TailscaleAuthKeyMinter & {
  minted: () => number;
} => {
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

const ok200 = (body: Record<string, unknown>): GceResponse => ({
  status: 200,
  body,
});
const notFound: GceResponse = { status: 404, body: {} };
const done: GceResponse = { status: 200, body: { status: "DONE" } };

const provisionRequest = {
  orbId: "orb-1",
  incarnation: 0,
  bootstrap: { repositoryUrl: "https://github.com/o/r" },
};

const currentSpecFingerprint = makeProvider(new FakeTransport([])).desiredSpecFingerprint({
  orbId: provisionRequest.orbId,
  repositoryUrl: provisionRequest.bootstrap.repositoryUrl,
});

const freshMetadataItems = [
  { key: "pi-orb-runtime-token", value: "tok" },
  { key: "pi-orb-host-spec-fingerprint", value: currentSpecFingerprint },
];

const existingInstance = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  name: "pi-orb-orb-1",
  status: "RUNNING",
  labels: { "pi-orb-orb-id": "orb-1" },
  metadata: { fingerprint: "fp-1", items: freshMetadataItems },
  networkInterfaces: [{ networkIP: "10.10.0.9" }],
  ...overrides,
});

const existingDataDisk = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  name: "pi-orb-data-orb-1",
  labels: { "pi-orb-orb-id": "orb-1" },
  ...overrides,
});

describe("GceOrbHostProvider", () => {
  it("rejects an unexpected image identity before cloud mutation", async () => {
    const transport = new FakeTransport([], {
      status: 200,
      body: { id: "999" },
    });
    const result = await makeProvider(transport).provision(task, provisionRequest, context);
    expect(result.isErr() && result.error.code).toBe("conflict");
    expect(transport.requests).toHaveLength(0);
  });

  it("discards exact-orb instances through the fence and preserves newer compute/data", async () => {
    const transport = new FakeTransport([
      () =>
        ok200({
          items: [
            { name: "pi-orb-orb-1", labels: { "pi-orb-orb-id": "orb-1" } },
            {
              name: "pi-orb-orb-1-i0",
              labels: {
                "pi-orb-orb-id": "orb-1",
                "pi-orb-host-incarnation": "0",
              },
            },
            {
              name: "pi-orb-orb-1-i1",
              labels: {
                "pi-orb-orb-id": "orb-1",
                "pi-orb-host-incarnation": "1",
              },
            },
            {
              name: "pi-orb-orb-1-i2",
              labels: {
                "pi-orb-orb-id": "orb-1",
                "pi-orb-host-incarnation": "2",
              },
            },
          ],
        }),
      () => ok200({ name: "discard-legacy-op" }),
      () => done,
      () => ok200({ name: "discard-i0-op" }),
      () => done,
      () => ok200({ name: "discard-i1-op" }),
      () => done,
      () =>
        ok200({
          items: [
            {
              name: "pi-orb-orb-1-i2",
              labels: {
                "pi-orb-orb-id": "orb-1",
                "pi-orb-host-incarnation": "2",
              },
            },
          ],
        }),
    ]);
    const result = await makeProvider(transport).discardCompute(
      task,
      { orbId: "orb-1", throughIncarnation: 1 },
      context,
    );
    expect(result.isOk(), JSON.stringify(result)).toBe(true);
    const deleted = transport.requests
      .filter((request) => request.method === "DELETE")
      .map((request) => request.path);
    expect(deleted).toEqual([
      "projects/proj/zones/us-central1-a/instances/pi-orb-orb-1",
      "projects/proj/zones/us-central1-a/instances/pi-orb-orb-1-i0",
      "projects/proj/zones/us-central1-a/instances/pi-orb-orb-1-i1",
    ]);
    expect(deleted.some((path) => path.includes("i2"))).toBe(false);
    expect(transport.requests.some((request) => request.path.includes("/disks/"))).toBe(false);
  });

  it("deletes the instance before the retained data disk and waits for both", async () => {
    const transport = new FakeTransport([
      () =>
        ok200({
          items: [
            {
              name: "pi-orb-orb-1-i0",
              labels: {
                "pi-orb-orb-id": "orb-1",
                "pi-orb-host-incarnation": "0",
              },
            },
          ],
        }),
      () => ok200({ name: "delete-instance-op" }),
      () => done,
      () => ok200({ labels: { "pi-orb-orb-id": "orb-1" } }),
      () => ok200({ name: "delete-disk-op" }),
      () => done,
    ]);
    const result = await makeProvider(transport).destroy(task, "orb-1", context);
    expect(result.isOk(), JSON.stringify(result)).toBe(true);
    expect(transport.requests.map((request) => [request.method, request.path])).toEqual([
      ["GET", "projects/proj/zones/us-central1-a/instances?filter=labels.pi-orb-orb-id%3Dorb-1"],
      ["DELETE", "projects/proj/zones/us-central1-a/instances/pi-orb-orb-1-i0"],
      ["POST", "projects/proj/zones/us-central1-a/operations/delete-instance-op/wait"],
      ["GET", "projects/proj/zones/us-central1-a/disks/pi-orb-data-orb-1"],
      ["DELETE", "projects/proj/zones/us-central1-a/disks/pi-orb-data-orb-1"],
      ["POST", "projects/proj/zones/us-central1-a/operations/delete-disk-op/wait"],
    ]);
  });

  it("destroy removes an instance despite an unparseable incarnation label", async () => {
    // Ownership alone authorizes deletion-grade destroy: a mangled
    // incarnation label must not leave the orb permanently undeletable.
    const transport = new FakeTransport([
      () =>
        ok200({
          items: [
            {
              name: "pi-orb-orb-1-i0",
              labels: {
                "pi-orb-orb-id": "orb-1",
                "pi-orb-host-incarnation": "bogus",
              },
            },
          ],
        }),
      () => ok200({ name: "delete-instance-op" }),
      () => done,
      () => notFound, // data disk already gone
    ]);
    const result = await makeProvider(transport).destroy(task, "orb-1", context);
    expect(result.isOk(), JSON.stringify(result)).toBe(true);
    expect(
      transport.requests.some(
        (request) =>
          request.method === "DELETE" && request.path.endsWith("/instances/pi-orb-orb-1-i0"),
      ),
    ).toBe(true);
  });

  it("discard refuses an instance with an unparseable incarnation label", async () => {
    // The fence needs valid incarnations; guessing could delete newer compute.
    const transport = new FakeTransport([
      () =>
        ok200({
          items: [
            {
              name: "pi-orb-orb-1-i0",
              labels: {
                "pi-orb-orb-id": "orb-1",
                "pi-orb-host-incarnation": "bogus",
              },
            },
          ],
        }),
    ]);
    const result = await makeProvider(transport).discardCompute(
      task,
      { orbId: "orb-1", throughIncarnation: 5 },
      context,
    );
    expect(result.isErr() && result.error.code).toBe("conflict");
    expect(transport.requests.some((request) => request.method === "DELETE")).toBe(false);
  });

  it("refuses a filtered instance without exact orb ownership", async () => {
    const transport = new FakeTransport([
      () => ok200({ items: [{ name: "pi-orb-orb-1-i0", labels: {} }] }),
    ]);
    const result = await makeProvider(transport).destroy(task, "orb-1", context);
    expect(result.isErr() && result.error.code).toBe("conflict");
    expect(transport.requests).toHaveLength(1);
  });

  it("creates a Spot native instance with composed configuration", async () => {
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
    expect(body["name"]).toBe("pi-orb-orb-1-i0");
    expect((body["labels"] as Record<string, unknown>)["pi-orb-host-incarnation"]).toBe("0");
    expect(result.isOk() && result.value.incarnation).toBe(0);
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
    const config = JSON.parse(
      items.find((item) => item.key === "pi-orb-config")?.value ?? "{}",
    ) as Record<string, string>;
    expect(config).toMatchObject({
      PI_ORB_ID: "orb-1",
      PI_ORB_HOST_INCARNATION: "0",
      PI_ORB_REPOSITORY_URL: "https://github.com/o/r",
      PI_ORB_CONTROL_PLANE_URL: "https://runtime.example",
      PI_ORB_RUNTIME_TOKEN: token,
      PI_ORB_SKILLS_DIR: "/opt/pi-orb/skills",
    });
    expect(
      (disks[0]?.["initializeParams"] as Record<string, unknown> | undefined)?.["sourceImage"],
    ).toBe("projects/projxx/global/images/pi-orb-native-20260905");
    expect(items.find((item) => item.key === "google-logging-enabled")?.value).toBe("true");
    expect(items.find((item) => item.key === "enable-guest-attributes")?.value).toBe("TRUE");
    expect(items.find((item) => item.key === "block-project-ssh-keys")?.value).toBe("TRUE");
    const spec = items.find((item) => item.key === "pi-orb-host-spec-fingerprint")?.value;
    expect(spec).toBe(result.isOk() ? result.value.specFingerprint : "");
    expect(items.some((item) => item.key === "pi-orb-script-sha256")).toBe(false);
    // Transitional rollover fence: the legacy generation stamp carries the
    // configured deploy generation so a draining pre-replacement revision
    // reads new instances as "the future" and never repairs them backward
    // (docs/compute-replacement.md). It is a stamp only — nothing in the
    // current adapter reads it back.
  });

  it("refuses to attach a retained data disk owned by another orb", async () => {
    const transport = new FakeTransport([
      () => notFound,
      () => ok200(existingDataDisk({ labels: { "pi-orb-orb-id": "other" } })),
    ]);
    const result = await makeProvider(transport).provision(task, provisionRequest, context);
    expect(result.isErr() && result.error.code).toBe("conflict");
    expect(result.isErr() && result.error.retryable).toBe(false);
    expect(transport.requests.some((request) => request.method === "POST")).toBe(false);
  });

  it("reports a failed retained data disk GET as retryable unavailability", async () => {
    const transport = new FakeTransport([() => notFound, () => ({ status: 503, body: {} })]);
    const result = await makeProvider(transport).provision(task, provisionRequest, context);
    expect(result.isErr() && result.error.code).toBe("unavailable");
    expect(result.isErr() && result.error.retryable).toBe(true);
    expect(transport.requests.some((request) => request.method === "POST")).toBe(false);
  });

  it("reports a forbidden retained data disk GET as non-retryable", async () => {
    const transport = new FakeTransport([() => notFound, () => ({ status: 403, body: {} })]);
    const result = await makeProvider(transport).provision(task, provisionRequest, context);
    expect(result.isErr() && result.error.code).toBe("operation_failed");
    expect(result.isErr() && result.error.retryable).toBe(false);
    expect(transport.requests.some((request) => request.method === "POST")).toBe(false);
  });

  it("re-reads and rejects a foreign disk after losing the create race", async () => {
    const transport = new FakeTransport([
      () => notFound,
      () => notFound,
      () => ({ status: 409, body: {} }),
      () => ok200(existingDataDisk({ labels: { "pi-orb-orb-id": "other" } })),
    ]);
    const result = await makeProvider(transport).provision(task, provisionRequest, context);
    expect(result.isErr() && result.error.code).toBe("conflict");
    expect(result.isErr() && result.error.retryable).toBe(false);
    expect(transport.requests.filter((request) => request.method === "GET")).toHaveLength(3);
    expect(
      transport.requests.some(
        (request) => request.method === "POST" && request.path.endsWith("/instances"),
      ),
    ).toBe(false);
  });

  it("re-reads and attaches an owned disk after losing the create race", async () => {
    const transport = new FakeTransport([
      () => notFound,
      () => notFound,
      () => ({ status: 409, body: {} }),
      () => ok200(existingDataDisk()),
      () => ok200({ name: "op-inst" }),
      () => done,
    ]);
    const result = await makeProvider(transport).provision(task, provisionRequest, context);
    expect(result.isOk(), JSON.stringify(result)).toBe(true);
    expect(
      transport.requests.some(
        (request) => request.method === "POST" && request.path.endsWith("/instances"),
      ),
    ).toBe(true);
  });

  it("reattaches an owned retained disk without requiring current size or type defaults", async () => {
    const transport = new FakeTransport([
      () => notFound,
      () =>
        ok200(
          existingDataDisk({
            sizeGb: "10",
            type: "projects/proj/zones/us-central1-a/diskTypes/pd-standard",
          }),
        ),
      () => ok200({ name: "op-inst" }),
      () => done,
    ]);
    const result = await makeProvider(transport).provision(task, provisionRequest, context);
    expect(result.isOk(), JSON.stringify(result)).toBe(true);
    expect(transport.requests.some((request) => request.method === "POST")).toBe(true);
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
    expect(transport.requests[1]?.path).toContain("/instances/pi-orb-orb-1-i0/start");
  });

  it("never repairs a stale immutable specification in place", async () => {
    const transport = new FakeTransport([
      () =>
        ok200(
          existingInstance({
            metadata: {
              fingerprint: "fp-1",
              items: [{ key: "pi-orb-runtime-token", value: "tok" }],
            },
          }),
        ),
    ]);
    const result = await makeProvider(transport).provision(task, provisionRequest, context);
    expect(result.isErr() && result.error.code).toBe("conflict");
    // Non-retryable by decision: only replacement clears it, so a retry loop
    // would burn the reconciler against an instance that can never match.
    expect(result.isErr() && result.error.retryable).toBe(false);
    expect(transport.requests.some((request) => request.path.endsWith("/setMetadata"))).toBe(false);
    expect(transport.requests.some((request) => request.path.endsWith("/stop"))).toBe(false);
  });

  it("fingerprint and generation change only with effective specification", () => {
    const first = makeProvider(new FakeTransport([]), undefined, 7);
    const same = makeProvider(new FakeTransport([]), undefined, 8);
    const fingerprint = first.desiredSpecFingerprint({
      orbId: provisionRequest.orbId,
      repositoryUrl: provisionRequest.bootstrap.repositoryUrl,
    });
    expect(
      same.desiredSpecFingerprint({
        orbId: provisionRequest.orbId,
        repositoryUrl: provisionRequest.bootstrap.repositoryUrl,
      }),
    ).toBe(fingerprint);
    expect(first.specGeneration).toBe(7);
    expect(same.specGeneration).toBe(8);
  });

  it("start refuses a resource carrying a different incarnation", async () => {
    const transport = new FakeTransport([
      () =>
        ok200(
          existingInstance({
            name: "pi-orb-orb-1-i1",
            labels: {
              "pi-orb-orb-id": "orb-1",
              "pi-orb-host-incarnation": "1",
            },
          }),
        ),
    ]);
    const result = await makeProvider(transport).start(
      task,
      {
        ref: { provider: "gce", resourceId: "pi-orb-orb-1-i1" },
        expectedIncarnation: 0,
        expectedSpecFingerprint: currentSpecFingerprint,
      },
      context,
    );
    expect(result.isErr() && result.error.code).toBe("conflict");
    expect(transport.requests).toHaveLength(1);
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
      {
        ref: { provider: "gce", resourceId: "pi-orb-orb-1" },
        expectedIncarnation: 0,
        expectedSpecFingerprint: currentSpecFingerprint,
      },
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
          error: {
            errors: [{ code: "ZONE_RESOURCE_POOL_EXHAUSTED", message: "no capacity" }],
          },
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

  it("maps an asynchronous resource-in-use insert error to retryable", async () => {
    const transport = new FakeTransport([
      () => notFound,
      () => ok200(existingInstance()),
      () => ok200({ name: "op-inst" }),
      () =>
        ok200({
          status: "DONE",
          error: {
            errors: [
              {
                code: "RESOURCE_IN_USE_BY_ANOTHER_RESOURCE",
                message: "resource is still attached",
              },
            ],
          },
        }),
    ]);
    const result = await makeProvider(transport).provision(task, provisionRequest, context);
    expect(result.isErr() && result.error.retryable).toBe(true);
    expect(result.isErr() && result.error.message).toContain("RESOURCE_IN_USE_BY_ANOTHER_RESOURCE");
  });

  it("retries an inline resource-in-use insert error", async () => {
    const transport = new FakeTransport([
      () => notFound,
      () => ok200(existingInstance()),
      () => ({
        status: 400,
        body: { error: { errors: [{ code: "RESOURCE_IN_USE_BY_ANOTHER_RESOURCE" }] } },
      }),
    ]);
    const result = await makeProvider(transport).provision(task, provisionRequest, context);
    expect(result.isErr() && result.error.retryable).toBe(true);
  });

  it("adopts the winner's token after losing a create race", async () => {
    const transport = new FakeTransport([
      () => notFound,
      () => ok200(existingInstance()), // disk exists
      () => ({ status: 409, body: {} }), // insert loses the race
      () =>
        ok200(
          existingInstance({
            metadata: {
              items: [
                { key: "pi-orb-runtime-token", value: "winner" },
                {
                  key: "pi-orb-host-spec-fingerprint",
                  value: currentSpecFingerprint,
                },
              ],
            },
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

  it.each([
    ["2026-09-07T12:34:56.789Z", Date.parse("2026-09-07T12:34:56.789Z")],
    [undefined, undefined],
    ["malformed", undefined],
    ["1969-12-31T23:59:59Z", undefined],
  ])("reports a valid instance start timestamp from %s", async (lastStartTimestamp, expected) => {
    const provider = makeProvider(
      new FakeTransport([() => ok200(existingInstance({ lastStartTimestamp }))]),
    );
    const observed = await provider.observe(
      task,
      { provider: "gce", resourceId: "pi-orb-orb-1" },
      context,
    );
    expect(observed.isOk() && observed.value?.lastStartedAt).toBe(expected);
  });

  it("paginates listManagedHosts", async () => {
    const transport = new FakeTransport([
      () => ok200({ items: [existingInstance()], nextPageToken: "p2" }),
      () =>
        ok200({
          items: [
            existingInstance({
              name: "pi-orb-orb-2",
              labels: { "pi-orb-orb-id": "orb-2" },
            }),
          ],
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

  it("reads typed native boot diagnostics from guest attributes", async () => {
    const transport = new FakeTransport([
      () =>
        ok200({
          queryValue: {
            items: [
              {
                key: "boot-status",
                value: JSON.stringify({
                  schemaVersion: 1,
                  phase: "runtime",
                  status: "failed",
                  code: "runtime_start_failed",
                  message: "systemd unit exited",
                  details: { result: "oom-kill", execMainStatus: "9", workspaceFreeBytes: 42 },
                  timestamp: "2026-09-05T20:00:00Z",
                }),
              },
            ],
          },
        }),
      () => notFound,
    ]);
    const provider = makeProvider(transport);
    const ref = { provider: "gce", resourceId: "pi-orb-orb-1" };
    const found = await provider.diagnose(task, ref, context);
    expect(found.isOk() && found.value).toBe(
      'boot-status: runtime failed: runtime_start_failed: systemd unit exited {"result":"oom-kill","execMainStatus":"9","workspaceFreeBytes":42}',
    );
    expect(transport.requests[0]?.path).toContain("queryPath=pi-orb%2Fboot-status");
    const absent = await provider.diagnose(task, ref, context);
    expect(absent.isOk() && absent.value).toBeNull();
  });

  it("reports native boot progress", async () => {
    const transport = new FakeTransport([
      () =>
        ok200({
          queryValue: {
            items: [
              {
                key: "boot-status",
                value: JSON.stringify({
                  schemaVersion: 1,
                  phase: "bootstrap",
                  status: "starting",
                  timestamp: "2026-09-05T20:00:00Z",
                }),
              },
            ],
          },
        }),
    ]);
    const provider = makeProvider(transport);
    const found = await provider.diagnose(
      task,
      { provider: "gce", resourceId: "pi-orb-orb-1" },
      context,
    );
    expect(found.isOk() && found.value).toBe("boot-status: bootstrap starting");
  });

  it("preserves malformed native diagnostic evidence", async () => {
    const transport = new FakeTransport([
      () =>
        ok200({
          queryValue: { items: [{ key: "boot-status", value: "not-json" }] },
        }),
    ]);
    const provider = makeProvider(transport);
    const found = await provider.diagnose(
      task,
      { provider: "gce", resourceId: "pi-orb-orb-1" },
      context,
    );
    expect(found.isOk() && found.value).toBe("boot-status: invalid: not-json");
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
    const config = JSON.parse(
      items.find((item) => item.key === "pi-orb-config")?.value ?? "{}",
    ) as Record<string, string>;
    expect(config).toMatchObject({
      PI_ORB_TAILSCALE_AUTH_KEY: "tskey-auth-1",
      PI_ORB_TAILSCALE_HOSTNAME: "pi-orb-orb-1",
      PI_ORB_PREVIEW_HOST: "pi-orb-orb-1.tailnet.ts.net",
    });
    expect(items.find((item) => item.key === "pi-orb-host-spec-fingerprint")?.value).toBe(
      result.isOk() ? result.value.specFingerprint : "",
    );
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

  it("reads metadata attributes defensively", () => {
    expect(metadataValue({}, "k")).toBeNull();
    expect(metadataValue({ metadata: { items: [{ key: "k", value: "v" }] } }, "k")).toBe("v");
    expect(metadataValue({ metadata: { items: [{ key: "k", value: 3 }] } }, "k")).toBeNull();
  });
});

describe("GceOrbHostProvider host specification", () => {
  const specInput = {
    orbId: provisionRequest.orbId,
    repositoryUrl: provisionRequest.bootstrap.repositoryUrl,
  };

  /** A provider whose configuration differs from the shared one by `overrides`. */
  function reconfigured(overrides: Partial<GceOrbHostProviderOptions>): GceOrbHostProvider {
    return new GceOrbHostProvider(new FakeTransport([]), {
      projectId: "proj",
      zone: "us-central1-a",
      machineType: "n2d-highmem-4",
      subnetwork: "regions/us-central1/subnetworks/pi-orb-us-central1",
      serviceAccount: "orb-vm@proj.iam.gserviceaccount.com",
      imageResource: "projects/projxx/global/images/pi-orb-native-20260905",
      imageId: "123456789",
      controlPlaneUrl: "https://runtime.example",
      ...overrides,
    });
  }
  const fingerprintWith = (overrides: Partial<GceOrbHostProviderOptions>): string =>
    reconfigured(overrides).desiredSpecFingerprint(specInput);

  /** An instance whose metadata carries only the given items. */
  const instanceWithItems = (
    items: { key: string; value: string }[],
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> =>
    existingInstance({
      metadata: { fingerprint: "fp-1", items },
      ...overrides,
    });

  const legacyItems = [{ key: "pi-orb-runtime-token", value: "tok" }];

  it("changes with every launch fact that requires new compute", () => {
    expect(fingerprintWith({})).toBe(currentSpecFingerprint);
    expect(
      fingerprintWith({
        imageResource: "projects/projxx/global/images/pi-orb-other",
      }),
    ).not.toBe(currentSpecFingerprint);
    expect(fingerprintWith({ imageId: "987654321" })).not.toBe(currentSpecFingerprint);
    expect(fingerprintWith({ machineType: "n2d-highmem-8" })).not.toBe(currentSpecFingerprint);
    expect(fingerprintWith({ subnetwork: "regions/us-central1/subnetworks/other" })).not.toBe(
      currentSpecFingerprint,
    );
    expect(fingerprintWith({ serviceAccount: "other@proj.iam.gserviceaccount.com" })).not.toBe(
      currentSpecFingerprint,
    );
    expect(fingerprintWith({ dataDiskSizeGb: 512 })).not.toBe(currentSpecFingerprint);
    expect(fingerprintWith({ extraEnv: { OPENAI_BASE_URL: "http://a" } })).not.toBe(
      currentSpecFingerprint,
    );
    expect(fingerprintWith({ extraEnv: { OPENAI_BASE_URL: "http://a" } })).not.toBe(
      fingerprintWith({ extraEnv: { OPENAI_BASE_URL: "http://b" } }),
    );
    expect(fingerprintWith({ controlPlaneUrl: "https://other.example" })).not.toBe(
      currentSpecFingerprint,
    );
    expect(
      reconfigured({}).desiredSpecFingerprint({
        ...specInput,
        repositoryUrl: "https://github.com/o/other",
      }),
    ).not.toBe(currentSpecFingerprint);
  });

  it("deliberately ignores zone, project, and the spec generation", () => {
    // The data disk is zonal, so replacement cannot move an orb: a "replacement"
    // in another zone would come up on a fresh, empty workspace. A zone or
    // project move is an explicit operator migration, outside this mechanism
    // (docs/compute-replacement.md).
    expect(fingerprintWith({ zone: "europe-west4-a" })).toBe(currentSpecFingerprint);
    expect(fingerprintWith({ projectId: "other-proj" })).toBe(currentSpecFingerprint);
    // The generation is a rollover fence, not part of the specification.
    expect(fingerprintWith({ specGeneration: 9 })).toBe(currentSpecFingerprint);
  });

  it("describes the specification, not the incarnation that carries it", async () => {
    const transport = new FakeTransport([
      () => notFound, // instance get
      () => ok200(existingInstance()), // disk exists
      () => ok200({ name: "op-inst" }),
      () => done,
    ]);
    const provider = makeProvider(transport);
    const result = await provider.provision(task, { ...provisionRequest, incarnation: 3 }, context);
    expect(result.isOk(), JSON.stringify(result)).toBe(true);
    const insert = transport.requests.find(
      (request) => request.method === "POST" && request.path.endsWith("/instances"),
    );
    const body = insert?.body ?? {};
    expect(body["name"]).toBe("pi-orb-orb-1-i3");
    const items = (body["metadata"] as { items: { key: string; value: string }[] }).items;
    expect(items.find((item) => item.key === "pi-orb-host-spec-fingerprint")?.value).toBe(
      currentSpecFingerprint,
    );
    expect(result.isOk() && result.value.specFingerprint).toBe(currentSpecFingerprint);
  });

  it("reports the stamped fingerprint in observations", async () => {
    const transport = new FakeTransport([
      () => ok200(existingInstance()),
      () => ok200(instanceWithItems(legacyItems)),
    ]);
    const provider = makeProvider(transport);
    const ref = { provider: "gce", resourceId: "pi-orb-orb-1" };
    const stamped = await provider.observe(task, ref, context);
    expect(stamped.isOk() && stamped.value?.specFingerprint).toBe(currentSpecFingerprint);
    const legacy = await provider.observe(task, ref, context);
    expect(legacy.isOk() && legacy.value !== null).toBe(true);
    expect(legacy.isOk() && legacy.value?.specFingerprint).toBeNull();
  });

  it("start refuses an instance whose stamp differs from the expectation", async () => {
    const transport = new FakeTransport([() => ok200(existingInstance({ status: "TERMINATED" }))]);
    const result = await makeProvider(transport).start(
      task,
      {
        ref: { provider: "gce", resourceId: "pi-orb-orb-1" },
        expectedIncarnation: 0,
        expectedSpecFingerprint: fingerprintWith({
          imageResource: "projects/projxx/global/images/pi-orb-other",
        }),
      },
      context,
    );
    expect(result.isErr() && result.error.code).toBe("conflict");
    expect(result.isErr() && result.error.retryable).toBe(false);
    expect(transport.requests.some((request) => request.path.endsWith("/start"))).toBe(false);
    expect(transport.requests.some((request) => request.path.endsWith("/setMetadata"))).toBe(false);
  });

  it("start accepts a legacy unstamped instance only when no stamp is expected", async () => {
    const legacyTransport = new FakeTransport([
      () => ok200(instanceWithItems(legacyItems, { status: "TERMINATED" })),
      () => ok200({ name: "op-start" }),
      () => done,
    ]);
    const legacyStart = await makeProvider(legacyTransport).start(
      task,
      {
        ref: { provider: "gce", resourceId: "pi-orb-orb-1" },
        expectedIncarnation: 0,
        expectedSpecFingerprint: null,
      },
      context,
    );
    expect(legacyStart.isOk(), JSON.stringify(legacyStart)).toBe(true);
    expect(legacyTransport.requests.some((request) => request.path.endsWith("/start"))).toBe(true);

    const stampedTransport = new FakeTransport([
      () => ok200(existingInstance({ status: "TERMINATED" })),
    ]);
    const stampedStart = await makeProvider(stampedTransport).start(
      task,
      {
        ref: { provider: "gce", resourceId: "pi-orb-orb-1" },
        expectedIncarnation: 0,
        expectedSpecFingerprint: null,
      },
      context,
    );
    expect(stampedStart.isErr() && stampedStart.error.code).toBe("conflict");
    expect(stampedStart.isErr() && stampedStart.error.retryable).toBe(false);
    expect(stampedTransport.requests.some((request) => request.path.endsWith("/start"))).toBe(
      false,
    );
  });

  it("provision never boots a stopped instance carrying a stale specification", async () => {
    // The dangerous case: reuse would `instances.start` the stale VM, booting
    // exactly the compute the caller decided to replace.
    const transport = new FakeTransport([
      () => ok200(instanceWithItems(legacyItems, { status: "TERMINATED" })),
    ]);
    const result = await makeProvider(transport).provision(task, provisionRequest, context);
    expect(result.isErr() && result.error.code).toBe("conflict");
    expect(result.isErr() && result.error.retryable).toBe(false);
    expect(transport.requests.some((request) => request.path.endsWith("/start"))).toBe(false);
    expect(transport.requests.some((request) => request.path.endsWith("/setMetadata"))).toBe(false);
  });
});
