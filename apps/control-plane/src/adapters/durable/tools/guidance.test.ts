import { createCodemodeTool } from "@earendil-works/pi-durable/codemode";
import { FileError } from "@earendil-works/pi-durable/env";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { okAsync } from "neverthrow";
import { expect, it, vi } from "vitest";
import { CallableCatalog } from "./catalog.ts";
import { CODEMODE_BOOTSTRAP, codemodeTool } from "./codemode.ts";
import { PiCodemodeSandbox } from "./codemode-sandbox.ts";
import { createSubagentTools } from "./subagents.ts";
import { openCodemodeHarness } from "./testkit/codemode.ts";

it("declares inherited subagent configuration with a named model selector", async () => {
  const catalog = new CallableCatalog(createSubagentTools(() => okAsync(undefined)));
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

it("offers only the literal skill bootstrap and preserves the native tool contract", () => {
  const tool = codemodeTool(
    new CallableCatalog(createSubagentTools(() => okAsync(undefined))),
    new Set(),
  );
  const native = createCodemodeTool({ sandbox: new PiCodemodeSandbox(), models: false });
  expect(tool.description).toBe(CODEMODE_BOOTSTRAP);
  expect(tool.description).toBe(
    'Read the codemode skill first:\ntext(await tools.read({path:"/opt/pi-orb/skills/codemode/SKILL.md"}));',
  );
  for (const key of [
    "name",
    "parameters",
    "constrainedSampling",
    "outputLimits",
    "replay",
    "callers",
  ] as const)
    expect(tool[key]).toEqual(native[key]);
  expect(tool.constrainedSampling).toMatchObject({
    type: "grammar",
    variants: { openai_lark: expect.stringContaining("start: options_source | plain_source") },
  });
  expect(tool.description).not.toMatch(/Run JavaScript|Globals:|chart\(|8-outstanding|temp file/);
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
