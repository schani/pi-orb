// Embedded into local verification and remote token probes by the identity smoke.
async function smokeFetch(url, init = {}, deadline = Date.now() + 60_000, deps = {}) {
  const now = deps.now ?? (() => performance.now());
  const wall = deps.wall ?? Date.now;
  const timeoutSignal = deps.timeoutSignal ?? ((ms) => AbortSignal.timeout(ms));
  const sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const log = deps.log ?? ((line) => console.error(line));
  const fetcher = deps.fetch ?? fetch;
  deadline = now() + Math.min(60_000, deadline - wall());
  const transient = new Set([408, 429, 500, 502, 503, 504]);
  const transport = new Set([
    "ECONNRESET",
    "ECONNREFUSED",
    "ENOTFOUND",
    "EAI_AGAIN",
    "ETIMEDOUT",
    "EPIPE",
    "UND_ERR_SOCKET",
    "UND_ERR_CONNECT_TIMEOUT",
    "UND_ERR_HEADERS_TIMEOUT",
    "UND_ERR_BODY_TIMEOUT",
  ]);
  for (let attempt = 1; attempt <= 5; attempt++) {
    const remaining = deadline - now();
    if (remaining <= 0) {
      log(`smoke-fetch: attempt=${attempt} outcome=deadline`);
      return { error: { kind: "deadline" } };
    }
    let status = 0,
      type = "missing",
      body,
      headers,
      retry = false;
    const signal = timeoutSignal(Math.max(1, Math.ceil(Math.min(30_000, remaining))));
    try {
      const response = await fetcher(url, {
        ...init,
        redirect: "manual",
        signal,
      });
      status = response.status;
      headers = response.headers;
      const contentType = headers.get("content-type") ?? "";
      type = contentType.includes("json")
        ? "json"
        : contentType.includes("html")
          ? "html"
          : "other";
      // Consume the body inside the same request timeout.
      const text = await response.text();
      if (now() >= deadline) {
        log(`smoke-fetch: attempt=${attempt} http=${status} content_type=${type} outcome=deadline`);
        return { error: { kind: "deadline", status } };
      }
      try {
        body = JSON.parse(text);
      } catch {
        body = null;
      }
      if (status >= 200 && status < 300) {
        if (attempt > 1)
          log(
            `smoke-fetch: attempt=${attempt} http=${status} content_type=${type} outcome=recovered`,
          );
        return { value: { status, body } };
      }
      retry = transient.has(status);
      if (typeof body?.error?.retryable === "boolean") retry = body.error.retryable;
      if (["internal", "invalid_request", "unauthorized", "not_mintable"].includes(body?.error))
        retry = false;
      if (["retryable", "rate_limited"].includes(body?.error)) retry = true;
      if ((status >= 300 && status < 400) || [401, 403, 404].includes(status)) retry = false;
    } catch (error) {
      retry =
        (signal.aborted && signal.reason?.name === "TimeoutError") ||
        error?.name === "TimeoutError" ||
        transport.has(error?.cause?.code);
    }
    const edge = `smoke-fetch: attempt=${attempt} http=${status} content_type=${type}`;
    if (!retry) {
      log(`${edge} outcome=terminal`);
      return status >= 400 && status < 500
        ? { value: { status, body } }
        : { error: { kind: "terminal", status } };
    }
    let delay = 1000 * 2 ** (attempt - 1);
    if (Number.isFinite(body?.retryAfterMs)) delay = Math.max(delay, body.retryAfterMs);
    const after = headers?.get("retry-after");
    if (after) {
      const duration = /^\d+$/.test(after) ? Number(after) * 1000 : Date.parse(after) - wall();
      if (Number.isFinite(duration)) delay = Math.max(delay, duration);
    }
    const budgetRemaining = Math.max(0, deadline - now());
    const outcome = attempt === 5 ? "exhausted" : delay >= budgetRemaining ? "deadline" : "retry";
    log(`${edge} outcome=${outcome} delay_ms=${delay} remaining_ms=${budgetRemaining}`);
    if (outcome !== "retry") return { error: { kind: outcome, status } };
    await sleep(delay);
  }
}
module.exports = { smokeFetch };
