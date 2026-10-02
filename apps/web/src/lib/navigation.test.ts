import { describe, expect, it, vi } from "vitest";
import { navigate, shouldNavigate, subscribeNavigation } from "./navigation.ts";

describe("native anchor admission", () => {
  it("publishes push, replace and popstate without a document navigation", () => {
    const events = new EventTarget();
    const pushState = vi.fn();
    const replaceState = vi.fn();
    const assign = vi.fn();
    vi.stubGlobal("window", {
      history: { pushState, replaceState },
      location: { assign },
      addEventListener: events.addEventListener.bind(events),
      removeEventListener: events.removeEventListener.bind(events),
      dispatchEvent: events.dispatchEvent.bind(events),
    });
    const changed = vi.fn();
    const unsubscribe = subscribeNavigation(changed);
    try {
      expect(navigate("/orbs/o").isOk()).toBe(true);
      expect(pushState).toHaveBeenCalledWith(null, "", "/orbs/o");
      expect(navigate("/orbs/created", true).isOk()).toBe(true);
      expect(replaceState).toHaveBeenCalledWith(null, "", "/orbs/created");
      events.dispatchEvent(new Event("popstate"));
      expect(changed).toHaveBeenCalledTimes(3);
      expect(assign).not.toHaveBeenCalled();
    } finally {
      unsubscribe();
      vi.unstubAllGlobals();
    }
  });

  it.each([false, true])(
    "falls back to the matching document navigation when history throws (replace=%s)",
    (replace) => {
      const pushState = vi.fn(() => {
        throw new Error("history denied");
      });
      const replaceState = vi.fn(() => {
        throw new Error("history denied");
      });
      const assign = vi.fn();
      const replaceLocation = vi.fn();
      const dispatchEvent = vi.fn();
      vi.stubGlobal("window", {
        history: { pushState, replaceState },
        location: { assign, replace: replaceLocation },
        dispatchEvent,
      });
      try {
        expect(navigate("/orbs/created", replace).isOk()).toBe(true);
        expect(replace ? replaceState : pushState).toHaveBeenCalledWith(null, "", "/orbs/created");
        expect(replace ? replaceLocation : assign).toHaveBeenCalledWith("/orbs/created");
        expect(replace ? assign : replaceLocation).not.toHaveBeenCalled();
        expect(dispatchEvent).not.toHaveBeenCalled();
        (replace ? replaceLocation : assign).mockImplementation(() => {
          throw new Error("navigation denied");
        });
        const failed = navigate("/orbs/created", replace);
        expect(failed.isErr()).toBe(true);
        if (failed.isErr()) expect(failed.error).toEqual({ type: "navigation_failed" });
      } finally {
        vi.unstubAllGlobals();
      }
    },
  );

  it("intercepts only plain same-origin primary clicks on app paths", () => {
    const anchor = { href: "https://app.test/orbs/o", target: "", download: false };
    const click = (options: Partial<MouseEvent> = {}) =>
      ({ button: 0, defaultPrevented: false, ...options }) as MouseEvent;
    expect(shouldNavigate(click(), anchor, "https://app.test")).toBe(true);
    for (const options of [
      { metaKey: true },
      { ctrlKey: true },
      { shiftKey: true },
      { altKey: true },
      { button: 1 },
    ]) {
      expect(shouldNavigate(click(options), anchor, "https://app.test")).toBe(false);
    }
    expect(shouldNavigate(click(), { ...anchor, target: "_blank" }, "https://app.test")).toBe(
      false,
    );
    expect(shouldNavigate(click(), { ...anchor, download: true }, "https://app.test")).toBe(false);
    expect(
      shouldNavigate(click(), { ...anchor, href: "https://other.test/orbs/o" }, "https://app.test"),
    ).toBe(false);
    for (const path of ["/api/v1/orbs", "/favicons", "/favicons/missing"]) {
      expect(
        shouldNavigate(click(), { ...anchor, href: `https://app.test${path}` }, "https://app.test"),
      ).toBe(false);
    }
  });
});
