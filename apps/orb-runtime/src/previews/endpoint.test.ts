import { afterEach, expect, it, vi } from "vitest";
import { requestPreviews } from "./endpoint.ts";

const env = { controlPlaneUrl: "https://control.test", runtimeToken: "secret" };
afterEach(() => vi.unstubAllGlobals());
it("uses runtime-authenticated PUT DELETE and GET registration endpoints", async () => {
  const fetch = vi.fn().mockResolvedValue(
    new Response(
      JSON.stringify({
        preview: { port: 5173, registrationId: "r1", url: "https://preview.test" },
      }),
      { status: 200 },
    ),
  );
  vi.stubGlobal("fetch", fetch);
  expect((await requestPreviews(env, { type: "expose", port: 5173 })).isOk()).toBe(true);
  expect(fetch.mock.calls[0]?.[0]).toBe("https://control.test/runtime/previews/5173");
  expect(fetch.mock.calls[0]?.[1]).toMatchObject({
    method: "PUT",
    headers: { authorization: "Bearer secret" },
  });
  fetch.mockResolvedValueOnce(new Response(null, { status: 204 }));
  expect((await requestPreviews(env, { type: "unexpose", port: 5173 })).isOk()).toBe(true);
  expect(fetch.mock.calls[1]?.[1]).toMatchObject({ method: "DELETE" });
  fetch.mockResolvedValueOnce(new Response(JSON.stringify({ previews: [] }), { status: 200 }));
  expect((await requestPreviews(env, { type: "previews", json: true })).isOk()).toBe(true);
  expect(fetch.mock.calls[2]?.[0]).toBe("https://control.test/runtime/previews");
  expect(fetch.mock.calls[2]?.[1]).toMatchObject({ method: "GET" });
});
it("reports configured denial and rejects malformed success", async () => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: {
              type: "preview_error",
              code: "preview_disabled",
              message: "HTTP previews are not configured",
            },
          }),
          { status: 503 },
        ),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ preview: {} }), { status: 200 })),
  );
  expect(
    (await requestPreviews(env, { type: "expose", port: 5173 }))._unsafeUnwrapErr().message,
  ).toBe("HTTP previews are not configured");
  expect((await requestPreviews(env, { type: "expose", port: 5173 })).isErr()).toBe(true);
});
