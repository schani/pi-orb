import { expect, it, vi } from "vitest";
import { fetchPersonalInstructions } from "./endpoint.ts";

const env = { controlPlaneUrl: "https://cp.example", runtimeToken: "runtime-secret" };

it("uses a bounded authenticated GET and validates the exact snapshot", async () => {
  const fetcher = vi.fn<typeof fetch>(
    async () => new Response(JSON.stringify({ content: "# Me\n", revision: 3 })),
  );
  expect((await fetchPersonalInstructions(env, fetcher))._unsafeUnwrap()).toEqual({
    content: "# Me\n",
    revision: 3,
  });
  expect(fetcher).toHaveBeenCalledOnce();
  expect(fetcher.mock.calls[0]).toEqual([
    "https://cp.example/runtime/v1/personal-instructions",
    expect.objectContaining({
      headers: { authorization: "Bearer runtime-secret" },
      signal: expect.any(AbortSignal),
    }),
  ]);
});
it.each([401, 403, 404, 500, 503])(
  "HTTP %s fails closed without an empty fallback or retry loop",
  async (status) => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response("sensitive details", { status }));
    const result = await fetchPersonalInstructions(env, fetcher);
    expect(result.isErr()).toBe(true);
    expect(JSON.stringify(result)).not.toContain("sensitive details");
    expect(fetcher).toHaveBeenCalledOnce();
  },
);
it("sanitizes network/parse failures and rejects invalid content", async () => {
  for (const fetcher of [
    async () => {
      throw new Error("sensitive transport data");
    },
    async () => new Response("not json"),
    async () => new Response(JSON.stringify({ content: "\0", revision: 1 })),
    async () => new Response(JSON.stringify({ content: "text", revision: -1 })),
  ]) {
    const result = await fetchPersonalInstructions(env, fetcher);
    expect(result.isErr()).toBe(true);
    expect(JSON.stringify(result)).not.toContain("sensitive transport data");
  }
});
