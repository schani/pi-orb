import { createHash } from "node:crypto";
import { ConditionVariable } from "determined";
import { errAsync, okAsync, ResultAsync } from "neverthrow";
import { expect, it } from "vitest";
import { ResourceAcquisition, resourceError } from "../../domain/resources.ts";
import { runDst } from "../../testkit/sim.ts";
import { type PersistedPlatformContext, prepareResourceContext } from "./resource-context.ts";

const interferenceModes = ["after-baseline", "publication-frontier"] as const;
const testName = "DST fences old-context platform publication across Stop ABA and archive";

it.each(interferenceModes)(`${testName} (%s)`, async (interference) => {
  const options = { name: `resource-context-publication-${interference}`, iterations: 25 };
  await runDst(options, async (sim) => {
    const changed = new ConditionVariable("context progress");
    let admission = 0;
    let archived = false;
    let baselineReady = false;
    let publicationPending = false;
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
          const context: Parameters<typeof prepareResourceContext>[0] = {
            signal: new AbortController().signal,
            platformVersion: "v1",
            acquisition: {
              acquire: () =>
                acquisition.acquire({
                  orbId: "orb",
                  url: "https://github.com/o/r",
                  signal: new AbortController().signal,
                }),
            },
            managed: () =>
              okAsync({
                personal: { content: "", revision: 0 },
                project: { content: "", revision: 0 },
                skills: [],
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
          };
          expect((await prepareResourceContext(context))._unsafeUnwrap().commitSha).toBe(
            repo.commitSha,
          );
          expect(publications).toEqual([{ expected: 0, actual: 0, archived: false }]);
          baselineReady = true;
          changed.notifyAll(task, "baseline published");
          await task.checkpoint("before-stale-context");
          const stale = await prepareResourceContext({
            ...context,
            platformVersion: "v2",
            checkpoint: () =>
              ResultAsync.fromSafePromise(
                (async () => {
                  if (interference === "publication-frontier") {
                    publicationPending = true;
                    changed.notifyAll(task, "stale context ready to publish");
                    while (admission === expected && !archived)
                      await changed.wait(task, "context revoked before publication");
                  }
                  await task.checkpoint("before-context-publication");
                })(),
              ),
          });
          if (interference === "publication-frontier" || stale.isErr())
            expect(stale._unsafeUnwrapErr()).toMatchObject({
              code: "cancelled",
              message: "revoked",
            });
          else expect(stale.value.commitSha).toBe(repo.commitSha);
        },
      },
      {
        name: "stop-start",
        f: async (task) => {
          while (!(interference === "publication-frontier" ? publicationPending : baselineReady))
            await changed.wait(task, "publication frontier reached");
          await task.checkpoint("before-stop");
          admission += 2;
          changed.notifyAll(task, "Stop ABA completed");
          await task.checkpoint("after-start");
        },
      },
      {
        name: "archive",
        f: async (task) => {
          while (!(interference === "publication-frontier" ? publicationPending : baselineReady))
            await changed.wait(task, "publication frontier reached");
          await task.checkpoint("before-archive");
          archived = true;
          stored = null;
          changed.notifyAll(task, "archive completed");
          await task.checkpoint("after-cleanup");
        },
      },
    ]);
    expect(result.isErr() ? result.error : null).toBeNull();
    expect(publications.length).toBeGreaterThanOrEqual(1);
    expect(publications.length).toBeLessThanOrEqual(
      interference === "publication-frontier" ? 1 : 2,
    );
    expect(publications.every((p) => p.expected === 0 && p.actual === 0 && !p.archived)).toBe(true);
    expect(stored).toBeNull();
  });
});
