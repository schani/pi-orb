import { expect, it, vi } from "vitest";
import { consentUrl, reserveConsentWindow } from "./claude-consent-window.ts";

function tab() {
  return {
    opener: {},
    closed: false,
    location: { replace: vi.fn() },
    close: vi.fn(),
    document: { title: "", body: { textContent: "", style: {}, setAttribute: vi.fn() } },
  };
}
it("reserves synchronously and removes the opener before navigation", () => {
  const window = tab();
  const open = vi.fn(() => window as unknown as Window);
  const result = reserveConsentWindow(open);
  expect(open).toHaveBeenCalledTimes(1);
  expect(window.opener).toBeNull();
  expect(window.location.replace).not.toHaveBeenCalled();
  expect(result.isOk()).toBe(true);
  if (result.isOk()) expect(result.value.navigate("https://claude.ai/consent").isOk()).toBe(true);
  expect(window.location.replace).toHaveBeenCalledWith("https://claude.ai/consent");
});
it("shows only a minimal connecting status in the reserved tab before navigation", () => {
  const window = tab();
  expect(reserveConsentWindow(() => window as unknown as Window).isOk()).toBe(true);
  expect(window.document.title).toBe("Claude subscription");
  expect(window.document.body.textContent).toBe("Connecting…");
  expect(window.document.body.setAttribute).toHaveBeenCalledWith("role", "status");
  expect(window.location.replace).not.toHaveBeenCalled();
});
it("closes the reservation if writing its connecting status fails", () => {
  const window = tab();
  Object.defineProperty(window, "document", {
    get() {
      throw new Error("private");
    },
  });
  expect(reserveConsentWindow(() => window as unknown as Window)._unsafeUnwrapErr()).toEqual({
    type: "popup_unavailable",
  });
  expect(window.close).toHaveBeenCalledTimes(1);
});
it("returns typed blocked and platform failures without exception details", () => {
  expect(reserveConsentWindow(() => null)._unsafeUnwrapErr()).toEqual({ type: "popup_blocked" });
  expect(
    reserveConsentWindow(() => {
      throw new Error("private");
    })._unsafeUnwrapErr(),
  ).toEqual({ type: "popup_unavailable" });
});
it("closes a tab when opener removal fails", () => {
  const window = tab();
  Object.defineProperty(window, "opener", {
    set() {
      throw new Error("private");
    },
  });
  expect(reserveConsentWindow(() => window as unknown as Window).isErr()).toBe(true);
  expect(window.close).toHaveBeenCalledTimes(1);
});
it("reports a closed tab or navigation exception without leaking its URL", () => {
  const window = tab();
  const reserved = reserveConsentWindow(() => window as unknown as Window)._unsafeUnwrap();
  window.closed = true;
  expect(reserved.navigate("https://claude.ai/consent")._unsafeUnwrapErr()).toEqual({
    type: "popup_closed",
  });
  window.closed = false;
  window.location.replace.mockImplementation(() => {
    throw new Error("private URL");
  });
  expect(reserved.navigate("https://claude.ai/consent")._unsafeUnwrapErr()).toEqual({
    type: "popup_unavailable",
  });
});
it("permits only HTTPS Anthropic hosts without credentials", () => {
  for (const url of [
    "https://claude.ai/consent",
    "https://claude.com/consent",
    "https://console.anthropic.com/consent",
    "https://platform.claude.com/consent",
  ])
    expect(consentUrl(url)).toBe(url);
  for (const url of [
    "",
    "http://claude.ai/consent",
    "https://claude.ai.evil/",
    "https://owner:secret@claude.ai/",
    "javascript:alert(1)",
  ])
    expect(consentUrl(url)).toBeNull();
});
it("rejects unsafe navigation at the browser boundary", () => {
  const window = tab();
  const reserved = reserveConsentWindow(() => window as unknown as Window)._unsafeUnwrap();
  expect(reserved.navigate("https://example.com/private")._unsafeUnwrapErr()).toEqual({
    type: "invalid_consent_url",
  });
  expect(window.location.replace).not.toHaveBeenCalled();
});
it("maps close exceptions to a typed error", () => {
  const window = tab();
  window.close.mockImplementation(() => {
    throw new Error("private");
  });
  expect(
    reserveConsentWindow(() => window as unknown as Window)
      ._unsafeUnwrap()
      .close()
      ._unsafeUnwrapErr(),
  ).toEqual({ type: "popup_unavailable" });
});
