import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getCommittedImage, getSystem, listHostedFiles, probeSession } from "./api.ts";
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
          new Response(
            JSON.stringify({
              status: "ok",
              principal: { kind: "user", user: { id: "user-1", email: null } },
            }),
            {
              status: 200,
              headers: { "content-type": "application/json" },
            },
          ),
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

  it("reads exact committed image bytes using the encoded private URL and AJAX session header", async () => {
    const bytes = new Uint8Array([0, 255, 137, 80, 78, 71, 1]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (path: string, init?: RequestInit) => {
        expect(path).toBe("/api/v1/orbs/orb%2F1/images/record%2F1/key%3A0/2?sessionId=session%2F1");
        expect(init?.cache).toBe("no-store");
        expect(new Headers(init?.headers).get("x-requested-with")).toBe("XMLHttpRequest");
        return new Response(bytes, { headers: { "content-type": "image/png" } });
      }),
    );
    const result = await getCommittedImage("orb/1", "record/1", "key:0", 2, "session/1");
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.type).toBe("image/png");
      expect(new Uint8Array(await result.value.arrayBuffer())).toEqual(bytes);
    }
  });

  it("accepts only supported image MIME types", async () => {
    for (const mime of ["image/png", "image/jpeg", "image/gif", "image/webp"]) {
      vi.stubGlobal(
        "fetch",
        vi.fn(
          async () =>
            new Response(new Uint8Array([4, 3, 2]), {
              headers: { "content-type": mime },
            }),
        ),
      );
      const result = await getCommittedImage("a", "r", "k", 0, "s");
      expect(result.isOk() && result.value.type).toBe(mime);
    }
  });

  it("rejects unexpected MIME and maps fetch/blob failures to typed API errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );
    const offline = await getCommittedImage("a", "r", "k", 0, "s");
    expect(offline.isErr() && offline.error.type).toBe("network");
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("bad", {
            headers: { "content-type": "text/html" },
          }),
      ),
    );
    const invalid = await getCommittedImage("a", "r", "k", 0, "s");
    expect(invalid.isErr() && invalid.error.type).toBe("invalid_response");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        status: 200,
        ok: true,
        headers: new Headers({ "content-type": "image/webp" }),
        blob: async () => {
          throw new Error("stream failed");
        },
      })),
    );
    const failed = await getCommittedImage("a", "r", "k", 0, "s");
    expect(failed.isErr() && failed.error.type).toBe("network");
  });

  it("classifies binary image 401 and typed HTTP failures", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("signin", { status: 401 })),
    );
    const expired = await getCommittedImage("a", "r", "k", 0, "s");
    expect(expired.isErr() && expired.error.type).toBe("auth_required");
    expect(readBrowserSession().status).toBe("auth_required");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          {
            error: { code: "not_found", message: "not found", retryable: false },
          },
          { status: 404 },
        ),
      ),
    );
    const missing = await getCommittedImage("a", "r", "k", 0, "s");
    expect(missing.isErr() && missing.error).toMatchObject({
      type: "http",
      status: 404,
      code: "not_found",
    });
  });

  it("validates the hosted-file inventory and encodes the orb id", async () => {
    const inventory = {
      files: [
        {
          path: "site/index.html",
          url: "https://files.test/s/orb/site/index.html",
          size: 42,
          mediaType: "text/html",
          updatedAt: 1,
        },
      ],
      cleanupIssues: [{ path: null, lastError: "cleanup failed", lastErrorAt: 2 }],
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (path: string) => {
        expect(path).toBe("/api/v1/orbs/orb%2Farchived/hosted-files");
        return Response.json(inventory);
      }),
    );
    const result = await listHostedFiles("orb/archived");
    expect(result.isOk() && result.value).toEqual(inventory);
  });
});
