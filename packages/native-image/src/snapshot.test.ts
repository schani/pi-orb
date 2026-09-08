import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { prepareSourceSnapshot } from "./snapshot.ts";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

async function repository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pi-orb-source-repository-"));
  temporaryDirectories.push(root);
  await mkdir(`${root}/guest/node_modules`, { recursive: true });
  await mkdir(`${root}/tooling`, { recursive: true });
  await writeFile(`${root}/package.json`, "{}\n");
  await writeFile(`${root}/guest/used.txt`, "uploaded\n");
  await writeFile(`${root}/guest/.env.local`, "ignored secret\n");
  await writeFile(`${root}/guest/node_modules/dependency.js`, "ignored\n");
  await writeFile(`${root}/tooling/builder.ts`, "export {};\n");
  await writeFile(`${root}/.gitignore`, ".env*\nnode_modules/\n");
  await execFileAsync("git", ["init", "--quiet"], { cwd: root });
  await execFileAsync(
    "git",
    ["add", ".gitignore", "package.json", "guest/used.txt", "tooling/builder.ts"],
    { cwd: root },
  );
  return root;
}

describe("native image source snapshot", () => {
  it("uses one Git file list for the archive and hashes", async () => {
    const root = await repository();
    const output = `${root}/output`;
    const snapshot = await prepareSourceSnapshot(output, {
      repositoryRoot: root,
      uploadedPaths: ["package.json", "guest"],
      toolingPaths: ["tooling"],
    });
    if (snapshot.isErr()) throw new Error(snapshot.error.message);
    const archive = await readFile(`${output}/source.tar.gz`);
    expect(snapshot.value.archiveSha256).toBe(createHash("sha256").update(archive).digest("hex"));
    expect(Object.keys(snapshot.value.inputInventory)).toEqual(["guest/used.txt", "package.json"]);
    expect(Object.keys(snapshot.value.toolingInputInventory)).toEqual(["tooling/builder.ts"]);
    expect(snapshot.value.inputInventory["tooling/builder.ts"]).toBeUndefined();
    const listing = await execFileAsync("tar", ["-tzf", `${output}/source.tar.gz`]);
    expect(listing.stdout).not.toMatch(/(^|\/)\._/m);
  });

  it("detects a source change after archive capture", async () => {
    const root = await repository();
    const snapshot = await prepareSourceSnapshot(`${root}/output`, {
      repositoryRoot: root,
      uploadedPaths: ["package.json", "guest"],
      toolingPaths: ["tooling"],
      afterArchive: () => writeFile(`${root}/guest/used.txt`, "changed\n"),
    });
    expect(snapshot.isErr() && snapshot.error.type).toBe("source_changed");
  });

  it("rejects symlinks from the upload list", async () => {
    const root = await repository();
    await symlink("used.txt", `${root}/guest/link.txt`);
    const snapshot = await prepareSourceSnapshot(`${root}/output`, {
      repositoryRoot: root,
      uploadedPaths: ["package.json", "guest"],
      toolingPaths: ["tooling"],
    });
    expect(snapshot.isErr() && snapshot.error.type).toBe("invalid_source");
  });
});
