import { NoSimulationTask } from "determined";
import { describe, expect, it } from "vitest";
import { createReleaseActivationReader } from "./release-activation.ts";

const task = new NoSimulationTask("release activation adapter", false);
const stop = new AbortController().signal;
const auth = { getAccessToken: async () => "private-token-sentinel" };

describe("release activation GCS boundary", () => {
  it("reads only the activation object and carries an abort signal", async () => {
    const reader = createReleaseActivationReader("state-bucket", auth, async (url, init) => {
      expect(String(url)).toBe(
        "https://storage.googleapis.com/storage/v1/b/state-bucket/o/static-plane%2Freleases%2Factive.json?alt=media",
      );
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      expect(init?.redirect).toBe("error");
      return Response.json({ generation: 42 });
    });
    expect((await reader.read(task, stop))._unsafeUnwrap()).toBe(42);
  });

  it.each([{}, { generation: -1 }, { generation: 0 }, { generation: "42" }, { generation: 1.5 }])(
    "fails closed on an invalid authority record: %j",
    async (body) => {
      const reader = createReleaseActivationReader("bucket", auth, async () => Response.json(body));
      expect((await reader.read(task, stop)).isErr()).toBe(true);
    },
  );

  it("treats missing authority as waiting, not permission to start", async () => {
    const reader = createReleaseActivationReader(
      "bucket",
      auth,
      async () => new Response(null, { status: 404 }),
    );
    expect((await reader.read(task, stop))._unsafeUnwrap()).toBeNull();
  });

  it("maps upstream exceptions without leaking credential-bearing error details", async () => {
    const reader = createReleaseActivationReader("bucket", auth, () =>
      Promise.reject(new Error("private-token-sentinel")),
    );
    const result = await reader.read(task, stop);
    expect(result._unsafeUnwrapErr()).toEqual({ type: "release_activation_unavailable" });
    expect(JSON.stringify(result)).not.toContain("private-token-sentinel");
  });
});
