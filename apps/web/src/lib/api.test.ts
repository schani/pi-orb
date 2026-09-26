import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getSystem, listHostedFiles, logout, probeSession } from "./api.ts";
import { readBrowserSession, readSessionPrincipal, resetBrowserSessionForTest } from "./session.ts";

describe("API session handling", () => {
  beforeEach(resetBrowserSessionForTest);
  afterEach(() => vi.unstubAllGlobals());

  it("classifies an HTML 401 as missing auth without provider-specific headers", async () => {
    const fetchMock = vi.fn(async (_path: string, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("x-requested-with")).toBeNull();
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

  it.each([403, 503])("does not recover an expired session on HTTP %i", async (status) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 401 })),
    );
    await probeSession();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status })),
    );
    await probeSession();
    expect(readBrowserSession().status).toBe("auth_required");
  });

  it("keeps the principal on provider failure and forbidden logout", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          status: "ok",
          principal: { kind: "user", user: { id: "alice", email: null } },
        }),
      ),
    );
    await probeSession();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 503 })),
    );
    await probeSession();
    expect(readSessionPrincipal()).toBe("user:alice");
    expect(readBrowserSession().status).toBe("active");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 403 })),
    );
    expect((await logout()).isErr()).toBe(true);
    expect(readSessionPrincipal()).toBe("user:alice");
  });

  it("cannot restore Alice from a response body held across Bob's login", async () => {
    let release!: (value: unknown) => void;
    const body = new Promise((resolve) => {
      release = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ status: 200, ok: true, json: () => body })),
    );
    const alice = probeSession();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          status: "ok",
          principal: { kind: "user", user: { id: "bob", email: null } },
        }),
      ),
    );
    await probeSession();
    release({ status: "ok", principal: { kind: "user", user: { id: "alice", email: null } } });
    expect((await alice).isErr()).toBe(true);
    expect(readSessionPrincipal()).toBe("user:bob");
  });

  it("fences a response body held across logout", async () => {
    let release!: (body: unknown) => void;
    const body = new Promise((resolve) => {
      release = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (path: string, init?: RequestInit) => {
        if (path === "/auth/logout") {
          expect(init?.method).toBe("POST");
          return new Response(null, { status: 204 });
        }
        return { status: 200, ok: true, json: () => body };
      }),
    );
    const old = getSystem();
    await logout();
    release({ hostProvider: "process", databaseKind: "pglite", version: "old" });
    expect((await old).isErr()).toBe(true);
    expect(readBrowserSession().status).toBe("auth_required");
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
