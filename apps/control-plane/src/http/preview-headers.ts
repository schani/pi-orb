import type { PreviewHeaders } from "../domain/preview-transport.ts";

const PLATFORM_IDENTITY = new Set([
  "x-goog-iap-jwt-assertion",
  "x-goog-authenticated-user-email",
  "x-goog-authenticated-user-id",
  "x-serverless-authorization",
]);

const HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);
function withoutHop(headers: PreviewHeaders): Array<[string, string]> {
  const nominated = new Set(
    headers
      .filter(([name]) => name.toLowerCase() === "connection")
      .flatMap(([, value]) => value.split(",").map((token) => token.trim().toLowerCase())),
  );
  return headers
    .filter(([name]) => !HOP.has(name.toLowerCase()) && !nominated.has(name.toLowerCase()))
    .map(([name, value]) => [name.toLowerCase(), value]);
}
export function previewRequestHeaders(
  headers: PreviewHeaders,
  origin: string,
): Array<[string, string]> {
  const result: Array<[string, string]> = [];
  for (const [name, value] of withoutHop(headers)) {
    if (
      name === "host" ||
      name === "forwarded" ||
      name.startsWith("x-forwarded-") ||
      name.startsWith("x-pi-orb-") ||
      PLATFORM_IDENTITY.has(name) ||
      name.startsWith("sec-websocket-")
    )
      continue;
    if (name === "cookie") {
      const filtered = value
        .split(";")
        .map((cookie) => cookie.trim())
        .filter((cookie) => !cookie.startsWith("__Host-pi-orb-"))
        .join("; ");
      if (filtered !== "") result.push([name, filtered]);
    } else result.push([name, value]);
  }
  const parsed = new URL(origin);
  result.push(
    ["host", parsed.host],
    ["x-forwarded-host", parsed.host],
    ["x-forwarded-proto", parsed.protocol.slice(0, -1)],
  );
  return result;
}
export function previewResponseHeaders(headers: PreviewHeaders): Array<[string, string]> {
  return withoutHop(headers).filter(
    ([name, value]) =>
      !name.startsWith("x-pi-orb-") &&
      !PLATFORM_IDENTITY.has(name) &&
      !(
        name === "set-cookie" &&
        (value.trim().startsWith("__Host-pi-orb-") || /(?:^|;)\s*domain\s*=/iu.test(value))
      ),
  );
}
