import type { OrbSelf } from "@pi-orb/protocol";
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
describe("central orb operations", () => {
  it("returns path-routed self and spawned orb links", async () => {
    const h = seed();
    const service = createOrbAgentOperations(
      new NoSimulationTask("orb links", false),
      h.deps,
      identity,
      { appOrigin: "http://app", appendAlert: () => okAsync({ recordId: "a" }) },
    );
    const self = (await service.invoke({ kind: "self" }, "self"))._unsafeUnwrap() as {
      orb: { url: string };
    };
    expect(self.orb.url).toBe("http://app/orbs/caller");
    const spawned = (
      await service.invoke({ kind: "spawn", prompt: "work" }, "spawn")
    )._unsafeUnwrap() as { orbId: string; url: string };
    expect(spawned.url).toBe(`http://app/orbs/${spawned.orbId}`);
  });
  it.each(["runtime", "central"] as const)(
    "reads direct spawn family through %s self",
    async (kind) => {
      const h = seed();
      const task = new NoSimulationTask("self family", false);
      const serviceFor = (orbId: string) => {
        const options = { appOrigin: "http://app", appendAlert: () => okAsync({ recordId: "a" }) };
        return kind === "central"
          ? createCentralOrbAgentOperations(
              task,
              h.deps,
              {
                ownerUserId: "owner",
                projectId: "project",
                orbId,
                agentAdmissionVersion: 0,
              },
              options,
            )
          : createOrbAgentOperations(task, h.deps, { ...identity, orbId }, options);
      };
      const service = serviceFor("caller");
      expect((await service.invoke({ kind: "self" }, "empty"))._unsafeUnwrap()).toMatchObject({
        spawnedBy: null,
        children: [],
      });
      const spawn = async (parent: ReturnType<typeof serviceFor>, requestId: string) => {
        const result = (
          await parent.invoke({ kind: "spawn", prompt: "work" }, requestId)
        )._unsafeUnwrap() as { orbId: string };
        h.store.seedOrb(
          makeOrbRow(result.orbId, "project", "running", {
            runtimeTokenHash: "token",
            hostIncarnation: 1,
          }),
        );
        return result.orbId;
      };
      const childId = await spawn(service, "child");
      const deletedId = await spawn(service, "deleted");
      const child = serviceFor(childId);
      const grandchildId = await spawn(child, "grandchild");
      h.store.seedOrb(makeOrbRow("unrelated", "project", "archived"));
      h.store.seedOrb(makeOrbRow(deletedId, "project", "archived", { name: "Archived" }));
      const before = (await service.invoke({ kind: "self" }, "before"))._unsafeUnwrap() as OrbSelf;
      expect(before.children).toEqual(
        [
          { id: childId, name: null, url: `http://app/orbs/${childId}` },
          { id: deletedId, name: "Archived", url: `http://app/orbs/${deletedId}` },
        ].sort((a, b) => a.id.localeCompare(b.id)),
      );
      const remove = async (orbId: string) => {
        const requested = (
          await h.store.requestOrbDeletion(task, {
            orbId,
            expectedStateVersion: 0,
            now: 100,
            cleanupAfter: 100,
          })
        )._unsafeUnwrap();
        expect(
          (
            await h.store.finalizeOrbDeletion(task, {
              orbId,
              expectedStateVersion: requested.stateVersion,
            })
          ).isOk(),
        ).toBe(true);
      };
      await remove(deletedId);
      expect((await service.invoke({ kind: "self" }, "after"))._unsafeUnwrap()).toMatchObject({
        children: [{ id: childId, name: null, url: `http://app/orbs/${childId}` }],
      });
      await remove("caller");
      expect((await child.invoke({ kind: "self" }, "child-self"))._unsafeUnwrap()).toMatchObject({
        spawnedBy: { id: "caller", url: "http://app/orbs/caller" },
        children: [{ id: grandchildId, name: null, url: `http://app/orbs/${grandchildId}` }],
      });
    },
  );

  it("reports child lookup failure without a partial self result", async () => {
    const h = seed();
    vi.spyOn(h.store, "listSpawnChildren").mockReturnValue(
      errAsync({
        type: "store_error",
        code: "unavailable",
        message: "raw database host",
        retryable: true,
      }),
    );
    const service = createOrbAgentOperations(
      new NoSimulationTask("self unavailable", false),
      h.deps,
      identity,
      { appOrigin: "http://app", appendAlert: () => okAsync({ recordId: "a" }) },
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
                { appOrigin: "http://app", appendAlert: () => okAsync({ recordId: "a" }) },
              );
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
                { appOrigin: "http://app", appendAlert: () => okAsync({ recordId: "a" }) },
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
        const appendAlert = vi.fn(() => okAsync({ recordId: "a" }));
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
              for (const kind of ["spawn", "alert", "archive", "delete", "sleep"] as const) {
                const request =
                  kind === "spawn"
                    ? { kind, prompt: "work" }
                    : kind === "alert"
                      ? { kind, message: "look" }
                      : kind === "sleep"
                        ? { kind, durationSeconds: 60 }
                        : { kind };
                const continuation =
                  revocation === "archiving" && (kind === "alert" || kind === "archive");
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
      await sim.runTasks([
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
              { appOrigin: "http://app", appendAlert: () => okAsync({ recordId: "a" }) },
            );
            const row = h.store.orbSnapshot("caller");
            expect(row).toBeDefined();
            if (!row) return;
            h.store.seedOrb({ ...row, agentAdmissionVersion: 1 });
            expect((await service.invoke({ kind: "alert", message: "look" }, "old")).isErr()).toBe(
              true,
            );
            h.store.seedOrb(row);
            h.store.seedProject({ ...makeProjectRow("project"), ownerUserId: "other" });
            expect((await service.invoke({ kind: "spawn", prompt: "work" }, "old")).isErr()).toBe(
              true,
            );
          },
        },
      ]);
    });
  });
  it("denies stale incarnation and mismatched owner before effects", async () => {
    await runDst({ name: "native-orb-denials", iterations: 10 }, async (sim) => {
      const h = seed();
      const appendAlert = vi.fn(() => okAsync({ recordId: "alert" }));
      const result = await sim.runTasks([
        {
          name: "invoke",
          f: async (task) => {
            for (const bad of [
              { ...identity, incarnation: 2 },
              { ...identity, ownerUserId: "other" },
              { ...identity, projectId: "other" },
            ]) {
              const service = createOrbAgentOperations(task, h.deps, bad, {
                appOrigin: "http://app",
                appendAlert,
              });
              expect(
                (await service.invoke({ kind: "alert", message: "x" }, "task:1")).isErr(),
              ).toBe(true);
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
              appendAlert: () => okAsync({ recordId: "a" }),
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
              appendAlert: () => okAsync({ recordId: "a" }),
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
                appendAlert: () => okAsync({ recordId: "a" }),
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
      const appendAlert = vi.fn(() => okAsync({ recordId: "a" }));
      await sim.runTasks([
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
      expect(appendAlert).toHaveBeenCalledWith("caller", "child:7", "look", 0);
    });
  });
});

describe("peer sends", () => {
  it.each(["guest", "central"] as const)(
    "binds %s sender and deduplicates target-scoped receipts",
    async (kind) => {
      const h = makeHarness();
      const peerIdentity = {
        ...identity,
        orbId: "00000000-0000-4000-8000-000000000009",
        projectId: "00000000-0000-4000-8000-00000000000a",
        ownerUserId: "00000000-0000-4000-8000-00000000000b",
      };
      h.store.seedProject({
        ...makeProjectRow(peerIdentity.projectId),
        ownerUserId: peerIdentity.ownerUserId,
      });
      h.store.seedOrb(
        makeOrbRow(peerIdentity.orbId, peerIdentity.projectId, "running", {
          runtimeTokenHash: "token",
          hostIncarnation: 1,
        }),
      );
      h.store.seedOrb(
        makeOrbRow("00000000-0000-4000-8000-000000000001", peerIdentity.projectId, "stopped", {
          stopReason: "manual",
        }),
      );
      h.store.seedOrb(
        makeOrbRow("00000000-0000-4000-8000-000000000002", peerIdentity.projectId, "stopped"),
      );
      const task = new NoSimulationTask("peer send", false);
      const options = { appOrigin: "http://app", appendAlert: () => okAsync({ recordId: "a" }) };
      const service =
        kind === "guest"
          ? createOrbAgentOperations(task, h.deps, peerIdentity, options)
          : createCentralOrbAgentOperations(
              task,
              h.deps,
              {
                ownerUserId: peerIdentity.ownerUserId,
                projectId: peerIdentity.projectId,
                orbId: peerIdentity.orbId,
                agentAdmissionVersion: 0,
              },
              options,
            );
      const request = {
        kind: "send" as const,
        orbId: "00000000-0000-4000-8000-000000000001",
        message: "literal <human>",
      };
      const accepted = (await service.invoke(request, "fixed"))._unsafeUnwrap() as {
        messageId: string;
      };
      expect((await service.invoke(request, "fixed"))._unsafeUnwrap()).toEqual(accepted);
      expect(h.store.messageSnapshots("00000000-0000-4000-8000-000000000001")).toMatchObject([
        {
          messageId: accepted.messageId,
          system: { kind: "orb_message", senderOrbId: peerIdentity.orbId },
          content: [{ type: "text", text: request.message }],
          autoStart: true,
        },
      ]);
      expect(h.store.orbSnapshot("00000000-0000-4000-8000-000000000001")?.stopReason).toBeNull();
      expect((await service.invoke({ ...request, message: "changed" }, "fixed")).isErr()).toBe(
        true,
      );
      expect(
        (
          await service.invoke(
            { ...request, orbId: "00000000-0000-4000-8000-000000000002" },
            "fixed",
          )
        ).isOk(),
      ).toBe(true);
      expect((await service.invoke({ ...request, message: " " }, "blank")).isErr()).toBe(true);
      expect(
        (await service.invoke({ ...request, orbId: "invalid" }, "bad"))._unsafeUnwrapErr().code,
      ).toBe("invalid_request");
    },
  );
});
