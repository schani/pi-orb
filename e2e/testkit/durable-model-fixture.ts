type JsonObject = Record<string, unknown>;
const object = (value: unknown): JsonObject | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;

/** Preserve ordered fake-model policies; only change central callable exposure. */
export function centralModelScenario(scenario: unknown, central: boolean): unknown {
  const value = object(scenario);
  const model = object(value?.["model"]);
  if (!central || !value || !model || !Array.isArray(model["rules"])) return scenario;
  return {
    ...value,
    model: {
      ...model,
      rules: model["rules"].map((rule: unknown) => {
        const entry = object(rule);
        if (!entry || !Array.isArray(entry["steps"])) return rule;
        return {
          ...entry,
          steps: entry["steps"].map((step: unknown) => {
            const call = object(step);
            if (call?.["type"] !== "toolCall" || call["name"] === "codemode") return step;
            if (typeof call["name"] !== "string") return step;
            const args =
              typeof call["arguments"] === "string"
                ? call["arguments"]
                : JSON.stringify(call["arguments"] ?? {});
            return {
              ...call,
              name: "codemode",
              arguments: { code: `text(await tools.${call["name"]}(${args}));` },
            };
          }),
        };
      }),
    },
  };
}

export function latestUserMessage(body: unknown): string | undefined {
  const input = object(body)?.["input"];
  if (!Array.isArray(input)) return undefined;
  const user = input.map(object).findLast((entry) => entry?.["role"] === "user");
  const content = user?.["content"];
  if (typeof content === "string") return content;
  return Array.isArray(content)
    ? content
        .map((part) => object(part)?.["text"])
        .filter((part) => typeof part === "string")
        .join("\n")
    : undefined;
}

export function requestedTools(body: unknown): unknown[] {
  const request = object(body);
  const tools = request?.["tools"];
  const input = request?.["input"];
  return [
    ...(Array.isArray(tools) ? tools : []),
    ...(Array.isArray(input)
      ? input.flatMap((item) => {
          const entry = object(item);
          return entry?.["type"] === "additional_tools" && Array.isArray(entry["tools"])
            ? entry["tools"]
            : [];
        })
      : []),
  ];
}

export function onlyCodemodeCatalog(body: unknown): boolean {
  const tools = requestedTools(body);
  return tools.length > 0 && tools.every((tool) => object(tool)?.["name"] === "codemode");
}

/** Test-only bridge for the hosted fake, which emits only function-call SSE. */
export function requestedToolEvents(request: unknown, event: JsonObject): JsonObject[] {
  const tools = requestedTools(request);
  const raw = tools.some((tool: unknown) => {
    const value = object(tool);
    return value?.["name"] === "codemode" && value["type"] === "custom";
  });
  if (!raw) return [event];
  const type = event["type"];
  const item = object(event["item"]);
  if (item?.["type"] === "function_call" && item["name"] === "codemode") {
    const id = typeof item["id"] === "string" ? item["id"].replace(/^fc_/, "ctc_") : item["id"];
    const { arguments: args, ...rest } = item;
    const code =
      typeof args === "string" && args.length > 0 ? object(JSON.parse(args))?.["code"] : undefined;
    return [
      {
        ...event,
        item: {
          ...rest,
          type: "custom_tool_call",
          id,
          ...(code === undefined ? {} : { input: code }),
        },
      },
    ];
  }
  if (type === "response.function_call_arguments.delta") return [];
  if (type === "response.function_call_arguments.done") {
    const code = object(JSON.parse(String(event["arguments"])))?.["code"];
    if (typeof code !== "string") throw new Error("raw codemode fixture lacks code source");
    return [
      {
        type: "response.custom_tool_call_input.delta",
        output_index: event["output_index"],
        delta: code,
      },
      {
        type: "response.custom_tool_call_input.done",
        output_index: event["output_index"],
        input: code,
      },
    ];
  }
  return [event];
}

/** The fake's legacy matcher reads function outputs, not custom outputs. */
export function matcherRequest(body: JsonObject): JsonObject {
  if (!Array.isArray(body["input"])) return body;
  return {
    ...body,
    input: body["input"].map((item: unknown) => {
      const entry = object(item);
      return entry?.["type"] === "custom_tool_call_output"
        ? { ...entry, type: "function_call_output" }
        : item;
    }),
  };
}
