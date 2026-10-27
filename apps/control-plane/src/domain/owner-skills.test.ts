import { OWNER_SKILL_BUNDLE_MAX_BYTES, OWNER_SKILLS_MAX_BYTES } from "@pi-orb/protocol";
import { NoSimulationTask } from "determined";
import { errAsync, okAsync } from "neverthrow";
import { expect, it } from "vitest";
import { FakeOwnerSkillStore } from "../testkit/owner-skills.ts";
import {
  applyOwnerSkillCommand,
  importOwnerSkill,
  type OwnerSkillBundle,
  type OwnerSkillSource,
  ownerSkillError,
  previewOwnerSkill,
  readOwnerSkillsSnapshot,
  validateOwnerSkillBundle,
  writeOwnerSkill,
} from "./owner-skills.ts";

const task = new NoSimulationTask("owner skill imports", false);
const url = "https://github.com/acme/skills/tree/main/example";
const sha = "a".repeat(40);
const content = (name = "example") => `---\nname: ${name}\ndescription: Example\n---\nRun it.\n`;
const bundle = (): OwnerSkillBundle => ({
  content: content(),
  files: [{ path: "scripts/run.sh", base64: "AP8=", executable: true }],
  source: { url, commitSha: sha },
});
function setup(source: OwnerSkillSource = { acquire: () => okAsync(bundle()) }) {
  return { store: new FakeOwnerSkillStore(), source, platformSkillNames: new Set(["codemode"]) };
}

it("previews without mutation and imports the exact preview SHA, not a moving ref", async () => {
  const requested: Array<{ url: string; commitSha?: string }> = [];
  const deps = setup({
    acquire: (_task, request) => {
      requested.push(request);
      return okAsync({ ...bundle(), source: { url, commitSha: request.commitSha ?? sha } });
    },
  });
  const preview = (await previewOwnerSkill(task, deps, { url }))._unsafeUnwrap();
  expect(preview).toMatchObject({ name: "example", source: { url, commitSha: sha }, fileCount: 2 });
  expect(preview.manifest).toEqual([
    { path: "SKILL.md", bytes: Buffer.byteLength(content()), executable: false },
    { path: "scripts/run.sh", bytes: 2, executable: true },
  ]);
  expect(JSON.stringify(preview)).not.toContain("base64");
  expect((await deps.store.list(task, "owner"))._unsafeUnwrap()).toEqual([]);
  const imported = (
    await importOwnerSkill(task, deps, "owner", { url, commitSha: sha })
  )._unsafeUnwrap();
  expect(requested).toEqual([{ url }, { url, commitSha: sha }]);
  expect(imported.items[0]).toMatchObject({ source: { url, commitSha: sha }, fileCount: 2 });
  expect(JSON.stringify(imported)).not.toContain("base64");
  const snapshot = (await readOwnerSkillsSnapshot(task, deps.store, "owner"))._unsafeUnwrap();
  expect(snapshot.skills).toEqual([{ name: "example", ...bundle() }]);
  expect(
    (await importOwnerSkill(task, deps, "owner", { url, commitSha: sha }))._unsafeUnwrapErr().code,
  ).toBe("conflict");
});

it("manual edit/rename preserves support bytes, permissions and import provenance", async () => {
  const deps = setup();
  (await importOwnerSkill(task, deps, "owner", { url, commitSha: sha }))._unsafeUnwrap();
  (
    await writeOwnerSkill(task, deps, "owner", "example", { content: content("renamed") })
  )._unsafeUnwrap();
  expect((await readOwnerSkillsSnapshot(task, deps.store, "owner"))._unsafeUnwrap().skills).toEqual(
    [{ name: "renamed", ...bundle(), content: content("renamed") }],
  );
});

it("rejects unpinned adds, mismatched source pins and acquisition failures without mutation", async () => {
  const deps = setup();
  for (const body of [{ url }, { url, commitSha: "main" }, { url, commitSha: sha, files: [] }])
    expect((await importOwnerSkill(task, deps, "owner", body))._unsafeUnwrapErr().code).toBe(
      "invalid",
    );
  const mismatch = setup({
    acquire: () => okAsync({ ...bundle(), source: { url, commitSha: "b".repeat(40) } }),
  });
  expect((await importOwnerSkill(task, mismatch, "owner", { url, commitSha: sha })).isErr()).toBe(
    true,
  );
  const failure = setup({
    acquire: () => errAsync(ownerSkillError("unavailable", "GitHub unavailable")),
  });
  expect(
    (await importOwnerSkill(task, failure, "owner", { url, commitSha: sha }))._unsafeUnwrapErr()
      .code,
  ).toBe("unavailable");
  for (const d of [deps, mismatch, failure]) expect(d.store.commits.size).toBe(0);
});

it("validates complete bounded bundles, canonical base64 and non-conflicting relative paths", () => {
  expect(validateOwnerSkillBundle(bundle()).isOk()).toBe(true);
  for (const path of [
    "SKILL.md",
    "../outside",
    "/root",
    "a//b",
    "a/./b",
    "a/../b",
    "a\\b",
    "a\u0000b",
    "a\nb",
    "é".repeat(513),
  ]) {
    expect(
      validateOwnerSkillBundle({ ...bundle(), files: [{ ...bundle().files[0]!, path }] }).isErr(),
      path,
    ).toBe(true);
  }
  for (const base64 of ["!", "Zg", "Zh==", "Zg==\n"])
    expect(
      validateOwnerSkillBundle({
        ...bundle(),
        files: [{ path: "x", base64, executable: false }],
      }).isErr(),
    ).toBe(true);
  for (const paths of [["a", "a"], ["a", "a/b"], ["SKILL.md/child"]])
    expect(
      validateOwnerSkillBundle({
        ...bundle(),
        files: paths.map((path) => ({ path, base64: "", executable: false })),
      }).isErr(),
    ).toBe(true);
  expect(
    validateOwnerSkillBundle({
      ...bundle(),
      files: Array.from({ length: 5000 }, (_, i) => ({
        path: `f-${i}`,
        base64: "",
        executable: false,
      })),
    }).isErr(),
  ).toBe(true);
  expect(
    validateOwnerSkillBundle({
      ...bundle(),
      files: [
        {
          path: "large",
          base64: Buffer.alloc(OWNER_SKILL_BUNDLE_MAX_BYTES).toString("base64"),
          executable: false,
        },
      ],
    }).isErr(),
  ).toBe(true);
});

it("enforces decoded owner capacity on the resulting state and leaves deletes possible", () => {
  const files = [
    {
      path: "large",
      base64: Buffer.alloc(OWNER_SKILLS_MAX_BYTES / 2 - 100).toString("base64"),
      executable: false,
    },
  ];
  const record = (name: string) => ({
    name,
    content: content(name),
    files,
    source: null,
    updatedAt: "now",
  });
  const current = [record("first"), record("second")];
  const result = applyOwnerSkillCommand(
    current,
    {
      kind: "create",
      skill: {
        ...record("third"),
        files: [{ path: "x", base64: Buffer.alloc(1024).toString("base64"), executable: false }],
      },
    },
    "now",
  );
  expect(result._unsafeUnwrapErr().code).toBe("conflict");
  expect(applyOwnerSkillCommand(current, { kind: "delete", name: "first" }, "now").isOk()).toBe(
    true,
  );
});

it("rejects manual root growth beyond the preserved bundle limit without mutation", async () => {
  const deps = setup();
  const original = content();
  const files = [
    {
      path: "data.bin",
      base64: Buffer.alloc(OWNER_SKILL_BUNDLE_MAX_BYTES - Buffer.byteLength(original)).toString(
        "base64",
      ),
      executable: false,
    },
  ];
  deps.store.seed("owner", [
    { name: "example", content: original, files, source: { url, commitSha: sha } },
  ]);
  const edit = await writeOwnerSkill(task, deps, "owner", "example", {
    content: `${original}extra`,
  });
  expect(edit._unsafeUnwrapErr().code).toBe("invalid");
  expect(deps.store.commits.get("owner")).toHaveLength(1);
  expect(
    (await readOwnerSkillsSnapshot(task, deps.store, "owner"))._unsafeUnwrap().skills[0]?.content,
  ).toBe(original);
});

it("enforces the serialized JSON owner cap even when decoded bytes are small", () => {
  const files = Array.from({ length: 4999 }, (_, i) => ({
    path: `${'"'.repeat(1020)}${String(i).padStart(4, "0")}`,
    base64: "",
    executable: false,
  }));
  const record = (name: string) => ({
    name,
    content: content(name),
    files,
    source: null,
    updatedAt: "now",
  });
  expect(
    applyOwnerSkillCommand(
      [record("first")],
      { kind: "create", skill: record("second") },
      "now",
    ).isOk(),
  ).toBe(true);
  const result = applyOwnerSkillCommand(
    [record("first"), record("second")],
    { kind: "create", skill: record("third") },
    "now",
  );
  expect(result._unsafeUnwrapErr()).toMatchObject({
    code: "conflict",
    message: expect.stringContaining("24 MiB"),
  });
});

it("forwards cancellation and never commits a source result after cancellation", async () => {
  const controller = new AbortController();
  const deps = setup({
    acquire: (_task, _request, signal) => {
      expect(signal).toBe(controller.signal);
      controller.abort();
      return okAsync(bundle());
    },
  });
  const result = await importOwnerSkill(
    task,
    deps,
    "owner",
    { url, commitSha: sha },
    controller.signal,
  );
  expect(result._unsafeUnwrapErr().code).toBe("unavailable");
  expect(deps.store.commits.size).toBe(0);
});
