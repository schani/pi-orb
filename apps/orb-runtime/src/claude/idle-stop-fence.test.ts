import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { FileIdleStopFence } from "./idle-stop-fence.ts";

const roots: string[] = [];
function directory() {
  const root = mkdtempSync(join(tmpdir(), "pi-orb-idle-fence-"));
  roots.push(root);
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it("atomically replaces a private lifetime fence and returns typed read/write errors", () => {
  const root = directory();
  const fence = new FileIdleStopFence(root);
  expect(fence.read()._unsafeUnwrap()).toBeNull();
  fence.write("host:first")._unsafeUnwrap();
  fence.write("host:second")._unsafeUnwrap();
  expect(new FileIdleStopFence(root).read()._unsafeUnwrap()).toBe("host:second");
  expect(readdirSync(root)).toEqual([".idle-stop-fence"]);
  expect(statSync(join(root, ".idle-stop-fence")).mode & 0o777).toBe(0o600);
  writeFileSync(join(root, ".idle-stop-fence"), "");
  expect(fence.read().isErr()).toBe(true);
  expect(new FileIdleStopFence(join(root, "missing")).write("host:first").isErr()).toBe(true);
});
