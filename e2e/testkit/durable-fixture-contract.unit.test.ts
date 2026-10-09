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
it("re-evaluates adopted instructions for ordinary ready and hook-policy turns", () => {
  expect(fixture).toContain('"READY_POLICY_REEVALUATED"');
  expect(fixture).toContain('regex: "Host instructions adopted; re-evaluate"');
  expect(fixture).toContain('getByText("READY_VM_DONE", { exact: true })');
});
