import { expect, it, vi } from "vitest";
import { fetchInstructions } from "./endpoint.ts";

const env = { controlPlaneUrl: "https://cp.example", runtimeToken: "test-token" };

it.each([401, 403, 404, 409, 500, 503])(
  "maps HTTP %s once without private bodies",
  async (status) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("PRIVATE", { status }));
    const error = (await fetchInstructions(env, "personal", fetcher))._unsafeUnwrapErr();
    expect(error).toEqual({
      type: "instructions_fetch_error",
      message: `Cannot load personal instructions: HTTP ${status}`,
      retryable: status >= 500,
    });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(JSON.stringify(error)).not.toContain("PRIVATE");
  },
);

it.each([
  ["transport", () => Promise.reject(new Error("PRIVATE")), true, "control plane unavailable"],
  ["JSON", async () => new Response("PRIVATE"), false, "invalid snapshot"],
  [
    "NUL",
    async () => Response.json({ content: "PRIVATE\0", revision: 1 }),
    false,
    "invalid snapshot",
  ],
  [
    "revision",
    async () => Response.json({ content: "PRIVATE", revision: -1 }),
    false,
    "invalid snapshot",
  ],
  [
    "shape",
    async () => Response.json({ content: "PRIVATE", revision: 1, extra: true }),
    false,
    "invalid snapshot",
  ],
] as const)("sanitizes %s failure", async (_name, response, retryable, message) => {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(response);
  expect((await fetchInstructions(env, "personal", fetcher))._unsafeUnwrapErr()).toEqual({
    type: "instructions_fetch_error",
    message: `Cannot load personal instructions: ${message}`,
    retryable,
  });
  expect(fetcher).toHaveBeenCalledOnce();
});
