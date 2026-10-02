import { ResultAsync } from "neverthrow";
import { brokerError, resolveBrokerCredential } from "./broker-transport.mjs";

/** Proof adapter: Pi owns the single HTTP retry; CP broker owns tokens and refresh. */
export function createNativeAuthRetryTransport({
  url,
  headers = {},
  broker,
  Transport,
  native = true,
}) {
  return new Transport({
    url,
    headers,
    // AuthProvider is a retry hook, not the guest's default OAuth store. Its token()
    // cannot receive fetch's AbortSignal, so the fetch boundary resolves credentials.
    ...(native
      ? { authProvider: { token: async () => undefined, onUnauthorized: async () => {} } }
      : {}),
    fetch: async (input, init) => {
      const credential = await resolveBrokerCredential(broker, init?.signal);
      if (credential.isErr()) throw new Error(credential.error.message);
      const requestHeaders = new Headers(init?.headers);
      requestHeaders.set("Authorization", `Bearer ${credential.value.accessToken}`);
      const fetched = await ResultAsync.fromPromise(
        fetch(input, { ...init, headers: requestHeaders, redirect: "error" }),
        () => brokerError("network"),
      );
      if (fetched.isErr()) throw new Error(fetched.error.message);
      const response = fetched.value;
      if (response.status === 401) broker.rejected?.(credential.value.generation);
      if (response.ok) {
        broker.accepted?.();
        return response;
      }
      // Keep the challenge for Pi's native 403 insufficient_scope decision, but
      // never expose the upstream body through native error rendering.
      await ResultAsync.fromPromise(response.body?.cancel() ?? Promise.resolve(), () =>
        brokerError("network"),
      );
      return new Response("MCP upstream request failed", {
        status: response.status,
        headers: {
          "content-type": "text/plain",
          ...(response.headers.has("www-authenticate")
            ? { "www-authenticate": response.headers.get("www-authenticate") }
            : {}),
        },
      });
    },
  });
}
