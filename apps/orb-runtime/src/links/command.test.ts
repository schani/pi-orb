import { describe, expect, it } from "vitest";
import { parseLinkArgs, requestLink } from "./command.ts";

const env = { controlPlaneUrl: "https://cp.test", runtimeToken: "tok" };

describe("link CLI", () => {
  it("parses one URL", () => {
    expect(parseLinkArgs(["https://github.com/o/r/pull/1"])._unsafeUnwrap()).toBe(
      "https://github.com/o/r/pull/1",
    );
    for (const args of [[], ["a", "b"]]) expect(parseLinkArgs(args).isErr()).toBe(true);
  });

  it("registers the link with the runtime bearer and prints the canonical URL", async () => {
    const calls: [string, RequestInit][] = [];
    const fetcher = (async (url: string, init: RequestInit) => {
      calls.push([url, init]);
      return Response.json({ url: "https://github.com/o/r/pull/1" });
    }) as typeof fetch;
    expect(
      (await requestLink(env, "https://github.com/o/r/pull/1/files", fetcher))._unsafeUnwrap(),
    ).toBe("https://github.com/o/r/pull/1");
    expect(calls[0]?.[0]).toBe("https://cp.test/runtime/v1/orb/links");
    expect(calls[0]?.[1].method).toBe("PUT");
    expect(new Headers(calls[0]?.[1].headers).get("authorization")).toBe("Bearer tok");
  });

  it("reports the control plane's message", async () => {
    const fetcher = (async () =>
      Response.json(
        { v: 1, error: { message: "expected a GitHub URL" } },
        { status: 400 },
      )) as typeof fetch;
    expect((await requestLink(env, "x", fetcher))._unsafeUnwrapErr()).toBe("expected a GitHub URL");
    const offline = (async () => {
      throw new Error("offline");
    }) as typeof fetch;
    expect((await requestLink(env, "x", offline))._unsafeUnwrapErr()).toBe("link request failed");
  });
});
