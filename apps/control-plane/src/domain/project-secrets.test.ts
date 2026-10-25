import { NoSimulationTask } from "determined";
import { describe, expect, it } from "vitest";
import { makeProjectSecretsHarness } from "../testkit/project-secrets.ts";
import {
  deleteProjectSecret,
  getProjectSecretSnapshot,
  listProjectSecrets,
  PROJECT_SECRETS_PROVIDER,
  putProjectSecret,
} from "./project-secrets.ts";

const PROJECT = "00000000-0000-4000-8000-000000000041";
const task = new NoSimulationTask("project secret validation", false);

async function seed(values: Record<string, string>) {
  const h = makeProjectSecretsHarness(PROJECT);
  const version = h.secrets.seedSecret(PROJECT_SECRETS_PROVIDER, {
    projectId: PROJECT,
    revision: 1,
    values,
  });
  (
    await h.pointers.casWriteProjectSecretPointer(task, PROJECT, null, {
      revision: 1,
      entries: Object.fromEntries(Object.keys(values).map((name) => [name, 1])),
      secretVersion: version,
      updatedAt: 1,
    })
  )._unsafeUnwrap();
  return h;
}

describe("project secret validation", () => {
  it.each([
    ["__proto__", "private-value"],
    ["TOKEN", "private-prefix\0private-suffix"],
    ["BAD\0NAME", "private-value"],
  ])("rejects %s without publishing or changing revision", async (name, value) => {
    const h = await seed({ EXISTING: "unchanged" });
    const before = h.pointers.snapshot(PROJECT);
    const versions = h.secrets.liveVersions(PROJECT_SECRETS_PROVIDER);
    const rejected = await putProjectSecret(task, h.deps, PROJECT, name, value);
    expect(rejected._unsafeUnwrapErr()).toMatchObject({ type: "project_secret_invalid" });
    expect(JSON.stringify(rejected._unsafeUnwrapErr())).not.toContain("private-");
    expect(h.pointers.snapshot(PROJECT)).toEqual(before);
    expect(h.secrets.liveVersions(PROJECT_SECRETS_PROVIDER)).toEqual(versions);
    expect(h.secrets.destroyedVersions()).toEqual([]);
  });

  it("rejects reserved __proto__ deletion without publication", async () => {
    const h = makeProjectSecretsHarness(PROJECT);
    expect(
      (await deleteProjectSecret(task, h.deps, PROJECT, "__proto__"))._unsafeUnwrapErr(),
    ).toMatchObject({ type: "project_secret_invalid" });
    expect(h.pointers.snapshot(PROJECT)).toBeNull();
    expect(h.secrets.liveVersions(PROJECT_SECRETS_PROVIDER)).toEqual([]);
  });

  it.each(["constructor", "toString"])(
    "treats absent inherited %s deletion as a no-op",
    async (name) => {
      const h = await seed({ TOKEN: "unchanged" });
      const before = h.pointers.snapshot(PROJECT);
      const versions = h.secrets.liveVersions(PROJECT_SECRETS_PROVIDER);
      const deleted = (await deleteProjectSecret(task, h.deps, PROJECT, name))._unsafeUnwrap();
      expect(deleted.revision).toBe(1);
      expect(h.pointers.snapshot(PROJECT)).toEqual(before);
      expect(h.secrets.liveVersions(PROJECT_SECRETS_PROVIDER)).toEqual(versions);
      expect(h.secrets.destroyedVersions()).toEqual([]);
    },
  );

  it.each(["constructor", "toString"])("supports normal CRUD for %s", async (name) => {
    const h = makeProjectSecretsHarness(PROJECT);
    for (const [index, value] of [" first\n雪 ", "replacement"].entries()) {
      const written = (await putProjectSecret(task, h.deps, PROJECT, name, value))._unsafeUnwrap();
      expect(written.revision).toBe(index + 1);
      expect(written.items.map((item) => item.name)).toEqual([name]);
      expect(
        (await getProjectSecretSnapshot(task, h.deps, PROJECT))._unsafeUnwrap().values,
      ).toEqual({ [name]: value });
    }
    expect((await deleteProjectSecret(task, h.deps, PROJECT, name))._unsafeUnwrap()).toEqual({
      revision: 3,
      items: [],
    });
    expect((await getProjectSecretSnapshot(task, h.deps, PROJECT))._unsafeUnwrap().values).toEqual(
      {},
    );
  });

  it.each([
    JSON.parse('{"__proto__":"private-value"}') as Record<string, string>,
    { TOKEN: "private-prefix\0private-suffix" },
  ])("blocks unsafe stored snapshots before central consumption", async (values) => {
    const h = await seed(values);
    const snapshot = await getProjectSecretSnapshot(task, h.deps, PROJECT);
    expect(snapshot._unsafeUnwrapErr()).toMatchObject({ type: "project_secret_corruption" });
    expect(JSON.stringify(snapshot._unsafeUnwrapErr())).not.toContain("private-");
  });

  it.each(["replace", "delete"])("allows users to %s a stored NUL value", async (operation) => {
    const h = await seed({ TOKEN: "old\0value", KEEP: "preserved" });
    expect((await getProjectSecretSnapshot(task, h.deps, PROJECT)).isErr()).toBe(true);
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
    expect((await getProjectSecretSnapshot(task, h.deps, PROJECT))._unsafeUnwrap().values).toEqual(
      operation === "replace" ? { KEEP: "preserved", TOKEN: "repaired" } : { KEEP: "preserved" },
    );
  });
});
