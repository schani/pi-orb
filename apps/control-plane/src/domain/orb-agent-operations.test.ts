import { NoSimulationTask } from "determined";
import { errAsync, okAsync } from "neverthrow";
import { describe, expect, it, vi } from "vitest";
import { makeHarness, makeOrbRow, makeProjectRow } from "../testkit/fixtures.ts";
import { runDst } from "../testkit/sim.ts";
import {
  createCentralOrbAgentOperations,
  createOrbAgentOperations,
} from "./orb-agent-operations.ts";

const identity = {
  ownerUserId: "owner",
  projectId: "project",
  orbId: "caller",
  incarnation: 1,
  runtimeTokenHash: "token",
};
function seed() {
  const h = makeHarness();
  h.store.seedProject({ ...makeProjectRow("project"), ownerUserId: "owner" });
  h.store.seedOrb(
    makeOrbRow("caller", "project", "running", { runtimeTokenHash: "token", hostIncarnation: 1 }),
  );
  return h;
}
function searchSetup(caller: Parameters<typeof createOrbAgentOperations>[2] = identity) {
  const h = seed();
  const task = new NoSimulationTask("search", false);
  const log = vi.spyOn(task, "log");
  const hit = {
    orbId: "caller",
    sessionId: "s",
    recordId: "r",
    name: null,
    projectName: "Project",
    snippet: "private snippet",
    score: 0.3,
  };
  const search = vi.spyOn(h.store, "searchHistory").mockReturnValue(okAsync({ hits: [hit] }));
  const service = createOrbAgentOperations(task, h.deps, caller, {
    appOrigin: "https://app",
    appendAlert: () => okAsync({ recordId: "a", duplicate: false }),
  });
  return {
    ...h,
    task,
    log,
    hit,
    search,
    service,
    invoke: (request: unknown) => service.invoke({ kind: "search", request }, "search"),
  };
}
describe("orb history search", () => {
  it.each([
    [undefined, { orbId: "caller" }],
    ["project", { projectId: "project" }],
    ["user", {}],
  ] as const)("binds %s scope without fetching or waking the runtime", async (scope, selector) => {
    const { ownerUserId: _owner, ...guest } = identity;
    const s = searchSetup(guest);
    s.store.seedProject({ ...makeProjectRow("project"), ownerUserId: "fresh-owner" });
    const getOrb = vi.spyOn(s.store, "getOrb");
    const getProject = vi.spyOn(s.store, "getProject");
    const pull = vi.spyOn(s.deps.runtimeClient, "pullHistory");
    const start = vi.spyOn(s.deps.hostProvider, "start");
    const provision = vi.spyOn(s.deps.hostProvider, "provision");
    expect((await s.invoke({ query: " Needle!? ", scope }))._unsafeUnwrap()).toEqual({
      hits: [{ ...s.hit, orbUrl: "https://app/orbs/caller" }],
    });
    expect(s.search).toHaveBeenCalledWith(s.task, {
      ownerUserId: "fresh-owner",
      ...selector,
      query: "Needle!?",
      limit: 10,
    });
    for (const read of [getOrb, getProject]) expect(read).toHaveBeenCalledTimes(1);
    for (const effect of [pull, start, provision]) expect(effect).not.toHaveBeenCalled();
    expect(s.log.mock.calls.flat().join(" ")).toMatch(/scope=.*hits=1.*durationMs=/);
    expect(s.log.mock.calls.flat().join(" ")).not.toMatch(/history_records_search_idx/);
    expect(s.log.mock.calls.flat().join(" ")).not.toMatch(/needle|private/i);
    if (scope === undefined) {
      const list = vi.spyOn(s.store, "listProjectsByOwner");
      expect((await s.service.invoke({ kind: "list" }, "list")).isOk()).toBe(true);
      expect(list).toHaveBeenCalledWith(s.task, "fresh-owner");
    }
  });
  it.each([
    null,
    "needle",
    { query: "x", kind: "self" },
    { query: "x", ownerUserId: "another" },
    { query: "  \n " },
    { query: "x".repeat(4097) },
    ...[0, 51, 1.5].map((limit) => ({ query: "x", limit })),
    { query: "x", scope: "project", orbId: "caller" },
    { query: "x", orbId: " " },
  ])("rejects raw/semantic invalid input %j", async (request) => {
    const s = searchSetup();
    expect((await s.invoke(request))._unsafeUnwrapErr().code).toBe("invalid_request");
    expect(s.search).not.toHaveBeenCalled();
  });
  it.each([
    ["foreign", "archived", "not_found"],
    ["project", undefined, "not_found"],
    ["project", "deleting", "conflict"],
    ["project", "archived", undefined],
  ] as const)("checks explicit target %s/%s", async (projectId, state, code) => {
    const s = searchSetup();
    s.store.seedProject({ ...makeProjectRow("foreign"), ownerUserId: "another" });
    if (state) s.store.seedOrb(makeOrbRow("target", projectId, state));
    const result = await s.invoke({ query: "needle", orbId: "target", limit: 50 });
    expect(result.isErr() ? result.error.code : undefined).toBe(code);
    expect(s.search).toHaveBeenCalledTimes(code ? 0 : 1);
    if (!code)
      expect(s.search).toHaveBeenCalledWith(s.task, {
        ownerUserId: "owner",
        orbId: "target",
        query: "needle",
        limit: 50,
      });
  });
  it("sanitizes database failure and telemetry", async () => {
    const s = searchSetup();
    s.search.mockReturnValue(
      errAsync({
        type: "store_error",
        code: "unavailable",
        retryable: true,
        message: "private database details",
      }),
    );
    expect((await s.invoke({ query: "needle" }))._unsafeUnwrapErr()).toEqual({
      code: "unavailable",
      message: "history search unavailable",
    });
    const log = s.log.mock.calls.flat().join(" ");
    expect(log).toContain("error=unavailable");
    expect(log).not.toMatch(/private|needle/);
  });
  it.each(["project", "user"])(
    "fences source deletion after authentication for %s",
    async (scope) => {
      const s = searchSetup();
      s.store.seedOrb(
        makeOrbRow("caller", "project", "deleting", {
          runtimeTokenHash: "token",
          hostIncarnation: 1,
        }),
      );
      expect((await s.invoke({ query: "needle", scope }))._unsafeUnwrapErr().code).toBe("conflict");
      expect(s.search).not.toHaveBeenCalled();
    },
  );
});

describe("central orb operations", () => {
  it("returns path-routed self and spawned orb links", async () => {
    const h = seed();
    const service = createOrbAgentOperations(
      new NoSimulationTask("orb links", false),
      h.deps,
      identity,
      { appOrigin: "http://app", appendAlert: () => okAsync({ recordId: "a", duplicate: false }) },
    );
    const self = (await service.invoke({ kind: "self" }, "self"))._unsafeUnwrap() as {
      orb: { url: string };
    };
    expect(self).toMatchObject({
      orb: { url: "http://app/orbs/caller" },
      spawnedByOrb: null,
      children: [],
    });
    const spawned = (
      await service.invoke({ kind: "spawn", prompt: "work" }, "spawn")
    )._unsafeUnwrap() as { orbId: string; url: string };
    expect(spawned.url).toBe(`http://app/orbs/${spawned.orbId}`);
    expect((await service.invoke({ kind: "self" }, "family"))._unsafeUnwrap()).toMatchObject({
      spawnedByOrb: null,
      children: [{ id: spawned.orbId, name: null, url: spawned.url }],
    });
    vi.spyOn(h.store, "listSpawnChildren").mockReturnValue(
      errAsync({
        type: "store_error",
        code: "unavailable",
        message: "raw database host",
        retryable: true,
      }),
    );
    expect((await service.invoke({ kind: "self" }, "self"))._unsafeUnwrapErr()).toEqual({
      code: "unavailable",
      message: "orb operation unavailable",
    });
  });
  it.each(["creating", "starting", "failed"] as const)(
    "admits central spawn and alert during %s without guest identity",
    async (state) => {
      await runDst({ name: `central-native-${state}`, iterations: 5 }, async (sim) => {
        const h = seed();
        const appendAlert = vi.fn(() => okAsync({ recordId: "a", duplicate: false }));
        h.store.seedOrb(
          makeOrbRow("caller", "project", state, { hostRef: null, runtimeTokenHash: null }),
        );
        const result = await sim.runTasks([
          {
            name: "central",
            f: async (task) => {
              const service = createCentralOrbAgentOperations(
                task,
                h.deps,
                {
                  ownerUserId: "owner",
                  projectId: "project",
                  orbId: "caller",
                  agentAdmissionVersion: 0,
                },
                { appOrigin: "http://app", appendAlert },
              );
              expect(
                (await service.invoke({ kind: "notification_admission" }, "notify")).isOk(),
              ).toBe(true);
              expect(appendAlert).not.toHaveBeenCalled();
              expect(
                (
                  await service.invoke({ kind: "search", request: { query: "needle" } }, "search")
                ).isOk(),
              ).toBe(true);
              expect(
                (await service.invoke({ kind: "spawn", prompt: "work" }, "spawn")).isOk(),
              ).toBe(true);
              expect(
                (await service.invoke({ kind: "alert", message: "look" }, "alert")).isOk(),
              ).toBe(true);
            },
          },
        ]);
        expect(result.isOk()).toBe(true);
      });
    },
  );
  it.each(["sleep", "archive", "delete"] as const)(
    "admits central self-%s before VM readiness",
    async (kind) => {
      await runDst({ name: `central-self-${kind}`, iterations: 5 }, async (sim) => {
        const h = seed();
        h.store.seedOrb(
          makeOrbRow("caller", "project", "creating", { hostRef: null, runtimeTokenHash: null }),
        );
        const result = await sim.runTasks([
          {
            name: "central",
            f: async (task) => {
              const service = createCentralOrbAgentOperations(
                task,
                h.deps,
                {
                  ownerUserId: "owner",
                  projectId: "project",
                  orbId: "caller",
                  agentAdmissionVersion: 0,
                },
                {
                  appOrigin: "http://app",
                  appendAlert: () => okAsync({ recordId: "a", duplicate: false }),
                },
              );
              expect(
                (
                  await service.invoke(
                    kind === "sleep" ? { kind, durationSeconds: 60 } : { kind },
                    "self",
                  )
                ).isOk(),
              ).toBe(true);
            },
          },
        ]);
        expect(result.isOk()).toBe(true);
      });
    },
  );
  it.each(["manual", "sleep", "archiving", "archived", "deleting"] as const)(
    "enforces central admission under %s authority while host remains alive",
    async (revocation) => {
      await runDst({ name: `central-revoked-${revocation}`, iterations: 5 }, async (sim) => {
        const h = seed();
        h.store.seedOrb(
          makeOrbRow(
            "caller",
            "project",
            revocation === "manual" || revocation === "sleep" ? "running" : revocation,
            {
              hostRef: "alive",
              runtimeTokenHash: "token",
              stopReason: revocation === "manual" || revocation === "sleep" ? revocation : null,
            },
          ),
        );
        const appendAlert = vi.fn(() => okAsync({ recordId: "a", duplicate: false }));
        const result = await sim.runTasks([
          {
            name: "central",
            f: async (task) => {
              const service = createCentralOrbAgentOperations(
                task,
                h.deps,
                {
                  ownerUserId: "owner",
                  projectId: "project",
                  orbId: "caller",
                  agentAdmissionVersion: 0,
                },
                { appOrigin: "http://app", appendAlert },
              );
              for (const kind of [
                "spawn",
                "alert",
                "archive",
                "delete",
                "sleep",
                "notification_admission",
                "search",
              ] as const) {
                const request =
                  kind === "spawn"
                    ? { kind, prompt: "work" }
                    : kind === "alert"
                      ? { kind, message: "look" }
                      : kind === "sleep"
                        ? { kind, durationSeconds: 60 }
                        : kind === "search"
                          ? { kind, request: { query: "needle" } }
                          : { kind };
                const continuation =
                  revocation === "archiving" &&
                  (kind === "alert" ||
                    kind === "archive" ||
                    kind === "notification_admission" ||
                    kind === "search");
                expect((await service.invoke(request, kind)).isOk()).toBe(continuation);
              }
            },
          },
        ]);
        expect(result.isOk()).toBe(true);
        expect(appendAlert).toHaveBeenCalledTimes(revocation === "archiving" ? 1 : 0);
      });
    },
  );
  it("rejects old central authority after Stop then Start and ownership loss", async () => {
    await runDst({ name: "central-native-revocation", iterations: 5 }, async (sim) => {
      const h = seed();
      const result = await sim.runTasks([
        {
          name: "central",
          f: async (task) => {
            const service = createCentralOrbAgentOperations(
              task,
              h.deps,
              {
                ownerUserId: "owner",
                projectId: "project",
                orbId: "caller",
                agentAdmissionVersion: 0,
              },
              {
                appOrigin: "http://app",
                appendAlert: () => okAsync({ recordId: "a", duplicate: false }),
              },
            );
            const row = h.store.orbSnapshot("caller");
            expect(row).toBeDefined();
            if (!row) return;
            h.store.seedOrb({ ...row, agentAdmissionVersion: 1 });
            expect(
              (await service.invoke({ kind: "notification_admission" }, "old-notify")).isErr(),
            ).toBe(true);
            expect((await service.invoke({ kind: "alert", message: "look" }, "old")).isErr()).toBe(
              true,
            );
            h.store.seedOrb(row);
            h.store.seedProject({ ...makeProjectRow("project"), ownerUserId: "other" });
            expect(
              (
                await service.invoke({ kind: "search", request: { query: "needle" } }, "search")
              )._unsafeUnwrapErr().code,
            ).toBe("unauthorized");
            expect(
              (await service.invoke({ kind: "notification_admission" }, "old-notify")).isErr(),
            ).toBe(true);
            expect((await service.invoke({ kind: "spawn", prompt: "work" }, "old")).isErr()).toBe(
              true,
            );
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
    });
  });
  it("fences guest reads and effects before access", async () => {
    await runDst({ name: "native-orb-denials", iterations: 10 }, async (sim) => {
      const h = seed();
      const appendAlert = vi.fn(() => okAsync({ recordId: "alert", duplicate: false }));
      const result = await sim.runTasks([
        {
          name: "invoke",
          f: async (task) => {
            for (const [bad, patch] of [
              [{ ...identity, incarnation: 2 }, {}],
              [{ ...identity, runtimeTokenHash: "stale" }, {}],
              [{ ...identity, ownerUserId: "other" }, {}],
              [{ ...identity, projectId: "other" }, {}],
              [{ ...identity, runtimeTokenHash: "" }, { runtimeTokenHash: null }],
              [identity, { hostDiscardThroughIncarnation: 1 }],
            ] as const) {
              h.store.seedOrb(
                makeOrbRow("caller", "project", "running", {
                  runtimeTokenHash: "token",
                  hostIncarnation: 1,
                  ...patch,
                }),
              );
              const service = createOrbAgentOperations(task, h.deps, bad, {
                appOrigin: "http://app",
                appendAlert,
              });
              for (const request of [
                { kind: "alert", message: "x" },
                { kind: "search", request: { query: "needle" } },
              ] as const)
                expect((await service.invoke(request, "task:1"))._unsafeUnwrapErr().code).toBe(
                  "unauthorized",
                );
            }
          },
        },
      ]);
      expect(result.isOk()).toBe(true);
      expect(appendAlert).not.toHaveBeenCalled();
    });
  });
  it("commits one spawn and sleep deadline across retried tool IDs without draining", async () => {
    await runDst({ name: "native-orb-retries", iterations: 10 }, async (sim) => {
      const h = seed();
      const result = await sim.runTasks([
        {
          name: "invoke",
          f: async (task) => {
            const service = createOrbAgentOperations(task, h.deps, identity, {
              appOrigin: "http://app",
              appendAlert: () => okAsync({ recordId: "a", duplicate: false }),
            });
            const first = await service.invoke({ kind: "spawn", prompt: "work" }, "task:1");
            const second = await service.invoke({ kind: "spawn", prompt: "work" }, "task:1");
            expect(first.isOk()).toBe(true);
            expect(second).toEqual(first);
            const sleep = await service.invoke({ kind: "sleep", durationSeconds: 60 }, "task:2");
            expect(sleep.isOk()).toBe(true);
            expect(await service.invoke({ kind: "sleep", durationSeconds: 60 }, "task:2")).toEqual(
              sleep,
            );
          },
        },
      ]);
      expect(result.isOk()).toBe(true);
    });
  });
  it("lists only own-owner projects but permits explicit foreign transcripts", async () => {
    await runDst({ name: "native-orb-inspection", iterations: 10 }, async (sim) => {
      const h = seed();
      h.store.seedProject({ ...makeProjectRow("foreign"), ownerUserId: "other" });
      h.store.seedOrb(makeOrbRow("foreign-orb", "foreign", "stopped"));
      const result = await sim.runTasks([
        {
          name: "inspect",
          f: async (task) => {
            const service = createOrbAgentOperations(task, h.deps, identity, {
              appOrigin: "http://app",
              appendAlert: () => okAsync({ recordId: "a", duplicate: false }),
            });
            const list = await service.invoke({ kind: "list" }, "1");
            expect(list.isOk()).toBe(true);
            expect(JSON.stringify(list)).not.toContain("foreign-orb");
            expect(
              (await service.invoke({ kind: "transcript", orbId: "foreign-orb" }, "2")).isOk(),
            ).toBe(true);
          },
        },
      ]);
      expect(result.isOk()).toBe(true);
    });
  });
  it("commits destructive intent with a fenced caller, without invoking manager drain", async () => {
    await runDst({ name: "native-orb-destructive", iterations: 10 }, async (sim) => {
      for (const kind of ["archive", "delete"] as const) {
        const h = seed();
        const method = kind === "archive" ? "requestOrbArchive" : "requestOrbDeletion";
        const write = vi.spyOn(h.store, method);
        const result = await sim.runTasks([
          {
            name: kind,
            f: async (task) => {
              const service = createOrbAgentOperations(task, h.deps, identity, {
                appOrigin: "http://app",
                appendAlert: () => okAsync({ recordId: "a", duplicate: false }),
              });
              expect((await service.invoke({ kind }, "task:destructive")).isOk()).toBe(true);
              expect(h.store.orbSnapshot("caller")?.state).toBe(
                kind === "archive" ? "archiving" : "deleting",
              );
            },
          },
        ]);
        expect(result.isOk()).toBe(true);
        expect(write.mock.calls[0]?.[1]).toMatchObject({
          orbId: "caller",
          caller: { runtimeTokenHash: "token", hostIncarnation: 1 },
        });
      }
    });
  });
  it("passes alert request IDs to the authoritative append port", async () => {
    await runDst({ name: "native-orb-alert", iterations: 5 }, async (sim) => {
      const h = seed();
      const appendAlert = vi.fn(() => okAsync({ recordId: "a", duplicate: false }));
      const result = await sim.runTasks([
        {
          name: "alert",
          f: async (task) => {
            const service = createOrbAgentOperations(task, h.deps, identity, {
              appOrigin: "http://app",
              appendAlert,
            });
            expect(
              (await service.invoke({ kind: "alert", message: "look" }, "child:7")).isOk(),
            ).toBe(true);
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
      expect(appendAlert).toHaveBeenCalledWith("caller", "child:7", "look", 0);
    });
  });
});

it.each(["guest", "central"] as const)(
  "binds %s send identity and target-scoped request IDs",
  async (kind) => {
    const h = seed();
    const task = new NoSimulationTask("peer send", false);
    const options = {
      appOrigin: "http://app",
      appendAlert: () => okAsync({ recordId: "a", duplicate: false }),
    };
    const service =
      kind === "guest"
        ? createOrbAgentOperations(task, h.deps, identity, options)
        : createCentralOrbAgentOperations(
            task,
            h.deps,
            {
              ownerUserId: identity.ownerUserId,
              projectId: identity.projectId,
              orbId: identity.orbId,
              agentAdmissionVersion: 0,
            },
            options,
          );
    const enqueue = vi.spyOn(h.store, "enqueueOrbMessage");
    const ids = [];
    for (const orbId of [
      "00000000-0000-4000-8000-000000000001",
      "00000000-0000-4000-8000-000000000002",
    ]) {
      h.store.seedOrb(makeOrbRow(orbId, identity.projectId, "stopped"));
      const request = { kind: "send" as const, orbId, message: "literal <human>" };
      const receipt = (await service.invoke(request, "fixed"))._unsafeUnwrap();
      expect((await service.invoke(request, "fixed"))._unsafeUnwrap()).toEqual(receipt);
      const params = enqueue.mock.calls.at(-1)?.[1];
      expect(params).toMatchObject({
        orbId,
        content: [{ type: "text", text: request.message }],
        sender: {
          orbId: identity.orbId,
          projectId: identity.projectId,
          ownerUserId: identity.ownerUserId,
          caller:
            kind === "guest"
              ? { runtimeTokenHash: "token", hostIncarnation: 1 }
              : { kind: "central", orbId: identity.orbId, agentAdmissionVersion: 0 },
        },
      });
      ids.push(params?.messageId);
    }
    expect(ids[0]).toBeDefined();
    expect(ids[0]).toBe(ids[1]);
  },
);

it.each(["runtime", "central"] as const)(
  "%s spawn atomically accepts initial model and retries",
  async (kind) => {
    const h = seed();
    const checkSpawnModel = vi.fn<import("./orb-spawning.ts").CheckSpawnModel>(() =>
      okAsync(undefined),
    );
    const deps = { ...h.deps, checkSpawnModel };
    const model =
      kind === "runtime"
        ? { provider: "claude", id: "sonnet" }
        : { provider: "openai-codex", id: "gpt-6-astra" };
    const harness = kind === "runtime" ? "claude" : "pi";
    h.store.seedOrb(
      makeOrbRow("caller", "project", "running", {
        harness: kind === "runtime" ? "pi" : "claude",
        runtimeTokenHash: "token",
        hostIncarnation: 1,
        userTimeZone: "America/Los_Angeles",
      }),
    );
    const task = new NoSimulationTask("model ingress", false);
    const options = {
      appOrigin: "http://app",
      appendAlert: () => okAsync({ recordId: "a", duplicate: false }),
    };
    const service =
      kind === "central"
        ? createCentralOrbAgentOperations(
            task,
            deps,
            {
              ownerUserId: "owner",
              projectId: "project",
              orbId: "caller",
              agentAdmissionVersion: 0,
            },
            options,
          )
        : createOrbAgentOperations(task, deps, identity, options);
    const request = {
      kind: "spawn",
      prompt: "work",
      model,
    } as const;
    const first = (await service.invoke(request, "chosen"))._unsafeUnwrap() as { orbId: string };
    expect(h.store.orbSnapshot(first.orbId)).toMatchObject({
      harness,
      initialModel: model,
      userTimeZone: "America/Los_Angeles",
    });
    checkSpawnModel.mockImplementation(() =>
      errAsync({ type: "spawn_model_error", reason: "disconnected", message: "Disconnected." }),
    );
    expect((await service.invoke(request, "chosen"))._unsafeUnwrap()).toEqual(first);
    expect(
      (
        await service.invoke({ ...request, model: { ...model, id: "changed" } }, "chosen")
      )._unsafeUnwrapErr().code,
    ).toBe("conflict");
    expect(checkSpawnModel).toHaveBeenCalledTimes(1);
    expect(h.store.messageSnapshots(first.orbId)).toHaveLength(1);
  },
);
