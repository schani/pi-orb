import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import { NoSimulationTask } from "determined";
import { okAsync, ResultAsync } from "neverthrow";
import { assert, expect, it, vi } from "vitest";
import { buildExecutionServer } from "../../orb-runtime/src/execution/server.ts";
import { composeControlPlaneDatabase } from "./adapters/database.ts";
import { NativeResourceContext } from "./adapters/durable/context-storage.ts";
import * as durableModels from "./adapters/durable/models.ts";
import { PGliteClient } from "./adapters/pg/pglite-client.ts";
import { PgResourceSnapshots } from "./adapters/pg/resource-snapshots.ts";
import type { ResourceSnapshot } from "./domain/resources.ts";
import { createProcessAgentContext } from "./process-agent-composition.ts";
import { makeHarness, makeOrbRow, makeProjectRow } from "./testkit/fixtures.ts";

const skillPath = ".agents/skills/proof/SKILL.md";
const skill = "---\nname: proof\ndescription: composition proof\n---\nPG skill baseline";
function required<T>(value: T | null | undefined): T {
  assert(value !== null && value !== undefined, "Missing proof fixture capability");
  return value;
}
function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function fixture() {
  const db = new PGliteClient();
  const database = composeControlPlaneDatabase(db);
  const task = new NoSimulationTask("resource composition proof", false);
  const project = makeProjectRow(randomUUID());
  let orb = makeOrbRow(randomUUID(), project.id, "starting", { hostRef: "proof-host" });
  (await database.migrate())._unsafeUnwrap();
  (
    await database.users.resolveUser(
      task,
      { issuer: "test", subject: "resource-owner", email: null },
      { id: project.ownerUserId, now: 0 },
    )
  )._unsafeUnwrap();
  (await database.store.insertProject(task, project))._unsafeUnwrap();
  (await database.store.insertOrb(task, orb))._unsafeUnwrap();
  (
    await database.personalInstructions.replace(task, project.ownerUserId, "personal-v1")
  )._unsafeUnwrap();
  (await database.projectInstructions.replace(task, project.id, "project-v1"))._unsafeUnwrap();
  const acquired = barrier(),
    releaseGit = barrier();
  let fetches = 0,
    bindings = 0;
  const snapshot: ResourceSnapshot = {
    orbId: orb.id,
    commitSha: "a".repeat(40),
    instructionPath: "AGENTS.md",
    skillRoot: ".agents/skills",
    files: (
      [
        ["AGENTS.md", "immutable Git instructions"],
        [skillPath, skill],
        [".agents/skills/proof/reference.md", "offline reference"],
      ] as const
    ).map(([path, text]) => ({
      path,
      bytes: Buffer.from(text),
      sha256: createHash("sha256").update(text).digest("hex"),
    })),
  };
  const resources = database.resourceGate({
    acquire: () => {
      fetches++;
      acquired.resolve();
      return ResultAsync.fromSafePromise(releaseGit.promise).map(() => snapshot);
    },
  });
  const root = await mkdtemp(join(tmpdir(), "resource-composition-proof-"));
  await mkdir(join(root, ".agents/skills/proof"), { recursive: true });
  await writeFile(join(root, skillPath), skill);
  let hostInstructions = "hook-modified instructions";
  const server = buildExecutionServer({
    token: "proof-token",
    incarnation: "0",
    cwd: root,
    ready: () => ({
      cwd: root,
      incarnation: "0",
      pid: process.pid,
      checkoutCommit: snapshot.commitSha,
      instructions: [{ path: join(root, "AGENTS.md"), content: hostInstructions }],
      skills: [{ path: join(root, skillPath), content: skill }],
      resources: [],
    }),
  });
  const baseUrl = await server.listen({ host: "127.0.0.1", port: 0 });
  let readyReads = 0;
  const h = makeHarness();
  const deps = {
    ...h.deps,
    store: database.store,
    personalInstructions: database.personalInstructions,
    projectInstructions: database.projectInstructions,
    hostProvider: {
      ...h.deps.hostProvider,
      executionBinding: () => {
        bindings++;
        return okAsync({ baseUrl, token: "proof-token", incarnation: "0", cwd: root });
      },
    },
  };
  const models = vi.spyOn(durableModels, "createDurableModels").mockImplementation(() => {
    readyReads++;
    return okAsync(createModels() as never);
  });
  const open = createProcessAgentContext(deps, {
    resources,
    mcp: { read: () => okAsync({ servers: [] }) },
  } as never);
  const context = { signal: new AbortController().signal };
  let lease = (await database.agentPersistence.open(task, orb, context))._unsafeUnwrap();
  const openContext = async () => {
    const result = (await open(task, orb, context, false, lease))._unsafeUnwrap();
    return result;
  };
  return {
    db,
    database,
    task,
    project,
    snapshot,
    root,
    resources,
    acquired,
    releaseGit,
    models,
    openContext,
    fetches: () => fetches,
    bindings: () => bindings,
    modelSetups: () => readyReads,
    lease: () => lease,
    setHostInstructions: (text: string) => {
      hostInstructions = text;
    },
    state: async (state: "running" | "stopped" | "starting", newAdmission = false) => {
      (
        await db.query(
          "UPDATE orbs SET state=$2, stop_reason=$3, agent_admission_version=agent_admission_version+$4 WHERE id=$1",
          [orb.id, state, state === "stopped" ? "manual" : null, newAdmission ? 1 : 0],
        )
      )._unsafeUnwrap();
      orb = required((await database.store.getOrb(task, orb.id))._unsafeUnwrap());
    },
    reopenLease: async () => {
      lease = (await database.agentPersistence.open(task, orb, context))._unsafeUnwrap();
    },
    close: async () => {
      models.mockRestore();
      await lease.release();
      await server.close();
      await database.agentPersistence.close();
      await database.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

type Bundle = Awaited<ReturnType<Awaited<ReturnType<typeof fixture>>["openContext"]>>;
async function invoke(bundle: Bundle, name: string, args: Record<string, unknown>) {
  const tool = required(
    bundle.registry
      .snapshot()
      .tools()
      .find(({ tool }) => tool.name === name),
  ).tool;
  const abort = new AbortController();
  const api = {
    env: required(bundle.envFor)({ conversationId: "root" } as never),
    taskId: 1,
    callId: "proof-call",
    diagnostic: () => {},
    details: async (value: { executionWait?: boolean }) => {
      if (value.executionWait) abort.abort();
    },
  } as unknown as ToolExecutionApi;
  return tool.execute(args, api, { ...BACKGROUND_CONTEXT, abortSignal: abort.signal });
}

it("requires the PG Git pin before model setup, refreshes managed prompts on new admission without refetch or boot", async () => {
  const f = await fixture();
  let first: Bundle | undefined, second: Bundle | undefined;
  try {
    const opening = f.openContext();
    await f.acquired.promise;
    expect(f.modelSetups()).toBe(0);
    expect(f.bindings()).toBe(0);
    expect((await new PgResourceSnapshots(f.db).get(f.snapshot.orbId))._unsafeUnwrap()).toBeNull();
    f.releaseGit.resolve();
    first = await opening;
    expect(first.instructions).toContain("immutable Git instructions");
    expect(first.instructions).toContain("personal-v1");
    expect(first.checkoutCommit).toBe(f.snapshot.commitSha);
    expect(
      (await new PgResourceSnapshots(f.db).get(f.snapshot.orbId))._unsafeUnwrap()?.commitSha,
    ).toBe(f.snapshot.commitSha);
    expect((await invoke(first, "read", { path: skillPath })).content).toEqual([
      { type: "text", text: skill },
    ]);
    const artifact = (
      await required(f.lease().artifacts).write(Buffer.from("private persisted artifact"))
    )._unsafeUnwrap();
    await first.closeResources?.();
    first = undefined;
    await f.state("stopped", true);
    expect((await f.lease().check()).isErr()).toBe(true);
    (await f.lease().release())._unsafeUnwrap();
    (
      await f.database.personalInstructions.replace(f.task, f.project.ownerUserId, "personal-v2")
    )._unsafeUnwrap();
    (
      await f.database.projectInstructions.replace(f.task, f.project.id, "project-v2")
    )._unsafeUnwrap();
    await f.state("starting");
    await f.reopenLease();
    second = await f.openContext();
    expect(second.instructions).toContain("personal-v2");
    expect(second.instructions).toContain("project-v2");
    expect(second.instructions).not.toContain("personal-v1");
    expect(second.instructions).toContain("immutable Git instructions");
    expect(f.fetches()).toBe(1);
    expect(f.bindings()).toBe(0);
    const managed = (
      await new NativeResourceContext(f.lease().storage, () => okAsync(undefined)).managed()
    )._unsafeUnwrap();
    expect(managed?.personal.content).toBe("personal-v2");
    expect(managed?.project.content).toBe("project-v2");
    const edges = (
      await f.db.query(
        "SELECT phase,commit_sha,error_code FROM orb_resource_events WHERE orb_id=$1 ORDER BY id",
        [f.snapshot.orbId],
      )
    )._unsafeUnwrap().rows;
    expect(edges.map((edge) => edge.phase)).toEqual(["acquiring", "ready"]);
    expect(edges[1]?.commit_sha).toBe(f.snapshot.commitSha);
    expect(edges.every((edge) => edge.error_code === null)).toBe(true);
    expect((await invoke(second, "read", { path: artifact })).content).toEqual([
      { type: "text", text: "private persisted artifact" },
    ]);
    const identity = await invoke(second, "read", {
      path: "/opt/pi-orb/skills/cloud-identity/SKILL.md",
    });
    expect(identity.isError).not.toBe(true);
    expect(JSON.stringify(identity.content)).toContain("boot-hooks");
    expect(
      (await invoke(second, "read", { path: "/opt/pi-orb/skills/boot-hooks/SKILL.md" })).isError,
    ).not.toBe(true);
    expect(
      (await invoke(second, "read", { path: "./.agents/skills/proof/reference.md" })).content,
    ).toEqual([{ type: "text", text: "offline reference" }]);
  } finally {
    f.releaseGit.resolve();
    await first?.closeResources?.();
    await second?.closeResources?.();
    await f.close();
  }
});

it("re-evaluates hook instruction offers and routes ready read/write/edit/read through real execution HTTP, not PG", async () => {
  const f = await fixture();
  let bundle: Bundle | undefined;
  try {
    f.releaseGit.resolve();
    bundle = await f.openContext();
    bundle.prompt?.("root");
    const oldEnv = required(required(bundle.envFor)({ conversationId: "root" } as never));
    (await required(bundle.hydrateExecution)(BACKGROUND_CONTEXT))._unsafeUnwrap();
    await f.state("running");
    const stale = await oldEnv.writeFile(skillPath, "must not write", BACKGROUND_CONTEXT);
    expect(await readFile(join(f.root, skillPath), "utf8")).toBe(skill);
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.error.message).toContain("re-evaluate");
    await oldEnv.cleanup(BACKGROUND_CONTEXT);
    expect(bundle.prompt?.("root")).toContain("hook-modified instructions");
    f.setHostInstructions("hook instructions revised again");
    (await required(bundle.hydrateExecution)(BACKGROUND_CONTEXT))._unsafeUnwrap();
    expect(bundle.prompt?.("root")).toContain("hook instructions revised again");
    expect(bundle.prompt?.("root")).not.toContain("immutable Git instructions");
    await f.state("running");
    const beforeBundledRead = f.bindings();
    const bundledAlias = await invoke(bundle, "read", {
      path: "/opt/pi-orb/./skills/cloud-identity/../boot-hooks/SKILL.md",
    });
    expect(f.bindings()).toBe(beforeBundledRead);
    expect(bundledAlias.isError).not.toBe(true);
    expect(JSON.stringify(bundledAlias.content)).toContain("setup");
    const escaped = await invoke(bundle, "read", {
      path: "/opt/pi-orb/skills/../../../../etc/passwd",
    });
    expect(escaped.isError).toBe(true);
    expect(JSON.stringify(escaped.content)).toContain("Snapshot resource not found");
    expect((await invoke(bundle, "read", { path: skillPath })).content).toEqual([
      { type: "text", text: skill },
    ]);
    expect(
      (await invoke(bundle, "write", { path: skillPath, content: "live one" })).isError,
    ).not.toBe(true);
    expect((await invoke(bundle, "read", { path: skillPath })).content).toEqual([
      { type: "text", text: "live one" },
    ]);
    expect(
      (await invoke(bundle, "edit", { path: skillPath, oldText: "live one", newText: "live two" }))
        .isError,
    ).not.toBe(true);
    expect((await invoke(bundle, "read", { path: skillPath })).content).toEqual([
      { type: "text", text: "live two" },
    ]);
    expect(await readFile(join(f.root, skillPath), "utf8")).toBe("live two");
    const persisted = required(
      (await new PgResourceSnapshots(f.db).get(f.snapshot.orbId))._unsafeUnwrap(),
    );
    expect(
      Buffer.from(
        required(persisted.files.find((file) => file.path === skillPath)).bytes,
      ).toString(),
    ).toBe(skill);
    await bundle.closeResources?.();
    bundle = undefined;
    await f.state("stopped", true);
    (await f.lease().release())._unsafeUnwrap();
    await f.state("starting");
    await f.reopenLease();
    bundle = await f.openContext();
    // A new off-host context uses the immutable baseline, not the last host offer.
    expect(bundle.prompt?.("root")).toContain("immutable Git instructions");
    expect(bundle.prompt?.("root")).not.toContain("hook instructions revised again");
    const priorBindings = f.bindings();
    expect((await invoke(bundle, "read", { path: skillPath })).content).toEqual([
      { type: "text", text: skill },
    ]);
    expect(f.bindings()).toBe(priorBindings);
    expect(f.fetches()).toBe(1);
  } finally {
    f.releaseGit.resolve();
    await bundle?.closeResources?.();
    await f.close();
  }
});
