import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { centralModelScenario } from "./testkit/durable-model-fixture.ts";

const fixture = readFileSync(new URL("./full-main-auth.e2e.test.ts", import.meta.url), "utf8");

it("waits for the selected backend's model-visible tool without weakening the roundtrip", () => {
  expect(fixture).toContain('fixtureAgentBackend() === "central-durable" ? "codemode" : "bash"');
  expect(fixture).toContain("frame.event.name === completedToolName");
  expect(fixture).toContain('frame.event.state === "completed"');
  expect(fixture).toContain('command: "printf GOOGLE_MAIN_TOOL_OK"');
  expect(fixture).toContain('toolResultContains: { regex: "GOOGLE_MAIN_TOOL_OK" }');
  expect(fixture).toContain(
    'JSON.stringify(frame.record).includes("GOOGLE_MAIN_ROUNDTRIP_COMPLETE")',
  );
});

it.each([false, true])("preserves the real shell effect under central=%s", (central) => {
  const scenario = {
    model: {
      rules: [
        {
          steps: [
            {
              type: "toolCall",
              name: "bash",
              arguments: { command: "printf GOOGLE_MAIN_TOOL_OK" },
            },
          ],
        },
      ],
    },
  };
  const transformed = centralModelScenario(scenario, central) as typeof scenario;
  const call = transformed.model.rules[0]?.steps[0];
  expect(call?.name).toBe(central ? "codemode" : "bash");
  expect(call?.arguments).toEqual(
    central
      ? { code: 'text(await tools.bash({"command":"printf GOOGLE_MAIN_TOOL_OK"}));' }
      : { command: "printf GOOGLE_MAIN_TOOL_OK" },
  );
});
