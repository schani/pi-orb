import { NoSimulationTask } from "determined";
import { ResultAsync } from "neverthrow";
import { describe, expect, it, vi } from "vitest";
import { FAILPOINTS } from "../testkit/failpoints.ts";
import { makeOwnerSecretsHarness, makeProjectSecretsHarness } from "../testkit/project-secrets.ts";
import { runDst, waitUntil } from "../testkit/sim.ts";
import {
  deleteOwnerSecret,
  getOrbSecretSnapshot,
  getOwnerSecretSnapshot,
  listOwnerSecrets,
  putOwnerSecret,
  putProjectSecret,
} from "./project-secrets.ts";

const outsideTask = new NoSimulationTask("owner secrets assertions", false);
const USER = "00000000-0000-4000-8000-000000000051";
const OTHER = "00000000-0000-4000-8000-000000000052";
const PROJECT = "00000000-0000-4000-8000-000000000053";

function expectSnapshot(
  outcome: Awaited<ReturnType<typeof getOwnerSecretSnapshot>>,
): Record<string, string> {
  expect(outcome.isOk(), outcome.isErr() ? outcome.error.message : "").toBe(true);
  return outcome.isOk() ? outcome.value.values : {};
}

describe("owner secrets (DST)", () => {
  it("linearizes concurrent writers on same and different names per user", async () => {
    await runDst({ name: "owner-secrets-concurrent-writers", iterations: 60 }, async (sim) => {
      const h = makeOwnerSecretsHarness(USER, OTHER);
      const put = (userId: string, name: string, value: string) => ({
        name: `${userId.slice(-2)}-${name}-${value}`,
        f: async (task: Parameters<typeof putOwnerSecret>[0]) => {
          const written = await putOwnerSecret(task, h.deps, userId, name, value);
          expect(written.isOk(), written.isErr() ? written.error.message : "").toBe(true);
        },
      });
      const result = await sim.runTasks([
        put(USER, "TOKEN_A", "alpha"),
        put(USER, "TOKEN_B", "bravo"),
        put(USER, "SHARED", "one"),
        put(USER, "SHARED", "two"),
        put(OTHER, "TOKEN_A", "other"),
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
      const snapshot = expectSnapshot(await getOwnerSecretSnapshot(outsideTask, h.deps, USER));
      expect(snapshot.TOKEN_A).toBe("alpha");
      expect(snapshot.TOKEN_B).toBe("bravo");
      expect(["one", "two"]).toContain(snapshot.SHARED);
      expect(expectSnapshot(await getOwnerSecretSnapshot(outsideTask, h.deps, OTHER))).toEqual({
        TOKEN_A: "other",
      });
      h.pointers.assertMonotonic(USER);
      expect(h.secrets.liveVersions("user-secrets")).toHaveLength(2);
      expect(h.secrets.liveVersions("project-secrets")).toEqual([]);
    });
  });

  it("returns one coherent revision while a writer rotates the bundle", async () => {
    await runDst(
      { name: "owner-secrets-snapshot-during-rotation", iterations: 80 },
      async (sim) => {
        const h = makeOwnerSecretsHarness(USER);
        (await putOwnerSecret(outsideTask, h.deps, USER, "PAIR_A", "old-a"))._unsafeUnwrap();
        (await putOwnerSecret(outsideTask, h.deps, USER, "PAIR_B", "old-b"))._unsafeUnwrap();
        const snapshots: Record<string, string>[] = [];
        let writerStaged = false;
        let readDuringRotation = false;
        const commit = h.pointers.casWriteUserSecretPointer.bind(h.pointers);
        h.pointers.casWriteUserSecretPointer = (...args) =>
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
              snapshots.push(expectSnapshot(await getOwnerSecretSnapshot(task, h.deps, USER)));
              readDuringRotation = true;
            },
          },
          {
            name: "writer",
            f: async (task) => {
              (await putOwnerSecret(task, h.deps, USER, "PAIR_A", "new-a"))._unsafeUnwrap();
            },
          },
        ]);
        expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
        expect(snapshots).toEqual([{ PAIR_A: "old-a", PAIR_B: "old-b" }]);
        expect(expectSnapshot(await getOwnerSecretSnapshot(outsideTask, h.deps, USER))).toEqual({
          PAIR_A: "new-a",
          PAIR_B: "old-b",
        });
        expect(h.secrets.liveVersions("user-secrets")).toHaveLength(1);
      },
    );
  });

  it("preserves pointer invariants under store failpoints", async () => {
    await runDst(
      {
        name: "owner-secrets-failpoints",
        iterations: 60,
        failpointProbabilities: {
          [FAILPOINTS.projectSecretPointerRead]: 0.08,
          [FAILPOINTS.projectSecretPointerWriteBefore]: 0.08,
          [FAILPOINTS.projectSecretPointerWriteAfter]: 0.04,
          [FAILPOINTS.projectSecretRead]: 0.08,
          [FAILPOINTS.projectSecretWrite]: 0.08,
          [FAILPOINTS.projectSecretDestroy]: 0.05,
        },
      },
      async (sim) => {
        const h = makeOwnerSecretsHarness(USER);
        const writer = (name: string, value: string) => ({
          name: `writer-${name}`,
          f: async (task: Parameters<typeof putOwnerSecret>[0]) => {
            for (let attempt = 0; attempt < 30; attempt++) {
              if ((await putOwnerSecret(task, h.deps, USER, name, value)).isOk()) return;
              await task.sleep(10, "retry owner secret write");
            }
          },
        });
        const result = await sim.runTasks([writer("TOKEN", "value"), writer("OTHER", "second")]);
        expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
        await h.assertPublishedPointersReadable(outsideTask);
        h.pointers.assertMonotonic(USER);
      },
    );
  });

  it("merges owner secrets under project secrets for an orb", async () => {
    const owner = makeOwnerSecretsHarness(USER);
    const project = makeProjectSecretsHarness(PROJECT);
    const deps = { project: project.deps, owner: owner.deps };
    const ids = { projectId: PROJECT, ownerUserId: USER };
    expect((await getOrbSecretSnapshot(outsideTask, deps, ids))._unsafeUnwrap()).toEqual({
      revision: 0,
      values: {},
    });
    (await putOwnerSecret(outsideTask, owner.deps, USER, "SHARED", "owner"))._unsafeUnwrap();
    (await putOwnerSecret(outsideTask, owner.deps, USER, "OWNER_ONLY", "o"))._unsafeUnwrap();
    (
      await putProjectSecret(outsideTask, project.deps, PROJECT, "SHARED", "project")
    )._unsafeUnwrap();
    const merged = (await getOrbSecretSnapshot(outsideTask, deps, ids))._unsafeUnwrap();
    expect(merged.values).toEqual({ SHARED: "project", OWNER_ONLY: "o" });
    expect(merged.revision).toBe(3);
    (await deleteOwnerSecret(outsideTask, owner.deps, USER, "OWNER_ONLY"))._unsafeUnwrap();
    const after = (await getOrbSecretSnapshot(outsideTask, deps, ids))._unsafeUnwrap();
    expect(after).toEqual({ revision: 4, values: { SHARED: "project" } });
  });
});

describe("owner secret validation", () => {
  const task = outsideTask;

  it("lists metadata without values and reports a missing user as not found", async () => {
    const h = makeOwnerSecretsHarness(USER);
    expect((await listOwnerSecrets(task, h.deps, USER))._unsafeUnwrap()).toEqual({
      revision: 0,
      items: [],
    });
    const listed = (
      await putOwnerSecret(task, h.deps, USER, "NPM_TOKEN", "private-value")
    )._unsafeUnwrap();
    expect(listed.revision).toBe(1);
    expect(listed.items.map((item) => item.name)).toEqual(["NPM_TOKEN"]);
    expect(JSON.stringify(listed)).not.toContain("private-value");
    const missing = (await putOwnerSecret(task, h.deps, OTHER, "TOKEN", "v"))._unsafeUnwrapErr();
    expect(missing).toEqual({ type: "project_secret_not_found", message: "user not found" });
    expect(h.secrets.liveVersions("user-secrets")).toHaveLength(1);
  });

  it("writes owner bundles keyed by user identity", async () => {
    const h = makeOwnerSecretsHarness(USER);
    const write = vi.spyOn(h.secrets, "writeSecret");
    (await putOwnerSecret(task, h.deps, USER, "TOKEN", "value"))._unsafeUnwrap();
    expect(write).toHaveBeenCalledWith(task, "user-secrets", {
      userId: USER,
      revision: 1,
      values: { TOKEN: "value" },
    });
  });

  it("rejects a bundle whose identity does not match its pointer", async () => {
    const h = makeOwnerSecretsHarness(USER);
    const secretVersion = h.secrets.seedSecret("user-secrets", {
      userId: OTHER,
      revision: 1,
      values: { TOKEN: "private-foreign" },
    });
    (
      await h.pointers.casWriteUserSecretPointer(task, USER, null, {
        revision: 1,
        entries: { TOKEN: 1 },
        secretVersion,
        updatedAt: 1,
      })
    )._unsafeUnwrap();
    const rejected = (await getOwnerSecretSnapshot(task, h.deps, USER))._unsafeUnwrapErr();
    expect(rejected.type).toBe("project_secret_corruption");
    expect(JSON.stringify(rejected)).not.toContain("private-");
  });

  it("caps the serialized owner bundle at 64 KiB before writes", async () => {
    const h = makeOwnerSecretsHarness(USER);
    const payloadSize = (value: string) =>
      Buffer.byteLength(JSON.stringify({ userId: USER, revision: 1, values: { TOKEN: value } }));
    const value = "a".repeat(64 * 1024 - payloadSize(""));
    expect(
      (await putOwnerSecret(task, h.deps, USER, "TOKEN", value))._unsafeUnwrap().revision,
    ).toBe(1);
    const before = h.pointers.snapshot(USER);
    const versions = h.secrets.liveVersions("user-secrets");
    const rejected = await putOwnerSecret(task, h.deps, USER, "TOKEN", `${value}a`);
    expect(rejected._unsafeUnwrapErr().type).toBe("project_secret_invalid");
    expect(h.pointers.snapshot(USER)).toEqual(before);
    expect(h.secrets.liveVersions("user-secrets")).toEqual(versions);
  });

  it.each([
    ["PI_ORB_RUNTIME_TOKEN", "value"],
    ["PATH", "value"],
    ["__proto__", "value"],
    ["TOKEN", "private-\0value"],
    ["TOKEN", ""],
    ["__proto__", null],
  ])("rejects unsafe %s without publication", async (name, value) => {
    const h = makeOwnerSecretsHarness(USER);
    (await putOwnerSecret(task, h.deps, USER, "KEEP", "unchanged"))._unsafeUnwrap();
    const before = h.pointers.snapshot(USER);
    const versions = h.secrets.liveVersions("user-secrets");
    const result =
      value === null
        ? await deleteOwnerSecret(task, h.deps, USER, name)
        : await putOwnerSecret(task, h.deps, USER, name, value);
    expect(result._unsafeUnwrapErr().type).toBe("project_secret_invalid");
    expect(JSON.stringify(result._unsafeUnwrapErr())).not.toContain("private-");
    expect(h.pointers.snapshot(USER)).toEqual(before);
    expect(h.secrets.liveVersions("user-secrets")).toEqual(versions);
  });
});
