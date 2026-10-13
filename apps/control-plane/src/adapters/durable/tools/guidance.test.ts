import { expect, it } from "vitest";
import { CallableCatalog } from "./catalog.ts";
import { codemodeTool } from "./codemode.ts";
import { subagentTools } from "./subagents.ts";

it("declares inherited subagent configuration with a named model selector", () => {
  const catalog = new CallableCatalog(subagentTools);
  const start = catalog.describe("subagent");
  if (!start) return expect.fail("subagent declaration missing");
  expect(start).toContain("Returns agent_id immediately");
  expect(start).toContain("Inherits parent instructions and authorized tools");
  expect(start).toContain("cannot start subagents or orbs");
  expect(start).toContain("No profiles or kinds");
  expect(start).toContain('model?: "Astra" | "Sol" | "Terra" | "Luna"');
});

it("documents the reserved tools binding without a subagent example", () => {
  const tool = codemodeTool(new CallableCatalog(subagentTools), new Set());
  expect(tool.description).toContain("Do not redeclare tools");
  expect(tool.description).not.toContain("searchTools('subagent')");
});
