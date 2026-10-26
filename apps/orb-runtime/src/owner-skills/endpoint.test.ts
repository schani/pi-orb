import { expect, it, vi } from "vitest";
import { fetchOwnerSkills } from "./endpoint.ts";

const env = { controlPlaneUrl: "https://cp.example", runtimeToken: "runtime-secret" };
const snapshot = {
  skills: [{ name: "release-notes", content: "---\nname: release-notes\ndescription: d\n---\n" }],
};

it("uses a bounded authenticated GET and validates the exact snapshot", async () => {
  const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(snapshot)));
  expect((await fetchOwnerSkills(env, fetcher))._unsafeUnwrap()).toEqual(snapshot);
  expect(fetcher).toHaveBeenCalledOnce();
  expect(fetcher.mock.calls[0]).toEqual([
    "https://cp.example/runtime/v1/owner-skills",
    expect.objectContaining({
      headers: { authorization: "Bearer runtime-secret" },
      signal: expect.any(AbortSignal),
    }),
  ]);
});

it.each([
  ["HTTP 401", async () => new Response("PRIVATE", { status: 401 }), false],
  ["HTTP 503", async () => new Response("{}", { status: 503 }), true],
  [
    "invalid snapshot",
    async () => new Response(JSON.stringify({ skills: [{ name: "../x", content: "" }] })),
    false,
  ],
  ["invalid snapshot", async () => new Response("not json"), false],
  [
    "control plane unavailable",
    async () => {
      throw new TypeError("fetch failed");
    },
    true,
  ],
] as const)("reports %s with its retryability", async (message, respond, retryable) => {
  const fetcher = vi.fn<typeof fetch>(respond);
  expect((await fetchOwnerSkills(env, fetcher))._unsafeUnwrapErr()).toEqual({
    type: "owner_skills_fetch_error",
    message: `Cannot load owner skills: ${message}`,
    retryable,
  });
});
