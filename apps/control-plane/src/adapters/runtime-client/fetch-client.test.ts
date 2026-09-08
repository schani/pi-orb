import { NoSimulationTask } from "determined";
import { afterEach, describe, expect, it, vi } from "vitest";
import { describeFetchError, FetchRuntimeClient } from "./fetch-client.ts";

const task = new NoSimulationTask("runtime client response evidence", false);

afterEach(() => vi.unstubAllGlobals());

/**
 * undici's rejection shapes (docs/postmortems/2026-08-06-rollover-repair-war-corrupt-image.md):
 * every one of these reads as the bare message "fetch failed" without the walk.
 */
const withCause = (message: string, cause: unknown): Error => {
  const error = new Error(message);
  (error as { cause?: unknown }).cause = cause;
  return error;
};

const coded = (code: string): Error => {
  const error = new Error(code);
  (error as { code?: unknown }).code = code;
  return error;
};

describe("describeFetchError", () => {
  it("unwraps a plain cause with a syscall code", () => {
    expect(describeFetchError(withCause("fetch failed", coded("ECONNREFUSED")))).toBe(
      "fetch failed (ECONNREFUSED)",
    );
    expect(describeFetchError(withCause("fetch failed", coded("EHOSTUNREACH")))).toBe(
      "fetch failed (EHOSTUNREACH)",
    );
  });

  it("takes the first code out of an AggregateError's errors", () => {
    const aggregate = new AggregateError(
      [new Error("no code"), coded("ETIMEDOUT"), coded("ECONNREFUSED")],
      "all attempts failed",
    );
    expect(describeFetchError(withCause("fetch failed", aggregate))).toBe(
      "fetch failed (ETIMEDOUT)",
    );
  });

  it("walks nested causes", () => {
    const nested = withCause("outer", withCause("inner", coded("UND_ERR_CONNECT_TIMEOUT")));
    expect(describeFetchError(nested)).toBe("outer (UND_ERR_CONNECT_TIMEOUT)");
  });

  it("leaves a causeless error alone", () => {
    expect(describeFetchError(new Error("fetch failed"))).toBe("fetch failed");
  });

  it("survives a non-Error cause, a codeless chain, and a thrown non-Error", () => {
    expect(describeFetchError(withCause("fetch failed", "just a string"))).toBe("fetch failed");
    expect(describeFetchError(withCause("fetch failed", null))).toBe("fetch failed");
    expect(describeFetchError(withCause("fetch failed", { nothing: true }))).toBe("fetch failed");
    expect(describeFetchError("not an error at all")).toBe("not an error at all");
  });

  it("ignores a numeric code (DOMException) and finds the real one deeper", () => {
    const domLike = { code: 20, cause: coded("ECONNRESET") };
    expect(describeFetchError(withCause("The operation was aborted", domLike))).toBe(
      "The operation was aborted (ECONNRESET)",
    );
  });

  it("terminates on a self-referential cause chain", () => {
    const looping = new Error("fetch failed");
    (looping as { cause?: unknown }).cause = looping;
    expect(describeFetchError(looping)).toBe("fetch failed");
  });
});

describe("FetchRuntimeClient response evidence", () => {
  it("marks an HTTP error as answered", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ error: { message: "busy" } }, { status: 503 })),
    );
    const result = await new FetchRuntimeClient().health(task, "http://runtime.test", {
      signal: new AbortController().signal,
    });
    expect(result.isErr() && result.error).toMatchObject({
      answered: true,
      code: "http_error",
    });
  });

  it.each([
    ["unparseable JSON", new Response("{", { status: 200 })],
    ["invalid schema", Response.json({}, { status: 200 })],
  ])("marks %s after a response as answered", async (_case, response) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response),
    );
    const result = await new FetchRuntimeClient().health(task, "http://runtime.test", {
      signal: new AbortController().signal,
    });
    expect(result.isErr() && result.error).toMatchObject({
      answered: true,
      code: "invalid_response",
    });
  });

  it("marks a network failure as unanswered", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Promise.reject(new TypeError("fetch failed"))),
    );
    const result = await new FetchRuntimeClient().health(task, "http://runtime.test", {
      signal: new AbortController().signal,
    });
    expect(result.isErr() && result.error).toMatchObject({
      answered: false,
      code: "unreachable",
    });
  });

  it("marks a pre-aborted request as unanswered cancellation", async () => {
    const controller = new AbortController();
    controller.abort();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        expect(init?.signal?.aborted).toBe(true);
        return Promise.reject(new DOMException("aborted", "AbortError"));
      }),
    );
    const result = await new FetchRuntimeClient().health(task, "http://runtime.test", {
      signal: controller.signal,
    });
    expect(result.isErr() && result.error).toMatchObject({
      answered: false,
      code: "cancelled",
    });
  });
});
