import { createHash } from "node:crypto";
import { errAsync, okAsync, ResultAsync } from "neverthrow";
import { expect, it } from "vitest";
import { ResourceAcquisition, resourceError } from "../../domain/resources.ts";
import { runDst } from "../../testkit/sim.ts";
import { type PersistedPlatformContext, prepareResourceContext } from "./resource-context.ts";

it("DST fences old-context platform publication across Stop ABA and archive", async () => {
  await runDst({ name: "resource-context-publication", iterations: 25 }, async (sim) => {
    let admission = 0;
    let archived = false;
    let stored: PersistedPlatformContext | null = null;
    const publications: Array<{ expected: number; actual: number; archived: boolean }> = [];
    const result = await sim.runTasks([
      {
        name: "old-context",
        f: async (task) => {
          const expected = admission;
          const check = () =>
            admission === expected && !archived
              ? okAsync(undefined)
              : errAsync(resourceError("cancelled", "revoked"));
          const repo = {
            orbId: "orb",
            commitSha: "a".repeat(40),
            instructionPath: null,
            skillRoot: null,
            files: [],
          };
          const acquisition = new ResourceAcquisition(
            {
              get: () => okAsync(repo),
              put: () => okAsync(repo),
              remove: () => okAsync(undefined),
            },
            { acquire: () => okAsync(repo) },
          );
          const bytes = Buffer.from("---\nname: hosting\ndescription: bundled\n---\nbody");
          await prepareResourceContext({
            orbId: "orb",
            url: "https://github.com/o/r",
            signal: new AbortController().signal,
            platformVersion: "v1",
            acquisition,
            managed: () =>
              okAsync({
                personal: { content: "", revision: 0 },
                project: { content: "", revision: 0 },
              }),
            platformStore: {
              get: () => okAsync(stored),
              put: (snapshot) =>
                check().map(() => {
                  publications.push({ expected, actual: admission, archived });
                  stored = snapshot;
                  return undefined;
                }),
            },
            loadPlatform: () =>
              okAsync([
                {
                  path: "/opt/pi-orb/skills/hosting/SKILL.md",
                  bytes,
                  sha256: createHash("sha256").update(bytes).digest("hex"),
                },
              ]),
            check,
            checkpoint: () =>
              ResultAsync.fromSafePromise(task.checkpoint("before-context-publication")),
          });
        },
      },
      {
        name: "stop-start",
        f: async (task) => {
          await task.checkpoint("before-stop");
          admission += 2;
          await task.checkpoint("after-start");
        },
      },
      {
        name: "archive",
        f: async (task) => {
          await task.checkpoint("before-archive");
          archived = true;
          stored = null;
          await task.checkpoint("after-cleanup");
        },
      },
    ]);
    expect(result.isErr() ? result.error : null).toBeNull();
    expect(publications.every((p) => p.expected === p.actual && !p.archived)).toBe(true);
    expect(stored).toBeNull();
  });
});
