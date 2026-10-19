// Shared by the local verifier and the in-orb revocation probe.
const retryHttp = new Set([408, 429, 500, 502, 503, 504]);
const transientCodes = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET",
]);
const terminalCodes = new Set([
  "ENOTFOUND",
  "CERT_HAS_EXPIRED",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "SELF_SIGNED_CERT_IN_CHAIN",
]);

async function smokeJson(operation, url, options = {}, deps = {}) {
  const now = deps.now || (() => performance.now());
  const wall = deps.wall || Date.now;
  const sleep = deps.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const log = deps.log || ((line) => process.stderr.write(`${line}\n`));
  const request = deps.fetch || fetch;
  const started = now();
  const deadline = Math.min(
    started + 60000,
    deps.deadline ?? started + Number(process.env.PI_ORB_SMOKE_DEADLINE) * 1000 - wall(),
  );
  if (!["discovery", "jwks", "probe"].includes(operation) || !Number.isFinite(deadline)) {
    log("smoke-http: operation=invalid phase=http error=config outcome=terminal");
    return { ok: false };
  }
  for (let attempt = 1; attempt <= 5; attempt++) {
    let status = 0,
      category = "timeout",
      retry = false,
      delay = 1000 * 2 ** (attempt - 1);
    const remaining = deadline - now();
    if (remaining <= 0) {
      log(
        `smoke-http: operation=${operation} phase=http attempt=${attempt} error=timeout outcome=deadline remaining_s=0 elapsed_s=${(now() - started) / 1000}`,
      );
      return { ok: false };
    }
    // One signal covers headers AND body consumption. JSON/claims failures are
    // assertions, not transport errors, and cannot trigger another request.
    const signal = (deps.signal || AbortSignal.timeout)(
      Math.max(1, Math.ceil(Math.min(30000, remaining))),
    );
    let text;
    try {
      const response = await request(url, { ...options, signal, redirect: "error" });
      status = response.status;
      text = await response.text();
      const after = response.headers.get("retry-after");
      if (after) {
        const seconds = /^\d+$/.test(after)
          ? Number(after)
          : Math.max(0, (Date.parse(after) - wall()) / 1000);
        if (Number.isFinite(seconds)) delay = Math.max(delay, seconds * 1000);
      }
      retry = retryHttp.has(status);
      category = retry ? "http_transient" : "http_terminal";
    } catch (error) {
      const codes = [error?.code, error?.cause?.code];
      category = codes.some((code) => terminalCodes.has(code))
        ? "transport_terminal"
        : error?.name === "TimeoutError" || signal.aborted
          ? "timeout"
          : codes.some((code) => transientCodes.has(code))
            ? "transport_transient"
            : "unknown";
      retry = category === "timeout" || category === "transport_transient";
      if (status >= 400 && !retryHttp.has(status)) {
        category = "http_terminal";
        retry = false;
      }
    }
    if (text !== undefined && status >= 400) {
      try {
        const error = JSON.parse(text)?.error;
        const typed = typeof error === "string" ? error : error?.status;
        if (
          error?.retryable === false ||
          [
            "PERMISSION_DENIED",
            "UNAUTHENTICATED",
            "invalid_grant",
            "invalid_target",
            "unauthorized_client",
            "invalid_request",
            "internal",
          ].includes(typed)
        ) {
          category = "typed_terminal";
          retry = false;
        }
      } catch {
        // Non-JSON proxy responses retain the explicit HTTP classification.
      }
    }
    let result;
    if (
      text !== undefined &&
      ((status >= 200 && status < 300) || (operation === "probe" && [401, 403].includes(status)))
    ) {
      try {
        result = { ok: true, status, body: JSON.parse(text) };
      } catch {
        category = "json";
        retry = false;
      }
    }
    const left = Math.max(0, deadline - now());
    const outcome =
      left <= 0
        ? "deadline"
        : result
          ? attempt > 1
            ? "recovered"
            : "ok"
          : category === "unknown"
            ? "unknown"
            : !retry
              ? "terminal"
              : attempt === 5
                ? "exhausted"
                : delay >= left
                  ? "deadline"
                  : "retry";
    if (outcome !== "ok")
      log(
        `smoke-http: operation=${operation} phase=http attempt=${attempt} http=${status} error=${category} elapsed_s=${(now() - started) / 1000} remaining_s=${left / 1000} delay_s=${outcome === "retry" ? delay / 1000 : 0} outcome=${outcome}`,
      );
    if (outcome !== "retry")
      return outcome === "ok" || outcome === "recovered" ? result : { ok: false };
    await sleep(delay);
  }
  return { ok: false };
}

module.exports = { smokeJson };
