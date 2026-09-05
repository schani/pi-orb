import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getSystem, probeSession } from "./api.ts";
import { readBrowserSession, resetBrowserSessionForTest } from "./session.ts";

describe("API session handling", () => {
  beforeEach(resetBrowserSessionForTest);
  afterEach(() => vi.unstubAllGlobals());

  it("asks IAP for an AJAX 401 and classifies an HTML 401 as expired auth", async () => {
    const fetchMock = vi.fn(async (_path: string, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("x-requested-with")).toBe("XMLHttpRequest");
      return new Response("<title>Sign in</title>", {
        status: 401,
        headers: { "content-type": "text/html" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await probeSession();

    expect(result.isErr() && result.error.type).toBe("auth_required");
    expect(readBrowserSession().status).toBe("auth_required");
  });

  it("restores session state when a later probe reaches the application", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("", { status: 401 })),
    );
    await probeSession();

    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ status: "ok" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      ),
    );
    const result = await probeSession();

    expect(result.isOk()).toBe(true);
    expect(readBrowserSession()).toEqual({ status: "active" });
  });

  it("rejects a system response that does not match the closed schema", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ hostProvider: "kubernetes", databaseKind: "postgres" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      ),
    );

    const result = await getSystem();

    expect(result.isErr() && result.error.type).toBe("invalid_response");
  });

  it("reads the deployment facts the dashboard footer states", async () => {
    const system = { hostProvider: "process", databaseKind: "pglite", version: "0.0.1" };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (path: string) => {
        expect(path).toBe("/api/v1/system");
        return new Response(JSON.stringify(system), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );

    const result = await getSystem();

    expect(result.isOk() && result.value).toEqual(system);
  });
});
