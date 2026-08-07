import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readRootReadme } from "./context.ts";

describe("readRootReadme", () => {
  it("reads a deterministic root README and truncates by UTF-8 bytes", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-orb-readme-"));
    await writeFile(join(root, "README.txt"), "later");
    await writeFile(join(root, "readme.md"), "ééé");
    const result = await readRootReadme(root, 5);
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toBe("éé");
  });

  it("rejects a README that is not UTF-8 text", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-orb-readme-"));
    await writeFile(join(root, "README"), Buffer.from([0xff, 0xfe]));
    const result = await readRootReadme(root, 100);
    expect(result.isErr()).toBe(true);
  });

  it("ignores symlinks, nested READMEs, and missing files", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-orb-readme-"));
    const outside = join(root, "outside.txt");
    await writeFile(outside, "secret");
    await symlink(outside, join(root, "README.md"));
    await mkdir(join(root, "nested"));
    await writeFile(join(root, "nested", "README.md"), "nested");
    const result = await readRootReadme(root, 100);
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toBeNull();
  });
});
