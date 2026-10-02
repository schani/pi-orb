import { afterEach, expect, it, vi } from "vitest";
import { createImageObjectUrl, revokeImageObjectUrl } from "./object-url.ts";

afterEach(() => vi.restoreAllMocks());

it("contains object URL creation failure as a typed result", () => {
  vi.spyOn(URL, "createObjectURL").mockImplementation(() => {
    throw new Error("private failure");
  });
  const result = createImageObjectUrl(new Blob(["test"], { type: "image/png" }));
  expect(result.isErr()).toBe(true);
  if (result.isErr()) expect(result.error).toEqual({ type: "object_url_create_failed" });
});

it("contains object URL cleanup failures without leaking exception content", () => {
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {
    throw new Error("private failure");
  });
  expect(revokeImageObjectUrl("blob:opaque").isErr()).toBe(true);
});
