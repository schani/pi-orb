import { expect, it, vi } from "vitest";
import { fetchProjectInstructions } from "./endpoint.ts";

const env = { controlPlaneUrl: "https://cp.example", runtimeToken: "test-token" };
it("fetches one authenticated boot snapshot with a deadline and no project selector", async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValue(new Response(JSON.stringify({ content: "# Project", revision: 2 })));
  expect((await fetchProjectInstructions(env, fetcher))._unsafeUnwrap()).toEqual({
    content: "# Project",
    revision: 2,
  });
  expect(fetcher).toHaveBeenCalledExactlyOnceWith(
    "https://cp.example/runtime/v1/project-instructions",
    { headers: { authorization: "Bearer test-token" }, signal: expect.any(AbortSignal) },
  );
});
it("preserves the wrapper error scope", async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("PRIVATE", { status: 401 }));
  expect((await fetchProjectInstructions(env, fetcher))._unsafeUnwrapErr()).toEqual({
    type: "instructions_fetch_error",
    message: "Cannot load project instructions: HTTP 401",
    retryable: false,
  });
  expect(fetcher).toHaveBeenCalledOnce();
});
