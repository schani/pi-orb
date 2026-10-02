// Observe SDK events only; never emit or retain request bodies, tool names, prompts or tokens.
function size(value) {
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch {
    return { status: "unavailable", utf8Bytes: null, codepoints: null };
  }
  if (typeof serialized !== "string")
    return { status: "unavailable", utf8Bytes: null, codepoints: null };
  let codepoints = 0;
  for (const _ of serialized) codepoints++;
  return {
    status: "measured",
    utf8Bytes: Buffer.byteLength(serialized, "utf8"),
    codepoints,
  };
}

export function summarizeContext(messages) {
  return {
    kind: "transcript",
    ...size(messages),
    messageCount: Array.isArray(messages) ? messages.length : null,
    tokenizerEstimate: null,
    exactModelTokens: null,
  };
}

export function summarizePayload(payload) {
  return {
    kind: "provider_payload",
    ...size(payload),
    tokenizerEstimate: null,
    exactModelTokens: null,
  };
}

// `context_with_system` measures transcript JSON, which is not the full provider
// payload: tool declarations may be serialized separately. The active MCP count
// excludes deferred/codemode tools that remain approved and callable.
// Real events require a model turn; manually emitting hooks only verifies wiring.
const phases = new Set(["before_discovery", "after_discovery", "after_search"]);
export function createContextMeasurement(profile, getPhase, output) {
  const safeProfile = profile === "root" || profile === "child" ? profile : "invalid";
  return (pi) => {
    const common = () => {
      let phase;
      try {
        const label = getPhase();
        phase = phases.has(label) ? label : "invalid";
      } catch {
        phase = "invalid";
      }
      return {
        profile: safeProfile,
        phase,
        activeMcpToolCount: pi.getActiveTools().filter((name) => name.startsWith("mcp__")).length,
      };
    };
    pi.on("context_with_system", ({ messages }) => {
      output({ ...common(), ...summarizeContext(messages) });
    });
    pi.on("before_provider_request", ({ payload }) => {
      output({ ...common(), ...summarizePayload(payload) });
    });
  };
}
