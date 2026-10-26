import { NoSimulationTask, type SimulationTask } from "determined";
import type { ResultAsync } from "neverthrow";
import { expect, it } from "vitest";
import {
  FakeProjectSecretPointerStore,
  makeProjectSecretsHarness,
} from "../testkit/project-secrets.ts";
import { runDst } from "../testkit/sim.ts";
import { getOrbSecretSnapshot, putOwnerSecret, putProjectSecret } from "./project-secrets.ts";

const USER = "00000000-0000-4000-8000-000000000051";
const OTHER = "00000000-0000-4000-8000-000000000052";
const PROJECT = "00000000-0000-4000-8000-000000000053";

// The shared engine is covered by project-secrets.dst.test.ts; this covers what owner scope adds.
it("DST: owner secrets stay per user, in their own namespace, and lose to project secrets", async () => {
  await runDst({ name: "owner-secrets", iterations: 60 }, async (sim) => {
    const project = makeProjectSecretsHarness(PROJECT);
    const owner = {
      pointers: new FakeProjectSecretPointerStore(USER, OTHER),
      secrets: project.secrets,
    };
    const deps = { project: project.deps, owner };
    const orb = { id: PROJECT, ownerUserId: USER };
    const write = (
      name: string,
      f: (task: SimulationTask) => ResultAsync<unknown, { message: string }>,
    ) => ({
      name,
      f: async (task: SimulationTask) => {
        const written = await f(task);
        expect(written.isOk(), written.isErr() ? written.error.message : "").toBe(true);
      },
    });
    const result = await sim.runTasks([
      write("owner-shared", (task) => putOwnerSecret(task, owner, USER, "SHARED", "owner")),
      write("owner-only", (task) => putOwnerSecret(task, owner, USER, "OWNER_ONLY", "o")),
      write("other-user", (task) => putOwnerSecret(task, owner, OTHER, "FOREIGN", "x")),
      write("project", (task) =>
        putProjectSecret(task, project.deps, PROJECT, "SHARED", "project"),
      ),
      {
        name: "orb-boot",
        f: async (task) => {
          const read = (await getOrbSecretSnapshot(task, deps, orb))._unsafeUnwrap();
          expect(read.values.FOREIGN).toBeUndefined();
        },
      },
    ]);
    expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
    const outside = new NoSimulationTask("owner secrets assertions", false);
    expect((await getOrbSecretSnapshot(outside, deps, orb))._unsafeUnwrap()).toEqual({
      revision: 3,
      values: { SHARED: "project", OWNER_ONLY: "o" },
    });
    expect(project.secrets.liveVersions("user-secrets")).toHaveLength(2);
    expect(project.secrets.liveVersions("project-secrets")).toHaveLength(1);
  });
});
