import { describe, expect, it } from "vitest";
import { isPinnedToBottom } from "./scroll-pin.ts";

/**
 * Follow-the-tail behavior: when the chat is scrolled to (or near) the
 * bottom, new content keeps it pinned there; when the reader has scrolled
 * up, their position must stay locked.
 */
describe("isPinnedToBottom", () => {
  it("is pinned exactly at the bottom", () => {
    expect(isPinnedToBottom({ scrollY: 600, viewportHeight: 400, contentHeight: 1000 })).toBe(true);
  });

  it("is pinned within the slack distance of the bottom", () => {
    expect(isPinnedToBottom({ scrollY: 560, viewportHeight: 400, contentHeight: 1000 })).toBe(true);
  });

  it("is not pinned when scrolled up beyond the slack", () => {
    expect(isPinnedToBottom({ scrollY: 300, viewportHeight: 400, contentHeight: 1000 })).toBe(
      false,
    );
  });

  it("is pinned when content fits the viewport entirely", () => {
    expect(isPinnedToBottom({ scrollY: 0, viewportHeight: 800, contentHeight: 500 })).toBe(true);
  });
});
