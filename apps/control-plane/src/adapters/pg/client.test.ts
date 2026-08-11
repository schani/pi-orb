import { describe, expect, it } from "vitest";
import { arrayParam, jsonParam, mapPgError, prepareParams } from "./client.ts";

/**
 * The parameter guard and the SQLSTATE classification, both pure. The driver
 * round trips live in the store contract (`stores.test.ts` on PGlite,
 * `e2e/postgres-store.e2e.test.ts` on a real server).
 */
describe("prepareParams", () => {
  it("stringifies a jsonParam for node-postgres and passes it raw to PGlite", () => {
    const content = [{ type: "text", text: "hi" }];
    expect(prepareParams([jsonParam(content)], "node-postgres")._unsafeUnwrap()).toEqual([
      '[{"type":"text","text":"hi"}]',
    ]);
    expect(prepareParams([jsonParam(content)], "pglite")._unsafeUnwrap()).toEqual([content]);

    const header = { id: "session-1", overflow: {} };
    expect(prepareParams([jsonParam(header)], "node-postgres")._unsafeUnwrap()).toEqual([
      '{"id":"session-1","overflow":{}}',
    ]);
    expect(prepareParams([jsonParam(header)], "pglite")._unsafeUnwrap()).toEqual([header]);

    // A scalar is still JSON on the wire for node-postgres.
    expect(prepareParams([jsonParam("text")], "node-postgres")._unsafeUnwrap()).toEqual(['"text"']);
    expect(prepareParams([jsonParam(7)], "node-postgres")._unsafeUnwrap()).toEqual(["7"]);
  });

  it("binds a null jsonParam as SQL NULL, not as JSON null", () => {
    // JSON.stringify(null) would store `null`::jsonb, where `IS NULL` is false.
    for (const driver of ["node-postgres", "pglite"] as const) {
      expect(prepareParams([jsonParam(null)], driver)._unsafeUnwrap()).toEqual([null]);
      expect(prepareParams([jsonParam(undefined)], driver)._unsafeUnwrap()).toEqual([null]);
    }
  });

  it("passes an arrayParam through as an array for both drivers", () => {
    const ids = ["a", "b"] as const;
    for (const driver of ["node-postgres", "pglite"] as const) {
      const prepared = prepareParams([arrayParam(ids)], driver)._unsafeUnwrap();
      expect(prepared).toEqual([["a", "b"]]);
      expect(Array.isArray(prepared[0])).toBe(true);
    }
  });

  it("rejects a bare array before the driver sees it, naming the parameter", () => {
    for (const driver of ["node-postgres", "pglite"] as const) {
      const rejected = prepareParams(["orb", [{ type: "text" }]], driver);
      expect(rejected.isErr()).toBe(true);
      expect(rejected.isErr() && rejected.error.code).toBe("invariant");
      expect(rejected.isErr() && rejected.error.retryable).toBe(false);
      expect(rejected.isErr() && rejected.error.message).toContain("$2");
      expect(rejected.isErr() && rejected.error.message).toContain("jsonParam()");
      expect(rejected.isErr() && rejected.error.message).toContain("arrayParam()");
    }
  });

  it("rejects a bare plain object, including a null-prototype one", () => {
    const rejected = prepareParams([{ id: "x" }], "node-postgres");
    expect(rejected.isErr() && rejected.error.code).toBe("invariant");
    expect(rejected.isErr() && rejected.error.message).toContain("$1");
    expect(rejected.isErr() && rejected.error.message).toContain("object");

    const nullPrototype = Object.assign(Object.create(null) as object, { id: "x" });
    expect(prepareParams([nullPrototype], "node-postgres").isErr()).toBe(true);
  });

  it("passes primitives, null, Date, and binary values through untouched", () => {
    const date = new Date("2026-08-11T00:00:00.000Z");
    const bytes = new Uint8Array([1, 2, 3]);
    const buffer = Buffer.from("abc");
    const values = ["text", 42, true, null, undefined, date, bytes, buffer];
    for (const driver of ["node-postgres", "pglite"] as const) {
      expect(prepareParams(values, driver)._unsafeUnwrap()).toEqual(values);
    }
  });

  it("accepts an empty parameter list", () => {
    expect(prepareParams([], "node-postgres")._unsafeUnwrap()).toEqual([]);
  });
});

describe("mapPgError", () => {
  it("classifies a data exception as a non-retryable invariant", () => {
    // 22P02: what a JS array bound to a jsonb column produced in production.
    const mapped = mapPgError(
      Object.assign(new Error("invalid input syntax for type json"), { code: "22P02" }),
    );
    expect(mapped.code).toBe("invariant");
    expect(mapped.retryable).toBe(false);
    expect(mapped.message).toContain("invalid input syntax");
  });

  it("classifies a missing column as a non-retryable invariant", () => {
    const mapped = mapPgError(
      Object.assign(new Error('column "nope" does not exist'), { code: "42703" }),
    );
    expect(mapped.code).toBe("invariant");
    expect(mapped.retryable).toBe(false);
  });

  it("keeps constraint violations as corruption", () => {
    const mapped = mapPgError(Object.assign(new Error("duplicate key"), { code: "23505" }));
    expect(mapped.code).toBe("corruption");
    expect(mapped.retryable).toBe(false);
  });

  it("treats connection trouble and unknown failures as a retryable outage", () => {
    const connection = mapPgError(
      Object.assign(new Error("terminating connection"), { code: "57P01" }),
    );
    expect(connection.code).toBe("unavailable");
    expect(connection.retryable).toBe(true);

    const unknown = mapPgError(new Error("ECONNREFUSED"));
    expect(unknown.code).toBe("unavailable");
    expect(unknown.retryable).toBe(true);
    expect(mapPgError("plain string").code).toBe("unavailable");
  });
});
