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
  specGeneration?: number,
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
    ...(specGeneration === undefined ? {} : { specGeneration }),
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

/** Execute only the generated image-replacement block against shell fakes. */
function runImageReplacement(script: string, failedPulls: number) {
  const start = script.indexOf("RUNTIME_IMAGE=");
  const end = script.indexOf('report "container-started');
  if (start < 0 || end < start) throw new Error("image-replacement block not found");
  const block = script.slice(start, end);
  return spawnSync("bash", [], {
    encoding: "utf8",
    input: `set -euo pipefail
exec 3>&1
pull_count=0
docker() {
  printf 'docker' >&3
  printf ' %s' "$@" >&3
  printf '\\n' >&3
  if [[ "$1" == pull ]]; then
    pull_count=$((pull_count + 1))
    if (( pull_count <= ${failedPulls} )); then return 1; fi
  fi
  return 0
}
sleep() { printf 'sleep %s\\n' "$1" >&3; }
report() { printf 'report %s\\n' "$1" >&3; }
MNT=/workspace
TOKEN=token
${block}`,
  });
}

const ok200 = (body: Record<string, unknown>): GceResponse => ({ status: 200, body });
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

describe("GceOrbHostProvider", () => {
  it("discards exact-orb instances through the fence and preserves newer compute/data", async () => {
    const transport = new FakeTransport([
      () =>
        ok200({
          items: [
            { name: "pi-orb-orb-1", labels: { "pi-orb-orb-id": "orb-1" } },
            {
              name: "pi-orb-orb-1-i0",
              labels: { "pi-orb-orb-id": "orb-1", "pi-orb-host-incarnation": "0" },
            },
            {
              name: "pi-orb-orb-1-i1",
              labels: { "pi-orb-orb-id": "orb-1", "pi-orb-host-incarnation": "1" },
            },
            {
              name: "pi-orb-orb-1-i2",
              labels: { "pi-orb-orb-id": "orb-1", "pi-orb-host-incarnation": "2" },
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
              labels: { "pi-orb-orb-id": "orb-1", "pi-orb-host-incarnation": "2" },
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
              labels: { "pi-orb-orb-id": "orb-1", "pi-orb-host-incarnation": "0" },
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
              labels: { "pi-orb-orb-id": "orb-1", "pi-orb-host-incarnation": "bogus" },
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
              labels: { "pi-orb-orb-id": "orb-1", "pi-orb-host-incarnation": "bogus" },
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
    const spec = items.find((item) => item.key === "pi-orb-host-spec-fingerprint")?.value;
    expect(spec).toBe(result.isOk() ? result.value.specFingerprint : "");
    expect(items.some((item) => item.key === "pi-orb-script-sha256")).toBe(false);
    // Transitional rollover fence: the legacy generation stamp carries the
    // configured deploy generation so a draining pre-replacement revision
    // reads new instances as "the future" and never repairs them backward
    // (docs/compute-replacement.md). It is a stamp only — nothing in the
    // current adapter reads it back.
    expect(items.find((item) => item.key === "pi-orb-script-generation")?.value).toBe("0");
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
            metadata: {
              items: [
                { key: "pi-orb-runtime-token", value: "winner" },
                { key: "pi-orb-host-spec-fingerprint", value: currentSpecFingerprint },
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
      const script = buildStartupScript({ ...base, incarnation: 7, extraEnv });
      expect(script).toContain("-e PI_ORB_HOST_INCARNATION='7'");
      // No blank line may interrupt a backslash continuation.
      expect(script).not.toMatch(/\\\n\s*\n/);
      // The exact image variable is the final argument of the same docker run command.
      expect(script).toMatch(/\\\n {2}"\$RUNTIME_IMAGE"\n/);
    }
  });

  it("retries the exact image pull before replacing the stopped container", () => {
    const image = "registry.example/runtime@sha256:abc";
    const script = buildStartupScript({
      runtimeImage: image,
      orbId: "o",
      repositoryUrl: "https://x",
      controlPlaneUrl: "https://cp",
      extraEnv: {},
    });
    const result = runImageReplacement(script, 2);
    expect(result.status, result.stderr).toBe(0);
    const lines = result.stdout.trim().split("\n");
    const pulls = lines.filter((line) => line === `docker pull ${image}`);
    expect(pulls).toHaveLength(3);
    expect(lines).toContain("sleep 5");
    expect(lines).toContain("sleep 10");
    const stopAt = lines.indexOf("docker stop pi-orb-runtime");
    const removeAt = lines.indexOf("docker rm -f pi-orb-runtime");
    const runAt = lines.findIndex((line) => line.startsWith("docker run "));
    expect(stopAt).toBeGreaterThanOrEqual(0);
    expect(removeAt).toBeGreaterThan(lines.lastIndexOf(`docker pull ${image}`));
    expect(runAt).toBeGreaterThan(removeAt);
    expect(lines[runAt]).toContain("--pull=never");
    expect(lines[runAt]?.endsWith(` ${image}`)).toBe(true);
    expect(script).toContain('report "container-started imagePullAttempts=$attempt"');
  });

  it("retains the stopped container when image-pull retries are exhausted", () => {
    const image = "registry.example/runtime@sha256:abc";
    const script = buildStartupScript({
      runtimeImage: image,
      orbId: "o",
      repositoryUrl: "https://x",
      controlPlaneUrl: "https://cp",
      extraEnv: {},
    });
    const result = runImageReplacement(script, 3);
    expect(result.status).toBe(1);
    const lines = result.stdout.trim().split("\n");
    expect(lines.filter((line) => line === `docker pull ${image}`)).toHaveLength(3);
    expect(lines).toContain("report image-pull-failed attempts=3");
    expect(lines).not.toContain("docker rm -f pi-orb-runtime");
    expect(lines.some((line) => line.startsWith("docker run "))).toBe(false);
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
    expect(script).toContain('report "container-started imagePullAttempts=$attempt"');
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
    expect(script).toMatch(/\\\n {2}"\$RUNTIME_IMAGE"\n/);
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
    expect(script).toMatch(/\\\n {2}"\$RUNTIME_IMAGE"\n/);
  });

  it("reads metadata attributes defensively", () => {
    expect(metadataValue({}, "k")).toBeNull();
    expect(metadataValue({ metadata: { items: [{ key: "k", value: "v" }] } }, "k")).toBe("v");
    expect(metadataValue({ metadata: { items: [{ key: "k", value: 3 }] } }, "k")).toBeNull();
  });
});
