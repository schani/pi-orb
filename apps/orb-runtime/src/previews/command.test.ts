import { describe, expect, it } from "vitest";
import { parsePreviewArgs } from "./command.ts";

describe("preview CLI", () => {
  it("parses explicit registrations and listing", () => {
    expect(parsePreviewArgs(["expose", "5173"])._unsafeUnwrap()).toEqual({
      type: "expose",
      port: 5173,
    });
    expect(parsePreviewArgs(["unexpose", "5173"])._unsafeUnwrap()).toEqual({
      type: "unexpose",
      port: 5173,
    });
    expect(parsePreviewArgs(["previews"])._unsafeUnwrap()).toEqual({
      type: "previews",
      json: false,
    });
    expect(parsePreviewArgs(["previews", "--json"])._unsafeUnwrap()).toEqual({
      type: "previews",
      json: true,
    });
  });
  it.each([
    [],
    ["expose"],
    ["expose", "0"],
    ["expose", "65536"],
    ["expose", "1.5"],
    ["expose", "1e3"],
    ["expose", "-1"],
    ["expose", "5173", "--json"],
    ["unexpose", "foo"],
    ["previews", "extra"],
    ["previews", "--json", "--json"],
  ])("rejects malformed arguments %j", (...args) => {
    expect(parsePreviewArgs(args).isErr()).toBe(true);
  });
});
