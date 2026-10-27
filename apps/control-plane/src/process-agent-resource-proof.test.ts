import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import type { ToolDiagnostic, ToolExecutionApi } from "@earendil-works/pi-durable";
import { NoSimulationTask } from "determined";
import { okAsync, ResultAsync } from "neverthrow";
import { assert, expect, it, vi } from "vitest";
import { buildExecutionServer } from "../../orb-runtime/src/execution/server.ts";
import { composeControlPlaneDatabase } from "./adapters/database.ts";
import { NativeResourceContext } from "./adapters/durable/context-storage.ts";
import * as durableModels from "./adapters/durable/models.ts";
import { ownerSkillBundle } from "./adapters/durable/owner-skill-bundle.ts";
import { PGliteClient } from "./adapters/pg/pglite-client.ts";
import { PgResourceSnapshots } from "./adapters/pg/resource-snapshots.ts";
import type { ResourceSnapshot } from "./domain/resources.ts";
import { createProcessAgentContext } from "./process-agent-composition.ts";
import { makeHarness, makeOrbRow, makeProjectRow } from "./testkit/fixtures.ts";

const skillPath = ".agents/skills/proof/SKILL.md";
const skill = "---\nname: proof\ndescription: composition proof\n---\nPG skill baseline";
/** Renamed to "proof", the owner's skill replaces the same-named repository skill. */
const supportFiles = [
  { path: "assets/a.png", base64: "iVBORw0KGgoA/w==", executable: false },
  {
    path: "scripts/run.sh",
    base64: Buffer.from("#!/bin/sh\nprintf IMPORTED_SCRIPT").toString("base64"),
    executable: true,
  },
];
const capturedSkill = (version: string, name = "owner-proof") => ({
  name,
  content: ownerSkill(version, name),
  files: supportFiles,
  source: null,
});
const capturedBundle = (version: string, name = "owner-proof") =>
  ownerSkillBundle([capturedSkill(version, name)])._unsafeUnwrap();
const ownerSkillPath = () => `${capturedBundle("v2", "proof").root}/proof/SKILL.md`;
const ownerSkill = (version: string, name = "owner-proof") =>
  `---\nname: ${name}\ndescription: owner proof ${version}\n---\nowner body ${version}`;
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
async function fixture(repositoryUrl: string | null = makeProjectRow("project").repositoryUrl) {
  const db = new PGliteClient();
  const database = composeControlPlaneDatabase(db);
  const task = new NoSimulationTask("resource composition proof", false);
  const project = { ...makeProjectRow(randomUUID()), repositoryUrl };
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
  (
    await database.ownerSkills.apply(task, project.ownerUserId, {
      kind: "create",
      skill: capturedSkill("v1"),
    })
  )._unsafeUnwrap();
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
  const workspace = await mkdtemp(join(tmpdir(), "resource-composition-proof-"));
  const root = join(workspace, "repo");
  await mkdir(join(root, ".agents/skills/proof"), { recursive: true });
  await writeFile(join(root, skillPath), skill);
  await writeFile(join(root, "AGENTS.md"), "hook-modified instructions");
  let incarnation = "0";
  const replacementRoots: string[] = [];
  let server = buildExecutionServer({
    token: "proof-token",
    incarnation: "0",
    cwd: root,
    ready: () => ({
      cwd: root,
      incarnation: "0",
      pid: process.pid,
      checkoutCommit: snapshot.commitSha,
    }),
  });
  let baseUrl = await server.listen({ host: "127.0.0.1", port: 0 });
  let readyReads = 0;
  const h = makeHarness();
  const deps = {
    ...h.deps,
    store: database.store,
    personalInstructions: database.personalInstructions,
    ownerSkills: { ...h.deps.ownerSkills, store: database.ownerSkills },
    projectInstructions: database.projectInstructions,
    hostProvider: {
      ...h.deps.hostProvider,
      executionBinding: () => {
        bindings++;
        return okAsync({ baseUrl, token: "proof-token", incarnation, cwd: root });
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
    acquireResources: () => resources.acquire(task, orb, context),
    fetches: () => fetches,
    bindings: () => bindings,
    modelSetups: () => readyReads,
    lease: () => lease,
    state: async (
      state: "running" | "stopped" | "starting",
      newAdmission = false,
      stopReason: "manual" | "sleep" = "manual",
    ) => {
      (
        await db.query(
          "UPDATE orbs SET state=$2, stop_reason=$3, agent_admission_version=agent_admission_version+$4 WHERE id=$1",
          [orb.id, state, state === "stopped" ? stopReason : null, newAdmission ? 1 : 0],
        )
      )._unsafeUnwrap();
      orb = required((await database.store.getOrb(task, orb.id))._unsafeUnwrap());
    },
    reopenLease: async () => {
      lease = (await database.agentPersistence.open(task, orb, context))._unsafeUnwrap();
    },
    replaceHost: async () => {
      await server.close();
      const replacementWorkspace = await mkdtemp(join(tmpdir(), "resource-proof-replacement-"));
      replacementRoots.push(replacementWorkspace);
      const replacementRoot = join(replacementWorkspace, "repo");
      await mkdir(replacementRoot);
      incarnation = "1";
      server = buildExecutionServer({
        token: "proof-token",
        incarnation,
        cwd: replacementRoot,
        ready: () => ({
          cwd: replacementRoot,
          incarnation,
          pid: process.pid,
          checkoutCommit: snapshot.commitSha,
        }),
      });
      baseUrl = await server.listen({ host: "127.0.0.1", port: 0 });
      (await db.query("UPDATE orbs SET host_incarnation=1 WHERE id=$1", [orb.id]))._unsafeUnwrap();
      orb = required((await database.store.getOrb(task, orb.id))._unsafeUnwrap());
      return replacementRoot;
    },
    close: async () => {
      models.mockRestore();
      await lease.release();
      await server.close();
      await database.agentPersistence.close();
      await database.close();
      await rm(workspace, { recursive: true, force: true });
      for (const replacement of replacementRoots)
        await rm(replacement, { recursive: true, force: true });
    },
  };
}

type Bundle = Awaited<ReturnType<Awaited<ReturnType<typeof fixture>>["openContext"]>>;
async function invoke(
  bundle: Bundle,
  name: string,
  args: Record<string, unknown>,
  waiting?: () => Promise<void>,
) {
  const tool = required(
    bundle.registry
      .snapshot()
      .tools()
      .find(({ tool }) => tool.name === name),
  ).tool;
  const abort = new AbortController();
  const diagnostics: ToolDiagnostic[] = [];
  const api = {
    now: () => 0,
    agent: async () => ({}),
    env: required(bundle.envFor)({ conversationId: "root" } as never),
    taskId: 1,
    callId: "proof-call",
    diagnostic: (value: ToolDiagnostic) => diagnostics.push(value),
    output: () => {},
    details: async (value: { executionWait?: boolean }) => {
      if (value.executionWait) {
        if (waiting) await waiting();
        else abort.abort();
      }
    },
  } as unknown as ToolExecutionApi;
  const result = await tool.execute(args, api, withAbortSignal(abort.signal, BACKGROUND_CONTEXT));
  return { ...result, diagnostics: [...diagnostics, ...(result.diagnostics ?? [])] };
}

it("prepares the first model context for a name-only project without Git or compute readiness", async () => {
  const f = await fixture(null);
  let bundle: Bundle | undefined;
  try {
    bundle = await f.openContext();
    expect(bundle.instructions).toContain("personal-v1");
    expect(bundle.instructions).toContain("project-v1");
    expect(bundle.instructions).toContain("codemode");
    expect(bundle.instructions).not.toContain("immutable Git instructions");
    expect(bundle.checkoutCommit).toBeNull();
    expect(f.modelSetups()).toBe(1);
    expect(f.bindings()).toBe(0);
    expect(f.fetches()).toBe(0);
    expect((await new PgResourceSnapshots(f.db).get(f.snapshot.orbId))._unsafeUnwrap()).toBeNull();
    const native = new NativeResourceContext(f.lease().storage, () => okAsync(undefined));
    expect((await native.platform())._unsafeUnwrap()?.files.length).toBeGreaterThan(0);
  } finally {
    await bundle?.closeResources?.();
    await f.close();
  }
});

it.each(["manual", "sleep"] as const)(
  "requires the PG Git pin before model setup, refreshes managed prompts after %s inhibition without refetch or boot",
  async (stopReason) => {
    const f = await fixture();
    let first: Bundle | undefined, second: Bundle | undefined;
    try {
      const admission = async () =>
        Number(
          required(
            (
              await f.db.query("SELECT agent_admission_version FROM orbs WHERE id=$1", [
                f.snapshot.orbId,
              ])
            )._unsafeUnwrap().rows[0],
          ).agent_admission_version,
        );
      const persistedResources = async () =>
        Promise.all(
          [
            "SELECT commit_sha,manifest FROM orb_resource_snapshots WHERE orb_id=$1",
            "SELECT path,bytes,sha256 FROM orb_resource_files WHERE orb_id=$1 ORDER BY path",
          ].map(async (sql) => (await f.db.query(sql, [f.snapshot.orbId]))._unsafeUnwrap().rows),
        );
      const initialAdmission = await admission();
      const opening = f.openContext();
      await f.acquired.promise;
      expect(f.modelSetups()).toBe(0);
      expect(f.bindings()).toBe(0);
      expect(
        (await new PgResourceSnapshots(f.db).get(f.snapshot.orbId))._unsafeUnwrap(),
      ).toBeNull();
      f.releaseGit.resolve();
      first = await opening;
      expect(first.instructions).toContain("immutable Git instructions");
      expect(first.instructions).toContain("personal-v1");
      expect(first.instructions).toContain("owner proof v1");
      expect(first.checkoutCommit).toBe(f.snapshot.commitSha);
      expect(
        (await new PgResourceSnapshots(f.db).get(f.snapshot.orbId))._unsafeUnwrap()?.commitSha,
      ).toBe(f.snapshot.commitSha);
      expect((await invoke(first, "read", { path: skillPath })).output).toEqual([
        { type: "text", text: skill },
      ]);
      const initialResources = await persistedResources();
      expect(initialResources[0]).toEqual([
        {
          commit_sha: f.snapshot.commitSha,
          manifest: {
            instructionPath: f.snapshot.instructionPath,
            skillRoot: f.snapshot.skillRoot,
            warnings: [],
            files: f.snapshot.files.map(({ path, sha256, bytes }) => ({
              path,
              sha256,
              byteCount: bytes.byteLength,
            })),
          },
        },
      ]);
      (await f.acquireResources())._unsafeUnwrap();
      const artifact = (
        await required(f.lease().artifacts).write(Buffer.from("private persisted artifact"))
      )._unsafeUnwrap();
      await first.closeResources?.();
      first = undefined;
      await f.state("stopped", true, stopReason);
      expect((await f.lease().check()).isErr()).toBe(true);
      (await f.lease().release())._unsafeUnwrap();
      (
        await f.database.personalInstructions.replace(f.task, f.project.ownerUserId, "personal-v2")
      )._unsafeUnwrap();
      (
        await f.database.projectInstructions.replace(f.task, f.project.id, "project-v2")
      )._unsafeUnwrap();
      (
        await f.database.ownerSkills.apply(f.task, f.project.ownerUserId, {
          kind: "replace",
          name: "owner-proof",
          skill: capturedSkill("v2", "proof"),
        })
      )._unsafeUnwrap();
      await f.state("starting");
      await f.reopenLease();
      const nextAdmission = await admission();
      expect(nextAdmission).toBe(initialAdmission + 1);
      second = await f.openContext();
      (await f.acquireResources())._unsafeUnwrap();
      expect(await persistedResources()).toEqual(initialResources);
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
      expect(managed?.skills).toEqual([capturedSkill("v2", "proof")]);
      expect(second.instructions).toContain(ownerSkillPath());
      expect(second.instructions).toContain("owner proof v2");
      expect(second.instructions).not.toContain("composition proof");
      expect((await invoke(second, "read", { path: ownerSkillPath() })).output).toEqual([
        { type: "text", text: ownerSkill("v2", "proof") },
      ]);
      const edges = (
        await f.db.query(
          "SELECT admission_version,phase,commit_sha,error_code FROM orb_resource_events WHERE orb_id=$1 ORDER BY id",
          [f.snapshot.orbId],
        )
      )._unsafeUnwrap().rows;
      // Cached snapshot healing emits one ready edge per admission, not another acquisition.
      expect(
        edges.map((edge) => ({ ...edge, admission_version: Number(edge.admission_version) })),
      ).toEqual([
        {
          admission_version: initialAdmission,
          phase: "acquiring",
          commit_sha: null,
          error_code: null,
        },
        ...[initialAdmission, nextAdmission].map((admission_version) => ({
          admission_version,
          phase: "ready",
          commit_sha: f.snapshot.commitSha,
          error_code: null,
        })),
      ]);
      expect((await invoke(second, "read", { path: artifact })).output).toEqual([
        { type: "text", text: "private persisted artifact" },
      ]);
      const identity = await invoke(second, "read", {
        path: "/opt/pi-orb/skills/cloud-identity/SKILL.md",
      });
      expect(identity.isError).not.toBe(true);
      expect(JSON.stringify(identity.output)).toContain("boot-hooks");
      expect(
        (await invoke(second, "read", { path: "/opt/pi-orb/skills/boot-hooks/SKILL.md" })).isError,
      ).not.toBe(true);
      expect(
        (await invoke(second, "read", { path: "./.agents/skills/proof/reference.md" })).output,
      ).toEqual([{ type: "text", text: "offline reference" }]);
    } finally {
      f.releaseGit.resolve();
      await first?.closeResources?.();
      await second?.closeResources?.();
      await f.close();
    }
  },
);

it("executes the first boot-time command under pinned instructions and routes live read/write/edit/read through HTTP", async () => {
  const f = await fixture();
  let bundle: Bundle | undefined;
  try {
    f.releaseGit.resolve();
    bundle = await f.openContext();
    const instructions = bundle.instructions;
    expect(instructions).toContain("immutable Git instructions");
    expect(instructions).toContain("composition proof");
    expect(instructions).not.toMatch(/pending|re-evaluat|hook-modified/i);
    let waits = 0;
    const first = await invoke(
      bundle,
      "bash",
      { command: "printf FIRST_COMMAND; pwd" },
      async () => {
        waits++;
        expect(f.bindings()).toBe(0);
        await f.state("running");
      },
    );
    expect(first.isError, JSON.stringify(first)).not.toBe(true);
    expect(JSON.stringify(first.output)).toContain("FIRST_COMMAND");
    expect(JSON.stringify(first.output)).toContain(f.root);
    expect(waits).toBe(1);
    expect(bundle.instructions).toBe(instructions);
    await writeFile(join(f.root, "AGENTS.md"), "host instructions revised again");
    (await required(bundle.checkExecutionReady)(BACKGROUND_CONTEXT))._unsafeUnwrap();
    expect(bundle.instructions).toBe(instructions);
    const beforeBundledRead = f.bindings();
    const bundledAlias = await invoke(bundle, "read", {
      path: "/opt/pi-orb/./skills/cloud-identity/../boot-hooks/SKILL.md",
    });
    expect(f.bindings()).toBe(beforeBundledRead);
    expect(bundledAlias.isError).not.toBe(true);
    expect(JSON.stringify(bundledAlias.output)).toContain("setup");
    const escaped = await invoke(bundle, "read", {
      path: "/opt/pi-orb/skills/../../../../etc/passwd",
    });
    expect(escaped.isError).toBe(true);
    expect(JSON.stringify(escaped.output)).toContain("Snapshot resource not found");
    expect((await invoke(bundle, "read", { path: skillPath })).output).toEqual([
      { type: "text", text: skill },
    ]);
    expect(
      (await invoke(bundle, "write", { path: skillPath, content: "live one" })).isError,
    ).not.toBe(true);
    expect((await invoke(bundle, "read", { path: skillPath })).output).toEqual([
      { type: "text", text: "live one" },
    ]);
    const edited = await invoke(bundle, "edit", {
      path: skillPath,
      edits: [{ oldText: "live one", newText: "live two" }],
    });
    expect(edited.isError, JSON.stringify(edited)).not.toBe(true);
    expect((await invoke(bundle, "read", { path: skillPath })).output).toEqual([
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
    expect(bundle.instructions).toBe(instructions);
    const priorBindings = f.bindings();
    expect((await invoke(bundle, "read", { path: skillPath })).output).toEqual([
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

it("delivers adopted full bundles through the composed harness before guest tools and on replacement", async () => {
  const f = await fixture(null);
  let bundle: Bundle | undefined;
  try {
    bundle = await f.openContext();
    const adopted = capturedBundle("v1");
    expect(adopted.root).toBe(`../.pi-orb/owner-skills/${adopted.hash}`);
    expect(bundle.instructions).toContain(`${adopted.root}/owner-proof/SKILL.md`);
    expect(
      (await invoke(bundle, "read", { path: `${adopted.root}/owner-proof/SKILL.md` })).output,
    ).toEqual([{ type: "text", text: ownerSkill("v1") }]);
    const image = `${adopted.root}/owner-proof/assets/a.png`;
    const script = `${adopted.root}/owner-proof/scripts/run.sh`;
    expect((await invoke(bundle, "read", { path: image })).output).toEqual([
      { type: "image", mimeType: "image/png", data: supportFiles[0]!.base64 },
    ]);
    expect(f.bindings()).toBe(0);
    (
      await f.database.ownerSkills.apply(f.task, f.project.ownerUserId, {
        kind: "replace",
        name: "owner-proof",
        skill: capturedSkill("latest"),
      })
    )._unsafeUnwrap();
    await f.state("running");
    const command = `${script} && cp ${image} copied.png && test -x ${script} && test ! -x ${image} && cat ${adopted.root}/owner-proof/SKILL.md`;
    const first = await invoke(bundle, "bash", { command });
    expect(first.isError, JSON.stringify(first)).not.toBe(true);
    expect(JSON.stringify(first.output)).toContain("IMPORTED_SCRIPT");
    expect(JSON.stringify(first.output)).toContain("owner body v1");
    expect(JSON.stringify(first.output)).not.toContain("latest");
    expect((await readFile(join(f.root, "copied.png"))).toString("base64")).toBe(
      supportFiles[0]!.base64,
    );
    expect((await invoke(bundle, "read", { path: join(f.root, image) })).output).toEqual([
      { type: "image", mimeType: "image/png", data: supportFiles[0]!.base64 },
    ]);
    await writeFile(join(f.root, image), "mutable corruption");
    expect(
      (await invoke(bundle, "read", { path: `${f.root}/../${f.root.split("/").at(-1)}/${image}` }))
        .output,
    ).toEqual([{ type: "image", mimeType: "image/png", data: supportFiles[0]!.base64 }]);
    const replacement = await f.replaceHost();
    (await required(bundle.checkExecutionReady)(BACKGROUND_CONTEXT))._unsafeUnwrap();
    expect(
      (await readFile(join(replacement, adopted.root, "owner-proof/SKILL.md"))).toString(),
    ).toBe(ownerSkill("v1"));
    const replaced = await invoke(bundle, "bash", { command });
    expect(replaced.isError, JSON.stringify(replaced)).not.toBe(true);
    expect(JSON.stringify(replaced.output)).toContain("IMPORTED_SCRIPT");
    expect(JSON.stringify(replaced.output)).toContain("owner body v1");
    expect(JSON.stringify(replaced.output)).not.toContain("latest");
    expect((await readFile(join(replacement, "copied.png"))).toString("base64")).toBe(
      supportFiles[0]!.base64,
    );
    await writeFile(join(replacement, image), "replacement corruption");
    expect((await invoke(bundle, "read", { path: join(replacement, image) })).output).toEqual([
      { type: "image", mimeType: "image/png", data: supportFiles[0]!.base64 },
    ]);
    expect((await invoke(bundle, "read", { path: image })).output).toEqual([
      { type: "image", mimeType: "image/png", data: supportFiles[0]!.base64 },
    ]);
  } finally {
    await bundle?.closeResources?.();
    await f.close();
  }
});

it("blocks composed guest tools when supporting bundles cannot be installed", async () => {
  const f = await fixture(null);
  let bundle: Bundle | undefined;
  try {
    bundle = await f.openContext();
    await symlink(f.root, join(f.root, "../.pi-orb"));
    await f.state("running");
    const blocked = await required(bundle.checkExecutionReady)(BACKGROUND_CONTEXT);
    expect(blocked.isErr() && blocked.error.message).toContain("Cannot install owner skills");
    const alerts: string[] = [];
    bundle.activateResources?.((_id, message) => {
      alerts.push(message);
      return okAsync({ recordId: "alert", duplicate: false });
    });
    const result = await invoke(bundle, "bash", { command: "touch MUST_NOT_EXECUTE" });
    expect(result.isError).toBe(true);
    expect((await invoke(bundle, "bash", { command: "touch MUST_NOT_EXECUTE" })).isError).toBe(
      true,
    );
    expect(alerts).toEqual([`Cannot install owner skills at ${capturedBundle("v1").root}.`]);
    await rm(join(f.root, "../.pi-orb"));
    expect((await invoke(bundle, "bash", { command: "true" })).isError).not.toBe(true);
    await writeFile(join(f.root, capturedBundle("v1").root, "owner-proof/assets/a.png"), "corrupt");
    expect((await invoke(bundle, "bash", { command: "touch MUST_NOT_EXECUTE" })).isError).toBe(
      true,
    );
    expect(alerts).toHaveLength(2);
    expect(
      await readFile(join(f.root, "MUST_NOT_EXECUTE")).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
  } finally {
    await bundle?.closeResources?.();
    await f.close();
  }
});

it("revoked resource ownership cancels a staged installation before tool admission", async () => {
  const f = await fixture(null);
  let bundle: Bundle | undefined;
  const checkpoint = f.task.checkpoint.bind(f.task);
  try {
    bundle = await f.openContext();
    await f.state("running");
    const alerts: string[] = [];
    bundle.activateResources?.((_id, message) => {
      alerts.push(message);
      return okAsync({ recordId: "alert", duplicate: false });
    });
    vi.spyOn(f.task, "checkpoint").mockImplementation(async (...args) => {
      if (args[0] === "owner skills publication") await f.lease().release();
      else await checkpoint(...args);
    });
    expect((await invoke(bundle, "bash", { command: "touch MUST_NOT_EXECUTE" })).isError).toBe(
      true,
    );
    expect(
      await readFile(join(f.root, "MUST_NOT_EXECUTE")).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
    expect(
      await readFile(join(f.root, capturedBundle("v1").root, "owner-proof/SKILL.md")).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
    expect(alerts).toEqual([]);
  } finally {
    await bundle?.closeResources?.();
    await f.close();
  }
});
