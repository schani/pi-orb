import { NoSimulationTask } from "determined";
import { describe, expect, it } from "vitest";

const outsideTask = new NoSimulationTask("project secrets assertions", false);

import { FAILPOINTS } from "../testkit/failpoints.ts";
import { makeProjectSecretsHarness } from "../testkit/project-secrets.ts";
import { runDst } from "../testkit/sim.ts";
import {
  deleteAllProjectSecrets,
  getProjectSecretSnapshot,
  putProjectSecret,
} from "./project-secrets.ts";

const PROJECT = "00000000-0000-4000-8000-000000000041";
const OTHER = "00000000-0000-4000-8000-000000000042";

function expectSnapshot(
  outcome: Awaited<ReturnType<typeof getProjectSecretSnapshot>>,
): Record<string, string> {
  expect(outcome.isOk(), outcome.isErr() ? outcome.error.message : "").toBe(true);
  return outcome.isOk() ? outcome.value.values : {};
}

describe("project secrets (DST)", () => {
  it("linearizes concurrent writers on same and different names", async () => {
    await runDst({ name: "project-secrets-concurrent-writers", iterations: 60 }, async (sim) => {
      const harness = makeProjectSecretsHarness(PROJECT, OTHER);
      const result = await sim.runTasks([
        {
          name: "writer-a",
          f: async (task) => {
            expect(
              (await putProjectSecret(task, harness.deps, PROJECT, "TOKEN_A", "alpha")).isOk(),
            ).toBe(true);
          },
        },
        {
          name: "writer-b",
          f: async (task) => {
            expect(
              (await putProjectSecret(task, harness.deps, PROJECT, "TOKEN_B", "bravo")).isOk(),
            ).toBe(true);
          },
        },
        {
          name: "shared-writer-1",
          f: async (task) => {
            expect(
              (await putProjectSecret(task, harness.deps, PROJECT, "SHARED", "one")).isOk(),
            ).toBe(true);
          },
        },
        {
          name: "shared-writer-2",
          f: async (task) => {
            expect(
              (await putProjectSecret(task, harness.deps, PROJECT, "SHARED", "two")).isOk(),
            ).toBe(true);
          },
        },
        {
          name: "other-project",
          f: async (task) => {
            expect(
              (await putProjectSecret(task, harness.deps, OTHER, "TOKEN_A", "other")).isOk(),
            ).toBe(true);
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
      const projectSnapshot = expectSnapshot(
        await getProjectSecretSnapshot(outsideTask, harness.deps, PROJECT),
      );
      expect(projectSnapshot.TOKEN_A).toBe("alpha");
      expect(projectSnapshot.TOKEN_B).toBe("bravo");
      expect(["one", "two"]).toContain(projectSnapshot.SHARED);
      expect(
        expectSnapshot(await getProjectSecretSnapshot(outsideTask, harness.deps, OTHER)),
      ).toEqual({
        TOKEN_A: "other",
      });
      harness.pointers.assertMonotonic(PROJECT);
    });
  });

  it("returns one coherent revision while a writer rotates the bundle", async () => {
    await runDst(
      { name: "project-secrets-snapshot-during-rotation", iterations: 80 },
      async (sim) => {
        const harness = makeProjectSecretsHarness(PROJECT);
        expect(
          (await putProjectSecret(outsideTask, harness.deps, PROJECT, "PAIR_A", "old-a")).isOk(),
        ).toBe(true);
        expect(
          (await putProjectSecret(outsideTask, harness.deps, PROJECT, "PAIR_B", "old-b")).isOk(),
        ).toBe(true);
        const snapshots: Record<string, string>[] = [];
        const result = await sim.runTasks([
          {
            name: "reader",
            f: async (task) => {
              const snapshot = await getProjectSecretSnapshot(task, harness.deps, PROJECT);
              if (snapshot.isOk()) snapshots.push(snapshot.value.values);
            },
          },
          {
            name: "writer",
            f: async (task) => {
              expect(
                (await putProjectSecret(task, harness.deps, PROJECT, "PAIR_A", "new-a")).isOk(),
              ).toBe(true);
            },
          },
        ]);
        expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
        for (const snapshot of snapshots) {
          expect(snapshot).toEqual(
            snapshot.PAIR_A === "new-a"
              ? { PAIR_A: "new-a", PAIR_B: "old-b" }
              : { PAIR_A: "old-a", PAIR_B: "old-b" },
          );
        }
      },
    );
  });

  it("fences an update racing project deletion and removes every project version", async () => {
    await runDst({ name: "project-secrets-update-versus-delete", iterations: 80 }, async (sim) => {
      const harness = makeProjectSecretsHarness(PROJECT);
      expect(
        (await putProjectSecret(outsideTask, harness.deps, PROJECT, "TOKEN", "old")).isOk(),
      ).toBe(true);
      const result = await sim.runTasks([
        {
          name: "writer",
          f: async (task) => {
            const written = await putProjectSecret(task, harness.deps, PROJECT, "TOKEN", "new");
            if (written.isErr()) expect(written.error.type).toBe("project_secret_conflict");
          },
        },
        {
          name: "deleter",
          f: async (task) => {
            await harness.pointers.markProjectDeleting(task, PROJECT);
            const deleted = await deleteAllProjectSecrets(task, harness.deps, PROJECT);
            expect(deleted.isOk(), deleted.isErr() ? deleted.error.message : "").toBe(true);
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
      expect(harness.pointers.snapshot(PROJECT)).toBeNull();
      expect(harness.secrets.liveVersions("project-secrets")).toEqual([]);
    });
  });

  it("keeps pointers readable across crash windows and deletion collects orphan versions", async () => {
    await runDst({ name: "project-secrets-crash-windows", iterations: 30 }, async (_sim) => {
      const harness = makeProjectSecretsHarness(PROJECT);
      expect(
        (await putProjectSecret(outsideTask, harness.deps, PROJECT, "TOKEN", "current")).isOk(),
      ).toBe(true);
      const pointer = harness.pointers.snapshot(PROJECT);
      expect(pointer).not.toBeNull();
      harness.secrets.seedSecret("project-secrets", {
        projectId: PROJECT,
        revision: (pointer?.revision ?? 0) + 1,
        values: { TOKEN: "orphan" },
      });
      expect(
        expectSnapshot(await getProjectSecretSnapshot(outsideTask, harness.deps, PROJECT)),
      ).toEqual({
        TOKEN: "current",
      });
      await harness.pointers.markProjectDeleting(outsideTask, PROJECT);
      expect((await deleteAllProjectSecrets(outsideTask, harness.deps, PROJECT)).isOk()).toBe(true);
      expect(harness.secrets.liveVersions("project-secrets")).toEqual([]);
    });
  });

  it("preserves pointer invariants under store failpoints", async () => {
    await runDst(
      {
        name: "project-secrets-failpoints",
        iterations: 60,
        failpointProbabilities: {
          [FAILPOINTS.projectSecretPointerRead]: 0.08,
          [FAILPOINTS.projectSecretPointerWriteBefore]: 0.08,
          [FAILPOINTS.projectSecretPointerWriteAfter]: 0.04,
          [FAILPOINTS.projectSecretRead]: 0.08,
          [FAILPOINTS.projectSecretWrite]: 0.08,
          [FAILPOINTS.projectSecretDestroy]: 0.05,
          [FAILPOINTS.projectSecretList]: 0.05,
        },
      },
      async (sim) => {
        const harness = makeProjectSecretsHarness(PROJECT);
        const result = await sim.runTasks([
          {
            name: "writer",
            f: async (task) => {
              for (let attempt = 0; attempt < 30; attempt++) {
                const written = await putProjectSecret(
                  task,
                  harness.deps,
                  PROJECT,
                  "TOKEN",
                  "value",
                );
                if (written.isOk()) return;
                await task.sleep(10, "retry project secret write");
              }
            },
          },
        ]);
        expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
        await harness.assertPublishedPointersReadable(outsideTask);
      },
    );
  });
});
