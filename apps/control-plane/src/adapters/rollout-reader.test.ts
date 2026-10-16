import { NoSimulationTask } from "determined";
import { describe, expect, it } from "vitest";
import { runDst } from "../testkit/sim.ts";
import { createRolloutReader } from "./rollout-reader.ts";

const task = new NoSimulationTask("rollout reader", false);
const stop = new AbortController().signal;
const auth = { getAccessToken: async () => "secret-sentinel" };
const record = {
  schemaVersion: 1,
  applyAttempted: true,
  exitCode: null,
  finishedAt: null,
  outcome: "applied-but-unvalidated",
  gates: { repair: "passed", retire: "running" },
  releaseId: "release-42",
  project: "project-a",
  phase: "retire",
  artifacts: { deploy_generation: 42 },
  retirement: { resources: ["old-revision"], revisions: ["deleted-revision"] },
  serving: [{ service: "pi-orb-issuer", revision: "new-revision", generation: 42 }],
};

describe("existing release rollout reader", () => {
  it("authenticates both allowlisted object reads without following redirects", async () => {
    const urls: string[] = [];
    const reader = createRolloutReader("bucket", "project-a", auth, async (url, init) => {
      urls.push(String(url));
      expect(init?.headers).toEqual({ authorization: "Bearer secret-sentinel" });
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      expect(init?.redirect).toBe("error");
      return Response.json(urls.length === 1 ? { releaseId: record.releaseId } : record);
    });
    expect((await reader.read(task, stop))._unsafeUnwrap()).toEqual({
      releaseId: "release-42",
      phase: "retire",
      generation: 42,
      resources: ["old-revision", "deleted-revision"],
      servingRevision: "new-revision",
    });
    expect(urls).toEqual([
      "https://storage.googleapis.com/storage/v1/b/bucket/o/static-plane%2Freleases%2Flatest.json?alt=media",
      "https://storage.googleapis.com/storage/v1/b/bucket/o/static-plane%2Freleases%2Frelease-42.json?alt=media",
    ]);
  });

  it.each([
    undefined,
    {},
    { releaseId: "../state" },
    { releaseId: "active" },
    { releaseId: "latest" },
  ])("rejects invalid pointers without a second request: %j", async (pointer) => {
    let reads = 0;
    const reader = createRolloutReader("bucket", "project-a", auth, async () => {
      reads++;
      return Response.json(pointer ?? null);
    });
    expect((await reader.read(task, stop)).isErr()).toBe(true);
    expect(reads).toBe(1);
  });

  it.each([
    null,
    {},
    { ...record, project: "foreign-project" },
    { ...record, releaseId: "another-release" },
    { ...record, artifacts: { deploy_generation: 0 } },
    { ...record, retirement: { resources: [null] } },
    { ...record, serving: [] },
    { ...record, serving: [{ ...record.serving[0], service: "foreign-service" }] },
    { ...record, serving: [{ ...record.serving[0], generation: 41 }] },
  ])("rejects malformed/mismatched records: %j", async (body) => {
    let reads = 0;
    const reader = createRolloutReader("bucket", "project-a", auth, async () =>
      Response.json(++reads === 1 ? { releaseId: record.releaseId } : body),
    );
    expect((await reader.read(task, stop)).isErr()).toBe(true);
  });

  it("treats unpublished/pre-apply records as no retirement", async () => {
    let reads = 0;
    const reader = createRolloutReader("bucket", "project-a", auth, async () =>
      Response.json(
        ++reads === 1
          ? { releaseId: record.releaseId }
          : { ...record, phase: "build", artifacts: null, serving: null },
      ),
    );
    expect((await reader.read(task, stop))._unsafeUnwrap()).toBeNull();
  });

  it("treats missing objects as absent", async () => {
    const reader = createRolloutReader(
      "bucket",
      "project-a",
      auth,
      async () => new Response(null, { status: 404 }),
    );
    expect((await reader.read(task, stop))._unsafeUnwrap()).toBeNull();
  });

  it.each([401, 403, 500])("maps HTTP %i to a typed failure", async (status) => {
    const reader = createRolloutReader(
      "bucket",
      "project-a",
      auth,
      async () => new Response(null, { status }),
    );
    expect((await reader.read(task, stop))._unsafeUnwrapErr()).toEqual({
      type: "rollout_read_unavailable",
    });
  });

  it("maps auth and network rejection without leaking secrets", async () => {
    for (const reader of [
      createRolloutReader("bucket", "project-a", {
        getAccessToken: () => Promise.reject("secret-sentinel"),
      }),
      createRolloutReader("bucket", "project-a", auth, () => Promise.reject("secret-sentinel")),
    ]) {
      const result = await reader.read(task, stop);
      expect(result._unsafeUnwrapErr()).toEqual({ type: "rollout_read_unavailable" });
      expect(JSON.stringify(result)).not.toContain("secret-sentinel");
    }
  });
  it.each([
    { ...record, exitCode: 1 },
    { ...record, finishedAt: "2026-10-16T14:00:00Z" },
    { ...record, outcome: "failed-before-apply" },
    { ...record, applyAttempted: false },
    { ...record, gates: { repair: "failed", retire: "running" } },
    { ...record, gates: { repair: "passed", retire: "failed" } },
  ])("ignores finished/failed/non-active retirement records: %j", async (body) => {
    let reads = 0;
    const reader = createRolloutReader("bucket", "project-a", auth, async () =>
      Response.json(++reads === 1 ? { releaseId: record.releaseId } : body),
    );
    expect((await reader.read(task, stop))._unsafeUnwrap()).toBeNull();
  });

  it("settles shutdown while token acquisition is held, without starting fetch", async () => {
    const shutdown = new AbortController();
    let requested = false;
    const reader = createRolloutReader(
      "bucket",
      "project-a",
      {
        getAccessToken: () => {
          shutdown.abort();
          return new Promise<string | null>(() => {});
        },
      },
      async () => {
        requested = true;
        return Response.json(null);
      },
    );
    expect((await reader.read(task, shutdown.signal)).isErr()).toBe(true);
    expect(requested).toBe(false);
  });

  it("bounds held token acquisition on the task clock", async () => {
    await runDst({ name: "rollout-auth-deadline", iterations: 10 }, async (sim) => {
      let requested = false;
      const reader = createRolloutReader(
        "bucket",
        "project-a",
        {
          getAccessToken: () => new Promise<string | null>(() => {}),
        },
        async () => {
          requested = true;
          return Response.json(null);
        },
      );
      const result = await sim.runTasks([
        {
          name: "reader",
          f: async (readTask) => {
            expect((await reader.read(readTask, new AbortController().signal)).isErr()).toBe(true);
            expect(requested).toBe(false);
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
    });
  });
});
