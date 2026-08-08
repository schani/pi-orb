import { describe, expect, it } from "vitest";
import { deriveOrbFaviconStatus, setOrbFavicon } from "./favicon.ts";

describe("deriveOrbFaviconStatus", () => {
  it("shows current busy activity ahead of the running lifecycle state", () => {
    expect(deriveOrbFaviconStatus("running", "open", "busy")).toBe("busy");
    expect(deriveOrbFaviconStatus("running", "open", "idle")).toBe("running");
  });

  it("does not retain stale busy activity while disconnected", () => {
    expect(deriveOrbFaviconStatus("running", "retrying", "busy")).toBe("running");
    expect(deriveOrbFaviconStatus("running", "closed", "busy")).toBe("running");
  });

  it("maps lifecycle states without mislabeling transitions or failures", () => {
    expect(deriveOrbFaviconStatus(null, "closed", null)).toBe("neutral");
    expect(deriveOrbFaviconStatus("stopped", "closed", null)).toBe("stopped");
    expect(deriveOrbFaviconStatus("creating", "closed", null)).toBe("transitional");
    expect(deriveOrbFaviconStatus("starting", "closed", null)).toBe("transitional");
    expect(deriveOrbFaviconStatus("stopping", "closed", null)).toBe("transitional");
    expect(deriveOrbFaviconStatus("failed", "closed", null)).toBe("failed");
  });
});

describe("setOrbFavicon", () => {
  it("replaces the href on the one favicon link", () => {
    const attributes = new Map<string, string>();
    const target = {
      getElementById: (id: string) =>
        id === "pi-orb-favicon"
          ? { setAttribute: (name: string, value: string) => attributes.set(name, value) }
          : null,
    };

    setOrbFavicon("stopped", target);
    expect(attributes.get("href")).toBe("/favicons/stopped.svg");

    setOrbFavicon("busy", target);
    expect(attributes.get("href")).toBe("/favicons/busy.svg");
  });
});
