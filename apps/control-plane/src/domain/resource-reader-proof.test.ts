import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { SnapshotResourceReader } from "./resources.ts";

const reader = new SnapshotResourceReader({
  orbId: "proof",
  commitSha: "a".repeat(40),
  instructionPath: null,
  skillRoot: ".agents/skills",
  files: (
    [
      [".agents/skills/proof/reference.md", "adopted reference"],
      ["/opt/pi-orb/skills/boot-hooks/SKILL.md", "adopted bundled skill"],
    ] as const
  ).map(([path, text]) => ({
    path,
    bytes: Buffer.from(text),
    sha256: createHash("sha256").update(text).digest("hex"),
  })),
});

it.each([
  ["./.agents/skills/proof/reference.md", "adopted reference"],
  [".agents/skills/proof/../proof/reference.md", "adopted reference"],
  ["/opt/pi-orb/skills/cloud-identity/../boot-hooks/SKILL.md", "adopted bundled skill"],
])("resolves adopted resource spelling %s without filesystem access", async (path, text) => {
  expect(reader.contains(path)).toBe(true);
  expect(Buffer.from((await reader.read(path))._unsafeUnwrap()).toString()).toBe(text);
});

it.each([
  "../.agents/skills/proof/reference.md",
  "/workspace/repo/.agents/skills/proof/reference.md",
  "/.agents/skills/proof/reference.md",
  "/opt/pi-orb/skills/../../../../etc/passwd",
  "/opt/pi-orb/skills/../private.txt",
  ".agents/skills/proof/missing.md",
  ".agents\\skills\\proof\\reference.md",
])("rejects non-adopted path %s", async (path) => {
  expect(reader.contains(path)).toBe(false);
  const result = await reader.read(path);
  expect(result.isErr()).toBe(true);
  if (result.isErr()) expect(result.error.code).toBe("not_found");
});
