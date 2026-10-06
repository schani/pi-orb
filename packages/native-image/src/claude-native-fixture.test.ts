import { createHash } from "node:crypto";
import {
  lstatSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  statSync,
} from "node:fs";
import { chmod, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { expect, it } from "vitest";
import { stageClaudeNativeFixture } from "./testkit/claude-native-fixture.ts";

const repository = new URL("../../../", import.meta.url).pathname;

for (const mask of [0o022, 0o077]) {
  it(`stages a closed readable native fixture from a private checkout under umask ${mask.toString(8)}`, async () => {
    const privateAncestor = await mkdtemp("/tmp/claude-private-checkout-");
    await chmod(privateAncestor, 0o700);
    const checkout = join(privateAncestor, "checkout");
    await mkdir(checkout);
    for (const name of ["apps", "infra", "node_modules", "package.json"])
      await symlink(join(repository, name), join(checkout, name));
    const previousMask = process.umask(mask);
    const fixture = stageClaudeNativeFixture(checkout);
    process.umask(previousMask);
    try {
      expect(fixture.isOk(), fixture.isErr() ? JSON.stringify(fixture.error) : "").toBe(true);
      if (fixture.isErr()) return;
      expect(relative(privateAncestor, fixture.value.directory).startsWith("..")).toBe(true);
      expect(statSync(privateAncestor).mode & 0o777).toBe(0o700);
      const inspect = (directory: string) => {
        for (const entry of readdirSync(directory)) {
          const path = join(directory, entry);
          const metadata = lstatSync(path);
          if (metadata.isSymbolicLink()) {
            expect(isAbsolute(readlinkSync(path))).toBe(false);
            expect(
              relative(realpathSync(fixture.value.directory), realpathSync(path)).startsWith(".."),
            ).toBe(false);
          }
          expect(metadata.mode & 0o444, relative(fixture.value.directory, path)).toBe(0o444);
          if (metadata.isDirectory()) {
            expect(metadata.mode & 0o111, relative(fixture.value.directory, path)).toBe(0o111);
            inspect(path);
          }
        }
      };
      inspect(fixture.value.directory);
      for (const file of [
        "claude-acceptance.sh",
        "claude-worker.mjs",
        "claude-workload.mjs",
        "claude-receipt-edge.mjs",
      ]) {
        const digest = (path: string) =>
          createHash("sha256").update(readFileSync(path)).digest("hex");
        expect(digest(join(fixture.value.helpers, file))).toBe(
          digest(join(repository, "infra/native-vm", file)),
        );
      }
      expect(fixture.value.packages).toContain("@anthropic-ai/claude-agent-sdk");
      expect(fixture.value.packages).toContain("@pi-orb/protocol");
      expect(fixture.value.packages).not.toContain("vitest");
      expect(fixture.value.packages).not.toContain("agent-browser");
      expect(fixture.value.packages).toContain("@earendil-works/pi-coding-agent");
      expect(fixture.value.dispose().isOk()).toBe(true);
    } finally {
      if (fixture.isOk()) expect(fixture.value.dispose().isOk()).toBe(true);
      await rm(privateAncestor, { recursive: true, force: true });
    }
  });
}

it("reports a missing fixture prerequisite without raw filesystem errors", () => {
  const result = stageClaudeNativeFixture("/nonexistent/claude-native-fixture-source");
  expect(result.isErr()).toBe(true);
  if (result.isErr())
    expect(result.error).toEqual({
      code: "claude_native_fixture_failed",
      operation: "copy",
      path: "infra/native-vm/claude-acceptance.sh",
    });
});
