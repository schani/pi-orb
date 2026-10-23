import { expect, it } from "vitest";
import { centralModelScenario } from "./testkit/durable-model-fixture.ts";

it("preserves the real shell effect", () => {
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
  const transformed = centralModelScenario(scenario) as typeof scenario;
  const call = transformed.model.rules[0]?.steps[0];
  expect(call?.name).toBe("codemode");
  expect(call?.arguments).toEqual({
    code: 'text(await tools.bash({"command":"printf GOOGLE_MAIN_TOOL_OK"}));',
  });
});
