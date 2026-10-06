import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { SnapshotResourceReader } from "../../domain/resources.ts";
import { loadPlatformResources } from "./platform-resources.ts";

it("loads only application-owned bundled skills into private virtual paths", async () => {
  const loaded = (
    await loadPlatformResources(
      fileURLToPath(new URL("../../../../orb-runtime/skills/", import.meta.url)),
    )
  )._unsafeUnwrap();
  expect(
    loaded
      .filter((file) => file.path.endsWith("/SKILL.md"))
      .map((file) => file.path)
      .sort(),
  ).toEqual([
    "/opt/pi-orb/skills/boot-hooks/SKILL.md",
    "/opt/pi-orb/skills/cloud-identity/SKILL.md",
    "/opt/pi-orb/skills/hosting/SKILL.md",
  ]);
  expect(loaded.every((file) => file.sha256.length === 64)).toBe(true);
  const reader = new SnapshotResourceReader({
    orbId: "orb",
    commitSha: "a".repeat(40),
    instructionPath: null,
    skillRoot: "/opt/pi-orb/skills",
    files: loaded,
  });
  const cloud = Buffer.from(
    (await reader.read("/opt/pi-orb/skills/cloud-identity/SKILL.md"))._unsafeUnwrap(),
  ).toString();
  expect(cloud).toContain("/opt/pi-orb/skills/boot-hooks/SKILL.md");
  expect(
    Buffer.from(
      (await reader.read("/opt/pi-orb/skills/boot-hooks/SKILL.md"))._unsafeUnwrap(),
    ).toString(),
  ).toContain("name:");
});
