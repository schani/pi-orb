// Diagnostic-only: capture before transport construction; arm only after a real broker grant.
// Never store Authorization values or provider response bodies.
export function installOneRejectedReadPost(serverUrl) {
  const original = globalThis.fetch;
  let armed = false;
  let injected = 0;
  let toolPosts = 0;
  const upstreamStatuses = [];
  globalThis.fetch = async (input, init) => {
    const body = init?.body;
    let toolCall = false;
    if (typeof body === "string") {
      try {
        toolCall = JSON.parse(body)?.method === "tools/call";
      } catch {
        /* not a tool call */
      }
    }
    if (!armed || String(input) !== serverUrl || init?.method !== "POST" || !toolCall)
      return original(input, init);
    toolPosts++;
    const headers = new Headers(init.headers);
    if (injected === 0) {
      // This fetch hook must reject a request lacking the proved grant, not forward it.
      if (!headers.get("Authorization")?.startsWith("Bearer "))
        throw new Error("MCP grant not present at fault boundary");
      headers.set("Authorization", "Bearer pi-orb-qualification-invalid");
      injected++;
    }
    const response = await original(input, { ...init, headers });
    upstreamStatuses.push(response.status);
    return response;
  };
  return {
    arm: () => {
      armed = true;
    },
    evidence: () => ({ injected, toolPosts, upstreamStatuses: [...upstreamStatuses] }),
    restore: () => {
      globalThis.fetch = original;
    },
  };
}
