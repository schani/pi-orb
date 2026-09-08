import { Check } from "typebox/value";
import { describe, expect, it } from "vitest";
import {
  HOSTING_FILES_PATH,
  HOSTING_MAX_FILE_BYTES,
  HostedFileResponseSchema,
  HostedFilesResponseSchema,
  HostedPathSchema,
  HostingErrorSchema,
} from "./hosting.ts";

describe("hosting protocol", () => {
  const file = {
    mediaType: "text/html",
    path: "design/index.html",
    size: 42,
    updatedAt: 1,
    url: "https://files.example/s/orb/design/index.html",
  };
  it("defines the runtime collection path and closed file views", () => {
    expect(HOSTING_FILES_PATH).toBe("/runtime/v1/hosting/files");
    expect(HOSTING_MAX_FILE_BYTES).toBe(32 * 1024 * 1024);
    expect(Check(HostedFileResponseSchema, { file })).toBe(true);
    expect(Check(HostedFilesResponseSchema, { cleanupIssues: [], files: [file] })).toBe(true);
    expect(Check(HostedFileResponseSchema, { file: { ...file, sha256: "private" } })).toBe(false);
  });
  it("rejects noncanonical paths and unsafe URLs", () => {
    for (const path of [
      "/index.html",
      "dir/",
      "dir\\file",
      "dir//file",
      "dir/../file",
      "bad\nfile",
    ])
      expect(Check(HostedPathSchema, path)).toBe(false);
    expect(Check(HostedFileResponseSchema, { file: { ...file, url: "javascript:alert(1)" } })).toBe(
      false,
    );
  });
  it("validates typed errors", () => {
    expect(
      Check(HostingErrorSchema, {
        error: { code: "too_large", message: "large", retryable: false },
      }),
    ).toBe(true);
    expect(
      Check(HostingErrorSchema, { error: { code: "other", message: "x", retryable: false } }),
    ).toBe(false);
  });
});
