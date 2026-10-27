import * as fs from "node:fs";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { materializeOwnerSkills } from "./owner-skills.ts";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, renameSync: vi.fn(actual.renameSync) };
});

it("materializes complete binary/executable bundles and removes deleted files and skills", () => {
  const config = mkdtempSync(join(tmpdir(), "claude-skills-"));
  const skill = {
    name: "mine",
    content: "---\nname: mine\ndescription: mine\n---\n",
    source: { url: "https://github.com/o/r/tree/main/s", commitSha: "a".repeat(40) },
    files: [
      { path: "assets/a.png", base64: "iVBORw0KGgoA/w==", executable: false },
      { path: "scripts/run.sh", base64: "IyEvYmluL3NoCg==", executable: true },
    ],
  };
  try {
    materializeOwnerSkills(config, [skill])._unsafeUnwrap();
    expect(readFileSync(join(config, "skills/mine/assets/a.png")).toString("base64")).toBe(
      skill.files[0]!.base64,
    );
    expect(statSync(join(config, "skills/mine/scripts/run.sh")).mode & 0o777).toBe(0o700);
    expect(statSync(join(config, "skills/mine/assets/a.png")).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(config, "skills/mine/SKILL.md"), "utf8")).toBe(skill.content);
    materializeOwnerSkills(config, [{ ...skill, files: [] }])._unsafeUnwrap();
    expect(readdirSync(join(config, "skills/mine"))).toEqual(["SKILL.md"]);
    materializeOwnerSkills(config, [])._unsafeUnwrap();
    expect(readdirSync(join(config, "skills"))).toEqual([]);
    writeFileSync(join(config, "not-a-directory"), "");
    expect(materializeOwnerSkills(join(config, "not-a-directory"), [skill]).isErr()).toBe(true);
  } finally {
    rmSync(config, { recursive: true, force: true });
  }
});

it("rejects unsafe bundles without deleting the installed skill set", () => {
  const config = mkdtempSync(join(tmpdir(), "claude-skills-invalid-"));
  try {
    const skill = { name: "mine", content: "old", files: [], source: null };
    materializeOwnerSkills(config, [skill])._unsafeUnwrap();
    const result = materializeOwnerSkills(config, [
      { ...skill, files: [{ path: "../outside", base64: "", executable: false }] },
    ]);
    expect(result.isErr()).toBe(true);
    expect(readFileSync(join(config, "skills/mine/SKILL.md"), "utf8")).toBe("old");
  } finally {
    rmSync(config, { recursive: true, force: true });
  }
});

it("materializes a large binary support file without recursive regex stack exhaustion", () => {
  const config = mkdtempSync(join(tmpdir(), "claude-skills-large-"));
  const bytes = Buffer.alloc(8 * 1024 * 1024 - 1024, 255);
  try {
    materializeOwnerSkills(config, [
      {
        name: "large",
        content: "root",
        source: null,
        files: [{ path: "large.bin", base64: bytes.toString("base64"), executable: false }],
      },
    ])._unsafeUnwrap();
    expect(readFileSync(join(config, "skills/large/large.bin")).equals(bytes)).toBe(true);
  } finally {
    rmSync(config, { recursive: true, force: true });
  }
});

it("retains the prior snapshot if publication and restoring its backup both fail", async () => {
  const config = mkdtempSync(join(tmpdir(), "claude-skills-backup-"));
  const skill = { name: "mine", content: "old", files: [], source: null };
  materializeOwnerSkills(config, [skill])._unsafeUnwrap();
  const rename = (await vi.importActual<typeof import("node:fs")>("node:fs")).renameSync;
  const spy = vi.mocked(fs.renameSync).mockImplementation((from, to) => {
    if (String(from).endsWith("/next") || String(from).endsWith("/old"))
      throw Object.assign(new Error("denied"), { code: "EACCES" });
    return rename(from, to);
  });
  try {
    const result = materializeOwnerSkills(config, [{ ...skill, content: "new" }]);
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.backupPath).toBeDefined();
      expect(readFileSync(join(result.error.backupPath!, "mine/SKILL.md"), "utf8")).toBe("old");
      expect(result.error.message).toContain(result.error.backupPath);
    }
  } finally {
    spy.mockImplementation(rename);
    rmSync(config, { recursive: true, force: true });
  }
});
