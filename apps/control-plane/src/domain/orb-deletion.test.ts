import { NoSimulationTask } from "determined";
import { okAsync } from "neverthrow";
import { describe, expect, it, vi } from "vitest";
import { makeHarness, makeOrbRow, makeProjectRow } from "../testkit/fixtures.ts";
import { LogCapture, runDst } from "../testkit/sim.ts";
import { requestOrbDeletion } from "./lifecycle.ts";
import {
  createCentralOrbAgentOperations,
  createOrbAgentOperations,
} from "./orb-agent-operations.ts";

const SOURCE = "00000000-0000-4000-8000-000000000001";
const CHILD = "00000000-0000-4000-8000-000000000002";
const LEAF = "00000000-0000-4000-8000-000000000003";
const UNRELATED = "00000000-0000-4000-8000-000000000004";
const caller = {
  kind: "central" as const,
  ownerUserId: "owner",
  projectId: "project",
  orbId: SOURCE,
  agentAdmissionVersion: 0,
};
const options = {
  appOrigin: "https://app",
  appendAlert: () => okAsync({ recordId: "alert", duplicate: false }),
};
async function seed(task: NoSimulationTask | import("determined").SimulationTask) {
  const h = makeHarness();
  h.store.seedProject({ ...makeProjectRow("project"), ownerUserId: "owner" });
  h.store.seedOrb(
    makeOrbRow(SOURCE, "project", "running", { runtimeTokenHash: "token", hostIncarnation: 1 }),
  );
  for (const [id, parent] of [
    [CHILD, SOURCE],
    [LEAF, CHILD],
  ] as const) {
    (
      await h.store.spawnOrb(task, {
        callerOrbId: parent,
        caller: { ...caller, orbId: parent },
        orb: makeOrbRow(id, "project", "creating"),
        prompt: "work",
        requestHash: id,
      })
    )._unsafeUnwrap();
  }
  h.store.seedOrb(makeOrbRow(UNRELATED, "project", "archived"));
  return h;
}
const task = new NoSimulationTask("descendant-delete", false);
describe("descendant cleanup", () => {
  it.each([
    undefined,
    {},
    { self: false },
    { self: true, orbId: CHILD },
    { orbId: "short" },
    { orbId: CHILD, force: true },
  ])("rejects invalid intent %j", async (request) => {
    const h = await seed(task);
    const service = createCentralOrbAgentOperations(task, h.deps, caller, options);
    expect(
      (await service.invoke({ kind: "delete", request }, "delete"))._unsafeUnwrapErr().code,
    ).toBe("invalid_request");
    expect(h.store.orbSnapshot(SOURCE)?.state).toBe("running");
    expect(h.store.orbSnapshot(CHILD)?.state).toBe("creating");
  });
  it("rejects own UUID with explicit self guidance", async () => {
    const h = await seed(task);
    const service = createCentralOrbAgentOperations(task, h.deps, caller, options);
    expect(
      (
        await service.invoke({ kind: "delete", request: { orbId: SOURCE.toUpperCase() } }, "delete")
      )._unsafeUnwrapErr(),
    ).toMatchObject({ code: "invalid_request", message: expect.stringContaining("self") });
  });
  it("lists retained descendants through deleted intermediates, including blockers and terminal states", async () => {
    const h = await seed(task);
    (await requestOrbDeletion(task, h.deps, CHILD))._unsafeUnwrap();
    (
      await h.store.finalizeOrbDeletion(task, { orbId: CHILD, expectedStateVersion: 1 })
    )._unsafeUnwrap();
    h.store.seedOrb(makeOrbRow(LEAF, "project", "failed", { lastError: "cleanup blocked" }));
    const service = createCentralOrbAgentOperations(task, h.deps, caller, options);
    const listed = (
      await service.invoke({ kind: "list", descendantsOnly: true }, "list")
    )._unsafeUnwrap();
    expect(listed).toMatchObject({
      currentOrbId: SOURCE,
      items: [{ id: LEAF, state: "failed", stateDetail: "cleanup blocked" }],
    });
    expect((listed as { items: unknown[] }).items).toHaveLength(1);
    expect(
      (
        await service.invoke({ kind: "delete", request: { orbId: LEAF } }, "delete")
      )._unsafeUnwrap(),
    ).toEqual({ orbId: LEAF, state: "deleting" });
    expect(h.store.orbSnapshot(SOURCE)?.state).toBe("running");
  });
  it.each([
    "creating",
    "starting",
    "running",
    "stopping",
    "stopped",
    "failed",
    "archiving",
    "archived",
    "deleting",
  ] as const)(
    "accepts descendant target in %s without cascading or resetting quarantine",
    async (state) => {
      const h = await seed(task);
      if (state === "deleting") (await requestOrbDeletion(task, h.deps, CHILD))._unsafeUnwrap();
      else h.store.seedOrb(makeOrbRow(CHILD, "project", state));
      const before = (await h.store.getOrbDeletion(task, CHILD))._unsafeUnwrap();
      const service = createCentralOrbAgentOperations(task, h.deps, caller, options);
      expect(
        (
          await service.invoke({ kind: "delete", request: { orbId: CHILD } }, "delete")
        )._unsafeUnwrap(),
      ).toEqual({ orbId: CHILD, state: "deleting" });
      const deletion = (await h.store.getOrbDeletion(task, CHILD))._unsafeUnwrap();
      expect(
        (await service.invoke({ kind: "delete", request: { orbId: CHILD } }, "retry")).isOk(),
      ).toBe(true);
      expect((await h.store.getOrbDeletion(task, CHILD))._unsafeUnwrap()).toEqual(deletion);
      if (state === "deleting") expect(deletion).toEqual(before);
      expect(h.store.orbSnapshot(SOURCE)?.state).toBe("running");
      expect(h.store.orbSnapshot(LEAF)?.state).toBe("creating");
    },
  );
  it.each(["unrelated", "other-project", "other-owner", "missing"] as const)(
    "refuses %s targets",
    async (scope) => {
      const h = await seed(task);
      let target = UNRELATED;
      if (scope === "missing") target = "00000000-0000-4000-8000-000000000005";
      if (scope === "other-project" || scope === "other-owner") {
        h.store.seedProject({
          ...makeProjectRow("other"),
          ownerUserId: scope === "other-owner" ? "other" : "owner",
        });
        h.store.seedOrb(makeOrbRow(CHILD, "other", "creating"));
        target = CHILD;
      }
      const service = createCentralOrbAgentOperations(task, h.deps, caller, options);
      expect(
        (
          await service.invoke({ kind: "delete", request: { orbId: target } }, "delete")
        )._unsafeUnwrapErr().code,
      ).toBe("not_found");
      expect(h.store.orbSnapshot(SOURCE)?.state).toBe("running");
      expect(h.store.orbSnapshot(CHILD)?.state).toBe("creating");
    },
  );
  it.each(["central", "guest"] as const)(
    "revalidates %s source at the mutation boundary, including idempotent requests",
    async (kind) => {
      for (const alreadyDeleting of [false, true]) {
        const h = await seed(task);
        if (alreadyDeleting) (await requestOrbDeletion(task, h.deps, CHILD))._unsafeUnwrap();
        const write = h.store.requestOrbDeletion.bind(h.store);
        vi.spyOn(h.store, "requestOrbDeletion").mockImplementation((t, params) => {
          h.store.seedOrb(
            makeOrbRow(SOURCE, "project", "running", {
              runtimeTokenHash: "token",
              hostIncarnation: 2,
              agentAdmissionVersion: 1,
            }),
          );
          return write(t, params);
        });
        const service =
          kind === "central"
            ? createCentralOrbAgentOperations(task, h.deps, caller, options)
            : createOrbAgentOperations(
                task,
                h.deps,
                {
                  ownerUserId: "owner",
                  projectId: "project",
                  orbId: SOURCE,
                  incarnation: 1,
                  runtimeTokenHash: "token",
                },
                options,
              );
        expect(
          (
            await service.invoke({ kind: "delete", request: { orbId: CHILD } }, "delete")
          )._unsafeUnwrapErr().code,
        ).toBe("conflict");
        expect(h.store.orbSnapshot(CHILD)?.state).toBe(alreadyDeleting ? "deleting" : "creating");
      }
    },
  );
  it("races source revocation and concurrent cleanup without extending quarantine", async () => {
    const logs = new LogCapture();
    await runDst(
      { name: "descendant-delete-source-race", iterations: 30, logCapture: logs },
      async (sim) => {
        const h = await seed(task);
        const result = await sim.runTasks([
          ...[1, 2].map((n) => ({
            name: `delete-${n}`,
            f: async (t: import("determined").SimulationTask) => {
              const service = createCentralOrbAgentOperations(t, h.deps, caller, options);
              const deleted = await service.invoke(
                { kind: "delete", request: { orbId: CHILD } },
                `delete-${n}`,
              );
              expect(
                deleted.isOk() ||
                  ["conflict", "unauthorized"].includes(deleted._unsafeUnwrapErr().code),
              ).toBe(true);
            },
          })),
          {
            name: "revoke-source",
            f: async (t) => {
              (await requestOrbDeletion(t, h.deps, SOURCE))._unsafeUnwrap();
            },
          },
        ]);
        expect(result.isOk()).toBe(true);
        expect(
          logs.matching(`orb=${CHILD}`).filter((line) => line.includes("delete_requested")).length,
        ).toBeLessThanOrEqual(1);
        if (h.store.orbSnapshot(CHILD)?.state === "deleting") {
          const event = logs.matching("delete_requested").find((line) => line.includes(CHILD));
          expect(event).toContain("source=descendant");
          expect(event).toContain(`callerOrbId=${SOURCE}`);
        }
      },
    );
  });
});
