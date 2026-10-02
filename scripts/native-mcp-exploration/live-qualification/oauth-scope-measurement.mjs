// Optional diagnostic fetch wrapper for the existing OAuth SDK adapter. Never sends a request itself.
import { err, ok, Result } from "neverthrow";

export const MAX_BYTES = 64 * 1024;
const PUBLIC_SCOPES = new Set(["mcp_all"]);
// RFC 6749 scope-token = %x21 / %x23-5B / %x5D-7E; separator is one ASCII space.
const SCOPE_LIST = /^[\x21\x23-\x5B\x5D-\x7E]+(?: [\x21\x23-\x5B\x5D-\x7E]+)*$/;
const DISALLOWED_SCOPE_CHAR = /[^\x21\x23-\x5B\x5D-\x7E ]/;
const NON_SPACE_WHITESPACE =
  /[\t\n\v\f\r\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]/;

function invalidScope(kind, scope) {
  const isString = typeof scope === "string";
  return {
    kind,
    outcome: "invalid",
    invalidReason: !isString ? "non_string" : !scope ? "empty" : "invalid_syntax",
    boundaryWhitespace: isString && (scope.startsWith(" ") || scope.endsWith(" ")),
    nonSpaceWhitespace: isString && NON_SPACE_WHITESPACE.test(scope),
    disallowedCharacter: isString && DISALLOWED_SCOPE_CHAR.test(scope),
  };
}

export function observeTokenResponses(fetcher, { tokenEndpoint, knownScopes, record }) {
  const parsed = Result.fromThrowable(
    () => new URL(tokenEndpoint),
    () => ({ type: "invalid_configuration" }),
  )();
  if (parsed.isErr()) return parsed;
  const endpoint = parsed.value;
  if (
    typeof fetcher !== "function" ||
    endpoint.protocol !== "https:" ||
    endpoint.username ||
    endpoint.password ||
    endpoint.hash ||
    !Array.isArray(knownScopes) ||
    knownScopes.some((scope) => !PUBLIC_SCOPES.has(scope)) ||
    typeof record !== "function"
  )
    return err({ type: "invalid_configuration" });
  const allowed = new Set(knownScopes);
  // Implements the platform fetch contract: upstream rejection propagates unchanged.
  return ok(async (input, init) => {
    // SDK supplies URLSearchParams; only inspect the grant type, never record request values.
    const body = init?.body;
    const form =
      body instanceof URLSearchParams && body.toString().length < 4096
        ? body
        : typeof body === "string" && body.length < 4096
          ? new URLSearchParams(body)
          : null;
    const kind = form?.get("grant_type");
    const eligible =
      String(input) === endpoint.href &&
      init?.method?.toUpperCase() === "POST" &&
      (kind === "authorization_code" || kind === "refresh_token") &&
      form.getAll("grant_type").length === 1;
    const response = await fetcher(input, init);
    if (!eligible) return response;
    let metric = { kind, outcome: "unverified" };
    let reader;
    try {
      if (!response.ok) metric = { kind, outcome: "http_error" };
      else {
        reader = response.clone().body?.getReader();
        if (reader) {
          const chunks = [];
          let size = 0;
          let exceeded = false;
          const deadline = AbortSignal.timeout(2000);
          const timeout = new Promise((_, reject) =>
            deadline.addEventListener("abort", () => reject(new Error("measurement_timeout")), {
              once: true,
            }),
          );
          for (;;) {
            const next = await Promise.race([reader.read(), timeout]);
            if (next.done) break;
            size += next.value.byteLength;
            if (size > MAX_BYTES) {
              exceeded = true;
              void reader.cancel().catch(() => {});
              break;
            }
            chunks.push(next.value);
          }
          if (exceeded) metric = { kind, outcome: "oversize" };
          else {
            const payload = JSON.parse(new TextDecoder().decode(Buffer.concat(chunks)));
            if (payload && typeof payload === "object" && !Array.isArray(payload)) {
              if (Object.hasOwn(payload, "error")) metric = { kind, outcome: "oauth_error" };
              else if (
                typeof payload.access_token !== "string" ||
                !payload.access_token ||
                typeof payload.token_type !== "string" ||
                payload.token_type.toLowerCase() !== "bearer" ||
                typeof payload.expires_in !== "number" ||
                !Number.isFinite(payload.expires_in) ||
                payload.expires_in <= 0
              )
                metric = { kind, outcome: "invalid_response" };
              else if (!Object.hasOwn(payload, "scope")) metric = { kind, outcome: "omitted" };
              else if (typeof payload.scope === "string" && SCOPE_LIST.test(payload.scope)) {
                const scopes = [...new Set(payload.scope.split(" "))];
                metric = {
                  kind,
                  outcome: "present",
                  knownScopes: scopes.filter((s) => allowed.has(s)),
                  unknownCount: scopes.filter((s) => !allowed.has(s)).length,
                };
              } else metric = invalidScope(kind, payload.scope);
            }
          }
        }
      }
    } catch {
      void reader?.cancel().catch(() => {});
      /* Diagnostics must never change the SDK's OAuth outcome. */
    }
    try {
      void Promise.resolve(record(metric)).catch(() => {});
    } catch {
      /* Recording is noncritical. */
    }
    return response;
  });
}
