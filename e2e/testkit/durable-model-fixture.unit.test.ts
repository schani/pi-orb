import { describe, expect, it, vi } from "vitest";
import { createFakeSession, fixtureAgentBackend } from "../harness.ts";
import {
  centralModelScenario,
  matcherRequest,
  onlyCodemodeCatalog,
  requestedToolEvents,
} from "./durable-model-fixture.ts";

describe("central model fixtures", () => {
  it("selects backend independently and sends adapted central but unchanged SDK policies", async () => {
    const bodies: { scenario: unknown }[] = [];
    vi.stubGlobal("fetch", async (_url: string, request: RequestInit) => {
      bodies.push(JSON.parse(String(request.body)));
      return Response.json({
        sessionKey: "fixture",
        oauthBaseUrl: "http://fake/auth",
        inferenceBaseUrl: "http://fake/model",
      });
    });
    const policy = {
      model: {
        rules: [{ steps: [{ type: "toolCall", name: "bash", arguments: { command: "true" } }] }],
      },
    };
    try {
      expect(fixtureAgentBackend("host-pi")).toBe("host-pi");
      expect(fixtureAgentBackend("central-durable")).toBe("central-durable");
      await createFakeSession("sdk", policy, "host-pi");
      await createFakeSession("central", policy, "central-durable");
      expect(bodies[0]?.scenario).toEqual(policy);
      expect(bodies[1]?.scenario).toEqual(centralModelScenario(policy, true));
    } finally {
      vi.unstubAllGlobals();
    }
  });
  const scenario = {
    auth: { accountId: "owner" },
    model: {
      rules: [
        {
          match: { userMessage: "run" },
          steps: [
            { type: "reasoning", text: "check" },
            {
              type: "toolCall",
              name: "bash",
              arguments: { command: "printf OK" },
              callId: "call_1",
            },
            { type: "stop", status: "completed" },
          ],
        },
      ],
    },
  };
  it("converts central calls without changing ordered rules or SDK fixtures", () => {
    expect(centralModelScenario(scenario, false)).toBe(scenario);
    const converted = centralModelScenario(scenario, true) as typeof scenario;
    expect(converted.auth).toEqual(scenario.auth);
    expect(converted.model.rules[0]?.match).toEqual(scenario.model.rules[0]?.match);
    expect(converted.model.rules[0]?.steps[1]).toEqual({
      type: "toolCall",
      name: "codemode",
      arguments: { code: 'text(await tools.bash({"command":"printf OK"}));' },
      callId: "call_1",
    });
    expect(scenario.model.rules[0]?.steps[1]?.name).toBe("bash");
  });
  it("preserves source code and shell policy configuration", () => {
    const input = {
      model: {
        policy: { requiredTools: ["shell_command"] },
        rules: [
          {
            steps: [
              { type: "toolCall", name: "codemode", arguments: { code: "text('unchanged')" } },
            ],
          },
        ],
      },
    };
    expect(centralModelScenario(input, true)).toEqual(input);
  });
  it("rejects direct catalogs, accepts raw and JSON declarations", () => {
    expect(
      onlyCodemodeCatalog({
        tools: [{ type: "custom", name: "codemode", format: { type: "grammar" } }],
      }),
    ).toBe(true);
    expect(onlyCodemodeCatalog({ tools: [{ type: "function", name: "codemode" }] })).toBe(true);
    expect(onlyCodemodeCatalog({ tools: [{ name: "codemode" }, { name: "bash" }] })).toBe(false);
    expect(onlyCodemodeCatalog({})).toBe(false);
  });
  it("recognizes transcript additional_tools declarations without admitting direct tools", () => {
    const additional = {
      input: [
        {
          type: "additional_tools",
          role: "developer",
          tools: [{ type: "custom", name: "codemode" }],
        },
      ],
    };
    expect(onlyCodemodeCatalog(additional)).toBe(true);
    expect(onlyCodemodeCatalog({ ...additional, tools: [{ name: "bash" }] })).toBe(false);
    const event = {
      type: "response.output_item.added",
      output_index: 0,
      item: {
        type: "function_call",
        id: "fc_1",
        call_id: "call_1",
        name: "codemode",
        arguments: "",
      },
    };
    expect(requestedToolEvents(additional, event)[0]?.["item"]).toMatchObject({
      type: "custom_tool_call",
    });
  });
  it("emits real custom raw-source events for requested grammar tools", () => {
    const request = { tools: [{ type: "custom", name: "codemode" }] };
    const added = {
      type: "response.output_item.added",
      output_index: 0,
      item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "codemode" },
    };
    expect(requestedToolEvents(request, added)).toEqual([
      { ...added, item: { ...added.item, type: "custom_tool_call", id: "ctc_1" } },
    ]);
    expect(
      requestedToolEvents(request, {
        type: "response.function_call_arguments.delta",
        output_index: 0,
        delta: '{"code":',
      }),
    ).toEqual([]);
    expect(
      requestedToolEvents(request, {
        type: "response.function_call_arguments.done",
        output_index: 0,
        arguments: JSON.stringify({ code: "text('RAW')" }),
      }),
    ).toEqual([
      { type: "response.custom_tool_call_input.delta", output_index: 0, delta: "text('RAW')" },
      { type: "response.custom_tool_call_input.done", output_index: 0, input: "text('RAW')" },
    ]);
    expect(requestedToolEvents({ tools: [{ type: "function", name: "codemode" }] }, added)).toEqual(
      [added],
    );
  });
  it("makes raw outputs matchable by legacy fake service without changing production requests", () => {
    const request = {
      input: [{ type: "custom_tool_call_output", call_id: "call_1", output: "OK" }],
      tools: [{ type: "custom", name: "codemode" }],
    };
    expect(matcherRequest(request)).toEqual({
      ...request,
      input: [{ ...request.input[0], type: "function_call_output" }],
    });
    expect(request.input[0]?.type).toBe("custom_tool_call_output");
  });
});
