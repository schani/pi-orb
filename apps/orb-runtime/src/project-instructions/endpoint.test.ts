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
it.each([401, 409, 503])(
  "HTTP %s is a visible typed failure, not empty success",
  async (status) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("failure", { status }));
    const error = (await fetchProjectInstructions(env, fetcher))._unsafeUnwrapErr();
    expect(error.retryable).toBe(status >= 500);
    expect(error.message).toContain("project instructions");
    expect(fetcher).toHaveBeenCalledTimes(1);
  },
);
it("catches transport/JSON and invalid persisted content at the adapter boundary", async () => {
  for (const fetcher of [
    vi.fn<typeof fetch>().mockRejectedValue(new Error("private network detail")),
    vi.fn<typeof fetch>().mockResolvedValue(new Response("invalid")),
    vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify({ content: "bad\0", revision: 1 }))),
  ]) {
    const error = (await fetchProjectInstructions(env, fetcher))._unsafeUnwrapErr();
    expect(error.message).not.toContain("private network detail");
    expect(fetcher).toHaveBeenCalledTimes(1);
  }
});
