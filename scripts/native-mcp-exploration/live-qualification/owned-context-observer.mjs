import { createContextMeasurement } from "./context-measurement.mjs";
import { contextToolPolicy, deniedSearchShape } from "./owned-context-policy.mjs";

const expected = { cloudflare: 3, datadog: 33 };
const queries = ["cloudflare account", "datadog monitor"];
export const successfulAssistant = (message) =>
  message?.role === "assistant" &&
  message.provider === "openai-codex" &&
  message.model === "gpt-6.1-sol" &&
  message.stopReason === "stop";
export function qualifiesMeasurement(record, profile, phase) {
  if (
    record.profile !== profile ||
    record.phase !== phase ||
    record.kind !== "provider_payload" ||
    record.status !== "measured" ||
    !record.modelVerified ||
    !record.codemodeActive ||
    record.deniedCalls !== 0
  )
    return false;
  const inventory =
    profile === "root" || profile === "child" ? expected : { cloudflare: 0, datadog: 0 };
  return (
    Object.entries(inventory).every(([name, count]) => record.discovered?.[name] === count) &&
    (phase === "after_search"
      ? queries.every((query) => record.searched?.[query] > 0)
      : phase === "before_discovery"
        ? queries.every((query) => !record.searched?.[query])
        : true)
  );
}

// Loaded as a file extension so Pi's actual child loader installs it independently.
export default function (pi) {
  const state = globalThis[Symbol.for("pi-orb:owned-context-qualification")];
  if (!state) throw new Error("qualification state absent");
  let profile = "invalid";
  pi.on("session_start", (_event, ctx) => {
    const id = ctx.sessionManager.getSessionId();
    profile =
      id === state.rootSessionId
        ? state.profile
        : state.profile === "root"
          ? "child"
          : "baseline_child";
    state.started.add(profile);
  });
  const inventory = () =>
    Object.fromEntries(
      ["cloudflare", "datadog"].map((name) => [
        name,
        pi.getAllTools().filter((tool) => tool.name.startsWith(`mcp__${name}__`)).length,
      ]),
    );
  let modelVerified = false;
  const verifyModel = (_event, ctx) => {
    modelVerified = ctx?.model?.provider === "openai-codex" && ctx.model.id === "gpt-6.1-sol";
    if (state.modelVerified) state.modelVerified[profile] = modelVerified;
  };
  pi.on("context_with_system", (event, ctx) => {
    verifyModel(event, ctx);
    state.discovered[profile] = inventory();
  });
  pi.on("before_provider_request", verifyModel);
  const policy = contextToolPolicy();
  pi.on("agent_end", ({ messages }) => {
    state.completed[profile] = successfulAssistant(
      messages.findLast((message) => message.role === "assistant"),
    );
  });
  pi.on("tool_call", ({ toolName, input }) => {
    if (
      state.allowChildCodemode &&
      profile === "child" &&
      (toolName === "codemode" || toolName === "mcp__cloudflare__read_0")
    )
      return;
    if (policy(toolName, input)) return;
    state.denied[profile] = (state.denied[profile] ?? 0) + 1;
    if (state.deniedCategories) {
      const category =
        toolName === "tool_search" ? "tool_search" : toolName === "codemode" ? "codemode" : "other";
      state.deniedCategories[profile] ??= {};
      const categories = state.deniedCategories[profile];
      categories[category] = (categories[category] ?? 0) + 1;
    }
    if (
      toolName === "tool_search" &&
      state.deniedSearchShapes &&
      !state.deniedSearchShapes[profile]
    )
      state.deniedSearchShapes[profile] = deniedSearchShape(input);
    return { block: true, terminate: true, reason: "Qualification permits no model tool calls" };
  });
  createContextMeasurement(
    "root",
    () => {
      const discovered = inventory();
      if (state.profile !== "root") return "before_discovery";
      if (queries.every((query) => (state.searches[profile]?.[query] ?? 0) > 0))
        return "after_search";
      return discovered.cloudflare === expected.cloudflare &&
        discovered.datadog === expected.datadog
        ? "after_discovery"
        : "before_discovery";
    },
    (record) => {
      if (state.records.length < 24)
        state.records.push({
          ...record,
          profile,
          discovered: inventory(),
          searched: { ...state.searches[profile] },
          deniedCalls: state.denied[profile] ?? 0,
          modelVerified,
          codemodeActive: pi.getActiveTools().includes("codemode"),
        });
    },
  )(pi);
}
