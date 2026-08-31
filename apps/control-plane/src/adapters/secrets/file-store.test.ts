import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NoSimulationTask } from "determined";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { StoredProjectSecretBundle } from "../../domain/ports.ts";
import { FileSecretStore } from "./file-store.ts";

const task = new NoSimulationTask("file secret store", false);

describe("FileSecretStore version inventory", () => {
  let directory: string;
  let store: FileSecretStore;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "pi-orb-secret-store-"));
    store = new FileSecretStore(directory);
  });
  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  it("lists only live versions in the requested namespace", async () => {
    const first = await store.writeSecret<StoredProjectSecretBundle>(task, "project-secrets", {
      projectId: "project-a",
      revision: 1,
      values: { TOKEN: "one" },
    });
    const second = await store.writeSecret<StoredProjectSecretBundle>(task, "project-secrets", {
      projectId: "project-b",
      revision: 1,
      values: { TOKEN: "two" },
    });
    expect(first.isOk() && second.isOk()).toBe(true);
    expect((await store.listSecretVersions(task, "other"))._unsafeUnwrap()).toEqual([]);
    const versions = (await store.listSecretVersions(task, "project-secrets"))._unsafeUnwrap();
    expect(versions.sort()).toEqual(
      [first.isOk() ? first.value.version : "", second.isOk() ? second.value.version : ""].sort(),
    );
    if (first.isOk()) await store.destroySecret(task, "project-secrets", first.value.version);
    expect((await store.listSecretVersions(task, "project-secrets"))._unsafeUnwrap()).toEqual([
      second.isOk() ? second.value.version : "",
    ]);
  });
});
