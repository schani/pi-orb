import { StreamableHttpTransport } from "@earendil-works/pi-mcp";

/** Node's public ESM resolver with a parent URL (requires --experimental-import-meta-resolve). */
export async function piOwnedTransport() {
  const sdkUrl = import.meta.resolve("@earendil-works/pi-coding-agent");
  return (await import(import.meta.resolve("@earendil-works/pi-mcp", sdkUrl)))
    .StreamableHttpTransport;
}

import { err, ok, ResultAsync } from "neverthrow";

export const brokerError = (code) => ({ code, message: "MCP credential unavailable" });

/** Exploration port: broker.resolve() returns an access token; not the production resolver. */
export async function resolveBrokerCredential(broker, signal) {
  const resolved = await ResultAsync.fromPromise(
    Promise.resolve().then(() => broker.resolve(signal)),
    () => brokerError("unavailable"),
  );
  if (resolved.isErr()) return err(resolved.error);
  if (resolved.value.isErr()) return err(brokerError("unavailable"));
  if (!resolved.value.value?.accessToken) return err(brokerError("unavailable"));
  return ok(resolved.value.value);
}

export function createBrokerTransport({
  url,
  headers = {},
  broker,
  Transport = StreamableHttpTransport,
}) {
  const transport = new Transport({
    url,
    // No authProvider: a 401 cannot trigger Pi's same-request OAuth replay or guest consent/store.
    headers,
    fetch: async (input, init) => {
      const token = await resolveBrokerCredential(broker, init?.signal);
      // Fetch's required exception boundary: no raw broker errors or secrets escape.
      if (token.isErr()) throw new Error(token.error.message);
      const requestHeaders = new Headers(init?.headers);
      requestHeaders.set("Authorization", `Bearer ${token.value.accessToken}`);
      const fetched = await ResultAsync.fromPromise(
        fetch(input, { ...init, headers: requestHeaders, redirect: "error" }),
        () => brokerError("network"),
      );
      if (fetched.isErr()) throw new Error(fetched.error.message);
      const response = fetched.value;
      if (response.status === 401) broker.rejected?.(token.value.generation);
      if (response.ok) {
        broker.accepted?.();
        return response;
      }
      // Native errors embed remote response bodies; replace them before native parsing.
      return new Response("MCP upstream request failed", {
        status: response.status,
        headers: {
          "content-type": "text/plain",
          ...(response.headers.has("www-authenticate") ? { "www-authenticate": "Bearer" } : {}),
        },
      });
    },
  });
  return transport;
}
