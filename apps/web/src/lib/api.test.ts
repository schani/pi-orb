import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getActivityHeadline,
  getCommittedImage,
  getOrbHistory,
  getSystem,
  listHostedFiles,
  listOrbMessages,
  logout,
  probeSession,
} from "./api.ts";
import { readBrowserSession, readSessionPrincipal, resetBrowserSessionForTest } from "./session.ts";

describe("activity headline HTTP", () => {
  beforeEach(resetBrowserSessionForTest);
  afterEach(() => vi.unstubAllGlobals());
  it("posts encoded identity only with the caller's abort signal", async () => {
    const controller = new AbortController();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (path: string, init?: RequestInit) => {
        expect(path).toBe(
          "/api/v1/orbs/orb%2F1/headlines/record%2F1/key%3A0?sessionId=session%2F1",
        );
        expect(init?.method).toBe("POST");
        expect(init?.body).toBeUndefined();
        expect(init?.signal).toBe(controller.signal);
        expect(new Headers(init?.headers).get("x-requested-with")).toBeNull();
        return new Response(JSON.stringify({ headline: "" }));
      }),
    );
    expect(
      (
        await getActivityHeadline("orb/1", "record/1", "key:0", "session/1", controller.signal)
      )._unsafeUnwrap(),
    ).toEqual({ headline: "" });
  });
  it("fences a headline body held across logout", async () => {
    let release!: (value: unknown) => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const body = new Promise<unknown>((resolve) => {
      release = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (path: string) =>
        path === "/auth/logout"
          ? new Response(null, { status: 204 })
          : {
              status: 200,
              ok: true,
              json: () => {
                entered();
                return body;
              },
            },
      ),
    );
    const headline = getActivityHeadline("o", "r", "k", "s", new AbortController().signal);
    await started;
    await logout();
    release({ headline: "Old principal's headline" });
    expect((await headline)._unsafeUnwrapErr().type).toBe("auth_required");
  });

  it("keeps typed CP errors and catches rejected transport at the API boundary", async () => {
    const signal = new AbortController().signal;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              error: { code: "unavailable", message: "unavailable", retryable: true },
            }),
            { status: 503 },
          ),
      ),
    );
    expect((await getActivityHeadline("o", "r", "k", "s", signal))._unsafeUnwrapErr()).toEqual({
      type: "http",
      status: 503,
      code: "unavailable",
      message: "unavailable",
      retryable: true,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new DOMException("aborted", "AbortError");
      }),
    );
    expect((await getActivityHeadline("o", "r", "k", "s", signal))._unsafeUnwrapErr()).toEqual({
      type: "network",
      message: "aborted",
    });
  });
});

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

  it("reads bounded no-store inbox deltas with encoded orb ID and JSON selectors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (path: string, init?: RequestInit) => {
        const url = new URL(path, "http://test");
        expect(url.pathname).toBe("/api/v1/orbs/orb%2Fone/messages/poll");
        expect(url.search).toBe("");
        expect(init?.method).toBe("POST");
        expect(JSON.parse(String(init?.body))).toEqual({ after: 42, tracked: ["m1", "m2"] });
        expect(init?.cache).toBe("no-store");
        expect(init?.signal).toBeInstanceOf(AbortSignal);
        return new Response(JSON.stringify({ items: [], updates: [], cursor: 42 }));
      }),
    );
    expect((await listOrbMessages("orb/one", 42, ["m1", "m2"]))._unsafeUnwrap()).toEqual({
      items: [],
      updates: [],
      cursor: 42,
    });
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

  it("fences streamed history when logout happens after headers", async () => {
    let release!: () => void;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"orbId":"old","records":'));
        release = () => {
          controller.enqueue(new TextEncoder().encode("[]}"));
          controller.close();
        };
      },
    });
    let bodyStarted!: () => void;
    const parsing = new Promise<void>((resolve) => {
      bodyStarted = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (path: string) =>
        path === "/auth/logout"
          ? new Response(null, { status: 204 })
          : {
              status: 200,
              ok: true,
              json: () => {
                bodyStarted();
                return new Response(body).json();
              },
            },
      ),
    );
    const history = getOrbHistory("old");
    await parsing;
    await logout();
    release();
    const result = await history;
    expect(result.isErr() && result.error.type).toBe("auth_required");
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

  it("reads exact committed image bytes using the encoded private URL", async () => {
    const bytes = new Uint8Array([0, 255, 137, 80, 78, 71, 1]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (path: string, init?: RequestInit) => {
        expect(path).toBe("/api/v1/orbs/orb%2F1/images/record%2F1/key%3A0/2?sessionId=session%2F1");
        expect(init?.cache).toBe("no-store");
        expect(new Headers(init?.headers).has("x-requested-with")).toBe(false);
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

  it.each(["headers", "blob", "error body"])(
    "fences committed images held across logout at %s",
    async (boundary) => {
      let release!: () => void;
      let entered!: () => void;
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      vi.stubGlobal(
        "fetch",
        vi.fn(async (path: string) => {
          if (path === "/auth/logout") return new Response(null, { status: 204 });
          if (boundary === "headers") {
            entered();
            await held;
          }
          return {
            status: boundary === "error body" ? 404 : 200,
            ok: boundary !== "error body",
            headers: new Headers({ "content-type": "image/png" }),
            blob: async () => {
              if (boundary === "blob") {
                entered();
                await held;
              }
              return new Blob(["old"], { type: "image/png" });
            },
            json: async () => {
              entered();
              await held;
              return { error: { code: "not_found", message: "old", retryable: false } };
            },
          };
        }),
      );
      const image = getCommittedImage("a", "r", "k", 0, "s");
      await started;
      await logout();
      release();
      const result = await image;
      expect(result.isErr() && result.error.type).toBe("auth_required");
      expect(readBrowserSession().status).toBe("auth_required");
    },
  );

  it("does not recover an expired session from successful image bytes", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 401 })),
    );
    await probeSession();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("image", { headers: { "content-type": "image/png" } })),
    );
    expect((await getCommittedImage("a", "r", "k", 0, "s")).isOk()).toBe(true);
    expect(readBrowserSession().status).toBe("auth_required");
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
