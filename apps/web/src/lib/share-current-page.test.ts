import { err, ok } from "neverthrow";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { copyToClipboard } from "./copy-to-clipboard.ts";
import { canShareCurrentPage, shareCurrentPage } from "./share-current-page.ts";

vi.mock("./copy-to-clipboard.ts", () => ({ copyToClipboard: vi.fn() }));

const firstUrl = "https://example.test/orbs/one?view=details#record-1";
let location: { href: string };

beforeEach(() => {
  vi.clearAllMocks();
  location = { href: firstUrl };
  vi.stubGlobal("window", { location });
  vi.stubGlobal("document", { title: "Current orb · project" });
  vi.mocked(copyToClipboard).mockResolvedValue(ok(undefined));
});
afterEach(() => vi.unstubAllGlobals());

describe("shareCurrentPage", () => {
  it("invokes native sharing synchronously and uses the exact fresh URL and title", async () => {
    const navigator = { share: vi.fn().mockResolvedValue(undefined) };
    vi.stubGlobal("navigator", navigator);
    expect(canShareCurrentPage()).toBe(true);
    const first = shareCurrentPage();
    expect(navigator.share).toHaveBeenCalledWith({ url: firstUrl, title: document.title });
    expect(navigator.share.mock.contexts[0]).toBe(navigator);
    expect(await first).toEqual(ok("shared"));

    location.href = "https://example.test/orbs/two?focus=a%2Fb&x=1#tool:2";
    document.title = "Renamed orb";
    const second = shareCurrentPage();
    expect(navigator.share).toHaveBeenLastCalledWith({
      url: location.href,
      title: "Renamed orb",
    });
    expect(await second).toEqual(ok("shared"));
    expect(copyToClipboard).not.toHaveBeenCalled();
  });

  it.each(["reject", "throw"])(
    "treats native AbortError %s as quiet cancellation",
    async (mode) => {
      const error = new DOMException("dismissed", "AbortError");
      const share = vi.fn(() => {
        if (mode === "throw") throw error;
        return Promise.reject(error);
      });
      vi.stubGlobal("navigator", { share });
      expect(await shareCurrentPage()).toEqual(ok("cancelled"));
      expect(copyToClipboard).not.toHaveBeenCalled();
    },
  );

  it.each(["reject", "throw"])(
    "returns a typed native %s failure without copying",
    async (mode) => {
      const share = vi.fn(() => {
        if (mode === "throw") throw new TypeError("platform failure");
        return Promise.reject(new DOMException("not permitted", "NotAllowedError"));
      });
      vi.stubGlobal("navigator", { share });
      expect(await shareCurrentPage()).toEqual(err({ type: "share_failed" }));
      expect(copyToClipboard).not.toHaveBeenCalled();
    },
  );

  it("copies only when the native API is absent, using the current URL", async () => {
    vi.stubGlobal("navigator", {});
    expect(canShareCurrentPage()).toBe(false);
    location.href = "http://localhost/orbs/one?view=local#record-2";
    expect(await shareCurrentPage()).toEqual(ok("copied"));
    expect(copyToClipboard).toHaveBeenCalledWith(location.href);
  });

  it("preserves the clipboard helper's typed failure", async () => {
    vi.stubGlobal("navigator", {});
    vi.mocked(copyToClipboard).mockResolvedValue(err({ type: "clipboard_unavailable" }));
    expect(await shareCurrentPage()).toEqual(err({ type: "clipboard_unavailable" }));
  });
});
