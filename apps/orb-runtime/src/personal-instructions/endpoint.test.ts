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
it("preserves the wrapper error scope", async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("PRIVATE", { status: 401 }));
  expect((await fetchPersonalInstructions(env, fetcher))._unsafeUnwrapErr()).toEqual({
    type: "instructions_fetch_error",
    message: "Cannot load personal instructions: HTTP 401",
    retryable: false,
  });
  expect(fetcher).toHaveBeenCalledOnce();
});
