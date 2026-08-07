import { describe, expect, it, vi } from "vitest";
import { copyToClipboard } from "./copy-to-clipboard.ts";

describe("copyToClipboard", () => {
  it("passes the device code, not the verification URL, to the Clipboard API", async () => {
    const writeText = vi.fn(async () => {});
    const fallbackWrite = vi.fn(() => true);

    const result = await copyToClipboard("ABCD-1234", { writeText, fallbackWrite });

    expect(result.isOk()).toBe(true);
    expect(writeText).toHaveBeenCalledWith("ABCD-1234");
    expect(fallbackWrite).not.toHaveBeenCalled();
  });

  it("copies the code with the plain-HTTP fallback when Clipboard API access fails", async () => {
    const writeText = vi.fn(async () => {
      throw new Error("insecure context");
    });
    const fallbackWrite = vi.fn(() => true);

    const result = await copyToClipboard("WXYZ-9876", { writeText, fallbackWrite });

    expect(result.isOk()).toBe(true);
    expect(fallbackWrite).toHaveBeenCalledWith("WXYZ-9876");
  });

  it("returns a typed failure when neither copy path succeeds", async () => {
    const result = await copyToClipboard("CODE", { fallbackWrite: () => false });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.type).toBe("clipboard_unavailable");
  });
});
