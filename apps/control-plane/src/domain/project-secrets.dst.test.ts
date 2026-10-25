import { NoSimulationTask } from "determined";
import { ResultAsync } from "neverthrow";
import { describe, expect, it, vi } from "vitest";

const outsideTask = new NoSimulationTask("project secrets assertions", false);

import { FAILPOINTS } from "../testkit/failpoints.ts";
import { makeProjectSecretsHarness } from "../testkit/project-secrets.ts";
import { runDst, waitUntil } from "../testkit/sim.ts";
import {
  deleteAllProjectSecrets,
  deleteProjectSecret,
  getProjectSecretSnapshot,
  listProjectSecrets,
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
  it("serializes MCP reference publication against deletion without dangling references", async () => {
    await runDst({ name: "mcp-secret-reference-versus-delete", iterations: 80 }, async (sim) => {
      const h = makeProjectSecretsHarness(PROJECT, OTHER);
      (await putProjectSecret(outsideTask, h.deps, PROJECT, "TOKEN", "private"))._unsafeUnwrap();
      let deleted = false;
      let referenced = false;
      const servers = [
        {
          name: "example",
          url: "https://example.com/mcp",
          description: "Example",
          headers: { "X-Api-Key": { secret: "TOKEN" } },
        },
      ];
      const result = await sim.runTasks([
        {
          name: "catalog-writer",
          f: async (task) => {
            referenced = (await h.pointers.replaceMcp(task, PROJECT, servers)).isOk();
          },
        },
        {
          name: "secret-deleter",
          f: async (task) => {
            const result = await deleteProjectSecret(task, h.deps, PROJECT, "TOKEN");
            deleted = result.isOk();
            if (result.isErr()) expect(result.error.type).toBe("project_secret_conflict");
          },
        },
      ]);
      expect(result.isOk()).toBe(true);
      expect(deleted && referenced).toBe(false);
      expect(deleted || referenced).toBe(true);
      const snapshot = expectSnapshot(await getProjectSecretSnapshot(outsideTask, h.deps, PROJECT));
      if (referenced) expect(snapshot["TOKEN"]).toBe("private");
      else expect(snapshot["TOKEN"]).toBeUndefined();
      expect(h.secrets.liveVersions("project-secrets")).toHaveLength(1);
    });
  });
  it("rejects deletion when an MCP attaches after the replacement bundle was staged", async () => {
    await runDst(
      { name: "mcp-reference-during-staged-secret-delete", iterations: 30 },
      async (sim) => {
        const h = makeProjectSecretsHarness(PROJECT);
        (await putProjectSecret(outsideTask, h.deps, PROJECT, "TOKEN", "private"))._unsafeUnwrap();
        const commit = h.pointers.casWriteProjectSecretPointer.bind(h.pointers);
        let staged = false;
        let attached = false;
        h.pointers.casWriteProjectSecretPointer = (...args) =>
          new ResultAsync(
            (async () => {
              staged = true;
              while (!attached)
                await args[0].sleep(1, "wait for MCP attachment before deletion commit");
              return commit(...args);
            })(),
          );
        const result = await sim.runTasks([
          {
            name: "deleter",
            f: async (task) => {
              expect(
                (await deleteProjectSecret(task, h.deps, PROJECT, "TOKEN"))._unsafeUnwrapErr().type,
              ).toBe("project_secret_conflict");
            },
          },
          {
            name: "attacher",
            f: async (task) => {
              while (!staged) await task.sleep(1, "wait for staged deletion bundle");
              (
                await h.pointers.replaceMcp(task, PROJECT, [
                  {
                    name: "service",
                    url: "https://example.com/mcp",
                    description: "Service",
                    headers: { Authorization: { secret: "TOKEN", prefix: "Bearer " } },
                  },
                ])
              )._unsafeUnwrap();
              attached = true;
            },
          },
        ]);
        expect(result.isOk()).toBe(true);
        expect(
          expectSnapshot(await getProjectSecretSnapshot(outsideTask, h.deps, PROJECT))["TOKEN"],
        ).toBe("private");
        expect(h.secrets.liveVersions("project-secrets")).toHaveLength(1);
      },
    );
  });
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
        let writerStaged = false;
        let readDuringRotation = false;
        const commit = harness.pointers.casWriteProjectSecretPointer.bind(harness.pointers);
        harness.pointers.casWriteProjectSecretPointer = (...args) =>
          new ResultAsync(
            (async () => {
              writerStaged = true;
              await waitUntil(
                args[0],
                "snapshot before rotation commits",
                () => readDuringRotation,
              );
              return commit(...args);
            })(),
          );
        const result = await sim.runTasks([
          {
            name: "reader",
            f: async (task) => {
              await waitUntil(task, "rotation staged before snapshot", () => writerStaged);
              const snapshot = await getProjectSecretSnapshot(task, harness.deps, PROJECT);
              snapshots.push(expectSnapshot(snapshot));
              readDuringRotation = true;
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
        expect(readDuringRotation).toBe(true);
        expect(snapshots).toHaveLength(1);
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

  it("keeps the current pointer readable and collects unpublished orphans on deletion", async () => {
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

describe("project secret validation", () => {
  const task = outsideTask;
  it.each([
    ["ASCII", ""],
    ["UTF-8 and JSON escaping", '雪🙂"\\\n'.repeat(100)],
  ])("caps the complete serialized %s bundle at 64 KiB before writes", async (_, prefix) => {
    const h = makeProjectSecretsHarness(PROJECT);
    const payloadSize = (value: string) =>
      Buffer.byteLength(
        JSON.stringify({ projectId: PROJECT, revision: 1, values: { TOKEN: value } }),
      );
    const value = prefix + "a".repeat(64 * 1024 - payloadSize(prefix));
    expect(payloadSize(value)).toBe(64 * 1024);
    expect(
      (await putProjectSecret(task, h.deps, PROJECT, "TOKEN", value))._unsafeUnwrap().revision,
    ).toBe(1);
    const before = h.pointers.snapshot(PROJECT);
    const snapshot = (await getProjectSecretSnapshot(task, h.deps, PROJECT))._unsafeUnwrap();
    const versions = h.secrets.liveVersions("project-secrets");
    const write = vi.spyOn(h.secrets, "writeSecret");
    const commit = vi.spyOn(h.pointers, "casWriteProjectSecretPointer");

    expect(payloadSize(`${value}a`)).toBe(64 * 1024 + 1);
    const rejected = await putProjectSecret(task, h.deps, PROJECT, "TOKEN", `${value}a`);
    expect(rejected._unsafeUnwrapErr().type).toBe("project_secret_invalid");
    expect(write).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
    expect(h.pointers.snapshot(PROJECT)).toEqual(before);
    expect((await getProjectSecretSnapshot(task, h.deps, PROJECT))._unsafeUnwrap()).toEqual(
      snapshot,
    );
    expect(h.secrets.liveVersions("project-secrets")).toEqual(versions);
  });

  it.each([
    ["__proto__", "private-value"],
    ["TOKEN", "private-prefix\0suffix"],
    ["BAD\0NAME", "private-value"],
    ["__proto__", null],
  ])("rejects unsafe %s without publication", async (name, value) => {
    const h = makeProjectSecretsHarness(PROJECT);
    (await putProjectSecret(task, h.deps, PROJECT, "KEEP", "unchanged"))._unsafeUnwrap();
    const before = h.pointers.snapshot(PROJECT);
    const versions = h.secrets.liveVersions("project-secrets");
    const result =
      value === null
        ? await deleteProjectSecret(task, h.deps, PROJECT, name)
        : await putProjectSecret(task, h.deps, PROJECT, name, value);
    expect(result._unsafeUnwrapErr().type).toBe("project_secret_invalid");
    expect(JSON.stringify(result._unsafeUnwrapErr())).not.toContain("private-");
    expect(h.pointers.snapshot(PROJECT)).toEqual(before);
    expect(h.secrets.liveVersions("project-secrets")).toEqual(versions);
    expect(h.secrets.destroyedVersions()).toEqual([]);
  });

  it.each(["constructor", "toString"])("uses own-property membership for %s", async (name) => {
    const h = makeProjectSecretsHarness(PROJECT);
    expect((await deleteProjectSecret(task, h.deps, PROJECT, name))._unsafeUnwrap().revision).toBe(
      0,
    );
    expect(h.secrets.liveVersions("project-secrets")).toEqual([]);
    (await putProjectSecret(task, h.deps, PROJECT, name, " snow\n雪 "))._unsafeUnwrap();
    expect(expectSnapshot(await getProjectSecretSnapshot(task, h.deps, PROJECT))).toEqual({
      [name]: " snow\n雪 ",
    });
    expect((await deleteProjectSecret(task, h.deps, PROJECT, name))._unsafeUnwrap()).toEqual({
      revision: 2,
      items: [],
    });
    expect(expectSnapshot(await getProjectSecretSnapshot(task, h.deps, PROJECT))).toEqual({});
  });

  it.each(["replace", "delete"])(
    "blocks stored NUL consumption but allows %s",
    async (operation) => {
      const h = makeProjectSecretsHarness(PROJECT);
      const secretVersion = h.secrets.seedSecret("project-secrets", {
        projectId: PROJECT,
        revision: 1,
        values: { TOKEN: "private-\0value", KEEP: "preserved" },
      });
      (
        await h.pointers.casWriteProjectSecretPointer(task, PROJECT, null, {
          revision: 1,
          entries: { TOKEN: 1, KEEP: 1 },
          secretVersion,
          updatedAt: 1,
        })
      )._unsafeUnwrap();
      const rejected = (await getProjectSecretSnapshot(task, h.deps, PROJECT))._unsafeUnwrapErr();
      expect(rejected.type).toBe("project_secret_corruption");
      expect(JSON.stringify(rejected)).not.toContain("private-");
      expect(
        (await listProjectSecrets(task, h.deps, PROJECT))
          ._unsafeUnwrap()
          .items.map((item) => item.name),
      ).toEqual(["KEEP", "TOKEN"]);
      const repaired =
        operation === "replace"
          ? await putProjectSecret(task, h.deps, PROJECT, "TOKEN", "repaired")
          : await deleteProjectSecret(task, h.deps, PROJECT, "TOKEN");
      expect(repaired._unsafeUnwrap().revision).toBe(2);
      expect(expectSnapshot(await getProjectSecretSnapshot(task, h.deps, PROJECT))).toEqual(
        operation === "replace" ? { KEEP: "preserved", TOKEN: "repaired" } : { KEEP: "preserved" },
      );
    },
  );
});
