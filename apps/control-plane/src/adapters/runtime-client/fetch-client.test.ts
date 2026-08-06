import { describe, expect, it } from "vitest";
import { describeFetchError } from "./fetch-client.ts";

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
