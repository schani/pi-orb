import { describe, expect, it } from "vitest";
import { FAKE_ORIGIN, fakeRequest } from "./harness.ts";

const connectionReset = (): TypeError =>
  new TypeError("fetch failed", { cause: new Error("read ECONNRESET") });

const ok = (): Response => new Response("{}", { status: 200 });

const rejection = async (promise: Promise<unknown>): Promise<Error> => {
  const error = await promise.then(
    () => null,
    (cause: unknown) => cause as Error,
  );
  if (error === null) throw new Error("expected a rejection");
  return error;
};

describe("fakeRequest", () => {
  it("retries a transport failure and returns the eventual response", async () => {
    let calls = 0;
    const response = await fakeRequest("GET", "/api/__mock__/sessions/s/requests", {
      retryTransport: true,
      backoffMs: [0, 0],
      fetchImpl: () => {
        calls += 1;
        return calls <= 2 ? Promise.reject(connectionReset()) : Promise.resolve(ok());
      },
    });
    expect(calls).toBe(3);
    expect(response.status).toBe(200);
  });

  it("passes the request URL and body through", async () => {
    const seen: { url: string; method: string | undefined; body: string | undefined }[] = [];
    await fakeRequest("POST", "/api/__mock__/sessions", {
      body: { name: "x" },
      retryTransport: false,
      fetchImpl: (url, init) => {
        seen.push({
          url: String(url),
          method: init?.method,
          body: typeof init?.body === "string" ? init.body : undefined,
        });
        return Promise.resolve(ok());
      },
    });
    expect(seen).toEqual([
      {
        url: `${FAKE_ORIGIN}/api/__mock__/sessions`,
        method: "POST",
        body: '{"name":"x"}',
      },
    ]);
  });

  it("gives up after the bounded attempt count, naming the call", async () => {
    let calls = 0;
    const failure = await rejection(
      fakeRequest("GET", "/api/__mock__/sessions/s/requests", {
        retryTransport: true,
        backoffMs: [0, 0],
        fetchImpl: () => {
          calls += 1;
          return Promise.reject(connectionReset());
        },
      }),
    );
    expect(calls).toBe(3);
    expect(failure.message).toContain("GET /api/__mock__/sessions/s/requests");
    expect(failure.message).toContain("3 attempts");
    expect((failure.cause as Error | undefined)?.message).toBe("fetch failed");
  });

  it("does not retry a request that reached the service", async () => {
    let calls = 0;
    const response = await fakeRequest("GET", "/api/__mock__/sessions/s/requests", {
      retryTransport: true,
      backoffMs: [0, 0],
      fetchImpl: () => {
        calls += 1;
        return Promise.resolve(new Response("boom", { status: 500 }));
      },
    });
    expect(calls).toBe(1);
    expect(response.status).toBe(500);
  });

  it("does not retry when retryTransport is off", async () => {
    let calls = 0;
    const failure = await rejection(
      fakeRequest("POST", "/api/__mock__/sessions/s/deviceauth/approve", {
        body: { user_code: "c" },
        retryTransport: false,
        fetchImpl: () => {
          calls += 1;
          return Promise.reject(connectionReset());
        },
      }),
    );
    expect(calls).toBe(1);
    expect(failure.message).toContain("1 attempt");
  });

  it("aborts a hung request at the deadline", async () => {
    const failure = await rejection(
      fakeRequest("GET", "/api/__mock__/sessions/s/requests", {
        retryTransport: false,
        deadlineMs: 20,
        fetchImpl: (_url, init) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => {
              reject(init.signal?.reason as Error);
            });
          }),
      }),
    );
    expect(failure.message).toContain("GET /api/__mock__/sessions/s/requests");
    expect((failure.cause as Error | undefined)?.name).toBe("TimeoutError");
  });
});
