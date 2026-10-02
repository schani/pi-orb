// Model tool calls, including nested codemode calls, are subject to this gate.
// Native MCP transport fetches are not model tool calls and are outside its scope.
export function contextToolPolicy() {
  return () => false;
}
const exactSearch = (args) =>
  args !== null &&
  typeof args === "object" &&
  !Array.isArray(args) &&
  Object.keys(args).length === 1 &&
  (args.query === "cloudflare account" || args.query === "datadog monitor");
const profiles = new Set(["root", "child", "independent_empty_baseline", "baseline_child"]);
const phases = new Set(["before_discovery", "after_discovery", "after_search"]);
const kinds = new Set(["transcript", "provider_payload"]);
const diagnosticProfiles = ["independent_empty_baseline", "baseline_child", "root", "child"];
const queryNames = ["cloudflare account", "datadog monitor"];
const shapeKeys = [
  "queryMatchesPolicy",
  "queryObserved",
  "hasLimit",
  "onlyQueryAndLimit",
  "limitValid",
];
export function deniedSearchShape(args) {
  const object = args !== null && typeof args === "object" && !Array.isArray(args);
  const query = object ? args.query : undefined;
  const hasLimit = object && Object.hasOwn(args, "limit");
  return {
    queryMatchesPolicy: exactSearch(args),
    queryObserved: queryNames.includes(query),
    hasLimit,
    onlyQueryAndLimit:
      object &&
      Object.hasOwn(args, "query") &&
      Object.keys(args).every((key) => key === "query" || key === "limit"),
    limitValid: hasLimit && Number.isSafeInteger(args.limit) && args.limit > 0,
  };
}
const boundedCount = (count) =>
  Number.isSafeInteger(count) && count >= 0 ? Math.min(count, 99_999_999) : 0;
export function failureDiagnostic(state, stage) {
  return {
    stage,
    profiles: diagnosticProfiles
      .filter((profile) => state.started.has(profile))
      .map((profile) => ({
        profile,
        searched: Object.fromEntries(
          ["cloudflare account", "datadog monitor"].map((query) => [
            query,
            boundedCount(state.searches[profile]?.[query]),
          ]),
        ),
        deniedCalls: boundedCount(state.denied[profile]),
        deniedSearchShape: state.deniedSearchShapes?.[profile]
          ? Object.fromEntries(
              shapeKeys.map((key) => [key, state.deniedSearchShapes[profile][key] === true]),
            )
          : null,
        deniedCategories: Object.fromEntries(
          ["tool_search", "codemode", "other"].map((category) => [
            category,
            boundedCount(state.deniedCategories?.[profile]?.[category]),
          ]),
        ),
        completed: state.completed[profile] === true,
        modelVerified: state.modelVerified?.[profile] === true,
        discovered: Object.fromEntries(
          ["cloudflare", "datadog"].map((name) => [
            name,
            boundedCount(state.discovered[profile]?.[name]),
          ]),
        ),
        metrics: summarizeContextRecords(
          state.records.filter((record) => record.profile === profile),
        ),
      })),
  };
}
export function summarizeContextRecords(records) {
  return records.slice(0, 24).map((record) => ({
    profile: profiles.has(record.profile) ? record.profile : "invalid",
    phase: phases.has(record.phase) ? record.phase : "invalid",
    kind: kinds.has(record.kind) ? record.kind : "invalid",
    status: record.status === "measured" ? "measured" : "unavailable",
    utf8Bytes:
      Number.isSafeInteger(record.utf8Bytes) && record.utf8Bytes >= 0 ? record.utf8Bytes : null,
    codepoints:
      Number.isSafeInteger(record.codepoints) && record.codepoints >= 0 ? record.codepoints : null,
    activeMcpToolCount:
      Number.isSafeInteger(record.activeMcpToolCount) && record.activeMcpToolCount >= 0
        ? record.activeMcpToolCount
        : 0,
  }));
}
