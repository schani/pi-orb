import { FileError } from "@earendil-works/pi-durable/env";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { okAsync } from "neverthrow";
import { expect, it, vi } from "vitest";
import { CallableCatalog } from "./catalog.ts";
import { codemodeTool } from "./codemode.ts";
import { subagentTools } from "./subagents.ts";
import { openCodemodeHarness } from "./testkit/codemode.ts";

it("declares inherited subagent configuration with a named model selector", async () => {
  const catalog = new CallableCatalog(subagentTools);
  const fixture = await openCodemodeHarness(catalog);
  try {
    const result = await fixture.run('return await describeTool("subagent");');
    expect(result.isError).toBe(false);
    const start =
      result.output
        ?.filter((item) => item.type === "text")
        .map((item) => item.text)
        .join("\n") ?? "";
    expect(start).toContain("Returns agent_id immediately");
    expect(start).toContain("Inherits parent instructions and authorized tools");
    expect(start).toContain("cannot start subagents or orbs");
    expect(start).toContain("No profiles or kinds");
    expect(start).toContain('model?: "Astra" | "Sol" | "Terra" | "Luna"');
  } finally {
    await fixture.close();
  }
});

it("documents the reserved tools binding without a subagent example", () => {
  const tool = codemodeTool(new CallableCatalog(subagentTools), new Set());
  expect(tool.description).toContain("Do not redeclare tools or other injected globals.");
  expect(tool.description).not.toContain("searchTools('subagent')");
});

it("describes inline images without promising temp files", () => {
  const tool = codemodeTool(new CallableCatalog([]), new Set());
  expect(tool.description).toContain("Images are returned inline.");
  expect(tool.description).not.toContain(
    "`image()` also saves the image to a temp file and the result names its path.",
  );
});

it("returns native images inline without writing to the environment or text artifact store", async () => {
  const env = new NodeExecutionEnv({ cwd: "/tmp" });
  const writes = vi
    .spyOn(env, "writeFile")
    .mockResolvedValue({ ok: false, error: new FileError("not_supported", "unexpected write") });
  const temp = vi
    .spyOn(env, "createTempDir")
    .mockResolvedValue({ ok: true, value: "/tmp/unexpected-image-dir" });
  const spill = vi.fn(() => okAsync("/orb-artifacts/unexpected-image"));
  const fixture = await openCodemodeHarness(new CallableCatalog([]), { env, files: { spill } });
  const picture = { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" };
  try {
    const result = await fixture.run(`image(${JSON.stringify(picture)});`);
    expect(result.isError).toBe(false);
    expect(result.output?.filter((item) => item.type === "image")).toEqual([picture]);
    expect(JSON.stringify(result.output)).toContain("scoped artifact storage unavailable");
    expect(writes).not.toHaveBeenCalled();
    expect(temp).not.toHaveBeenCalled();
    expect(spill).not.toHaveBeenCalled();
  } finally {
    await fixture.close();
    writes.mockRestore();
    temp.mockRestore();
  }
});
