import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

const fixture = readFileSync(new URL("../durable-independent-fixture.ts", import.meta.url), "utf8");
it("keeps the original subscription through Stop and resumed streaming", () => {
  expect(fixture).toContain("expect(readonlyOwner).toBe(originalOwner)");
  expect(fixture).toContain("expect(patch.socketGeneration).toBe(originalOwner)");
  expect(fixture).not.toContain("toBeGreaterThan(readonlyOwner)");
});
it("checks the selected execution child before killing it", () => {
  expect(fixture).toContain('"/runtime-entry.ts"');
  expect(fixture).toContain('"PI_ORB_RUNTIME_MODE=execution"');
  expect(fixture).toContain("expect(children).toHaveLength(1)");
});
it("owns the retained-spill commit barrier before checking its browser projection", () => {
  const restart = readFileSync(new URL("./durable-artifact-restart.ts", import.meta.url), "utf8");
  const commit = restart.indexOf('"retained spill read committed after restart"');
  const visible = restart.indexOf('page.getByText("RETAINED_SPILL_READ_DONE", { exact: true })');
  expect(commit).toBeGreaterThan(0);
  expect(visible).toBeGreaterThan(commit);
});
