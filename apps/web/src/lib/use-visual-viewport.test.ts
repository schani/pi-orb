import { describe, expect, it } from "vitest";
import { devConsoleDebug } from "./dev-console-debug.ts";
import { followVisualViewport } from "./use-visual-viewport.ts";

function harness(options: { visual: boolean }) {
  devConsoleDebug.clear();
  const properties = new Map<string, string>();
  const style = {
    setProperty: (name: string, value: string) => void properties.set(name, value),
    removeProperty: (name: string) => {
      const previous = properties.get(name) ?? "";
      properties.delete(name);
      return previous;
    },
  };
  const viewport = Object.assign(new EventTarget(), {
    height: 1024,
    offsetTop: 0,
    scale: 1,
  });
  const document = Object.assign(new EventTarget(), { visibilityState: "visible" });
  const host = Object.assign(new EventTarget(), {
    document,
    innerHeight: 1024,
    navigator: { userAgent: "desktop", platform: "Linux", maxTouchPoints: 0 },
    visualViewport: options.visual ? viewport : null,
  });
  const move = (height: number, offsetTop: number, scale = 1, event = "resize") => {
    Object.assign(viewport, { height, offsetTop, scale });
    viewport.dispatchEvent(new Event(event));
  };
  return { properties, style, viewport, host, move };
}

describe("followVisualViewport", () => {
  it.each([
    ["iPhone", "iPhone", 5, 60],
    ["iPad", "iPad", 5, 0],
    ["desktop", "MacIntel", 5, 0],
    ["desktop", "MacIntel", 0, 0],
    ["Android", "Linux", 5, 0],
  ] as const)(
    "bounds the accessory reserve for %s / %s / %i touch points",
    (userAgent, platform, maxTouchPoints, inset) => {
      const { properties, style, host, move } = harness({ visual: true });
      Object.assign(host.navigator, { userAgent, platform, maxTouchPoints });
      const stop = followVisualViewport(style, host);
      move(950, 0); // Browser chrome alone is not a software keyboard.
      expect(properties.get("--keyboard-accessory-inset")).toBe("0px");
      move(600, 0);
      expect(properties.get("--keyboard-accessory-inset")).toBe(`${inset}px`);
      move(300, 20, 2); // Pinch zoom preserves both geometry and reserve.
      expect(properties.get("--visual-viewport-height")).toBe("600px");
      expect(properties.get("--keyboard-accessory-inset")).toBe(`${inset}px`);
      move(620, 40, 1, "scroll");
      expect(properties.get("--keyboard-accessory-inset")).toBe(`${inset}px`);
      move(1024, 0);
      expect(properties.get("--keyboard-accessory-inset")).toBe("0px");
      expect(devConsoleDebug.dump().trace.map((entry) => entry.outcome)).toEqual(
        inset ? ["accessory_available", "accessory_unavailable"] : [],
      );
      if (inset)
        expect(devConsoleDebug.dump().trace).toMatchObject([
          { viewportHeight: 600, viewportLayoutHeight: 1024, viewportOffsetTop: 0 },
          { viewportHeight: 1024, viewportLayoutHeight: 1024, viewportOffsetTop: 0 },
        ]);
      stop();
      expect(properties.size).toBe(0);
    },
  );

  it("pins the app box to the visual viewport through resize and pan edges", () => {
    const { properties, style, host, move } = harness({ visual: true });
    followVisualViewport(style, host);
    expect(Object.fromEntries(properties)).toEqual({
      "--visual-viewport-height": "1024px",
      "--visual-viewport-top": "0px",
      "--keyboard-accessory-inset": "0px",
    });
    // iPad input-assistant bar: Safari shrinks the visual viewport and pans it down.
    move(708, 316);
    expect(properties.get("--visual-viewport-height")).toBe("708px");
    expect(properties.get("--visual-viewport-top")).toBe("316px");
    move(708, 120, 1, "scroll");
    expect(properties.get("--visual-viewport-top")).toBe("120px");
    expect(devConsoleDebug.dump().trace).toEqual([]);
  });

  it.each(["visibilitychange", "pageshow", "focus"])(
    "resamples missed viewport changes on visible %s without a resize or scroll",
    (event) => {
      const { properties, style, host, viewport } = harness({ visual: true });
      followVisualViewport(style, host);
      host.document.visibilityState = "hidden";
      host.document.dispatchEvent(new Event("visibilitychange"));
      Object.assign(viewport, { height: 708, offsetTop: 120 });
      (event === "visibilitychange" ? host.document : host).dispatchEvent(new Event(event));
      expect(properties.get("--visual-viewport-height")).toBe("1024px");
      expect(properties.get("--visual-viewport-top")).toBe("0px");

      host.document.visibilityState = "visible";
      (event === "visibilitychange" ? host.document : host).dispatchEvent(new Event(event));
      expect(properties.get("--visual-viewport-height")).toBe("708px");
      expect(properties.get("--visual-viewport-top")).toBe("120px");
      expect(devConsoleDebug.dump().trace).toEqual([
        expect.objectContaining({
          event: "viewport",
          outcome: event === "visibilitychange" ? "visible" : event,
          viewportHeight: 708,
          viewportOffsetTop: 120,
        }),
      ]);
      (event === "visibilitychange" ? host.document : host).dispatchEvent(new Event(event));
      expect(devConsoleDebug.dump().trace).toHaveLength(1);
    },
  );

  it("keeps the existing layout during zoomed or invalid resume measurements", () => {
    const { properties, style, host, viewport } = harness({ visual: true });
    followVisualViewport(style, host);
    Object.assign(viewport, { height: 400, offsetTop: 50, scale: 2 });
    host.dispatchEvent(new Event("pageshow"));
    Object.assign(viewport, { height: 0, offsetTop: 0, scale: 1 });
    host.document.dispatchEvent(new Event("visibilitychange"));
    expect(properties.get("--visual-viewport-height")).toBe("1024px");
    expect(properties.get("--visual-viewport-top")).toBe("0px");
    expect(devConsoleDebug.dump().trace).toEqual([]);
  });

  it("keeps the existing layout while pinch-zoomed or reporting no height", () => {
    const { properties, style, host, move } = harness({ visual: true });
    followVisualViewport(style, host);
    move(400, 50, 2);
    move(0, 0);
    expect(properties.get("--visual-viewport-height")).toBe("1024px");
    expect(properties.get("--visual-viewport-top")).toBe("0px");
  });

  it("follows the window when no visual viewport exists", () => {
    const { properties, style, host } = harness({ visual: false });
    followVisualViewport(style, host);
    host.innerHeight = 900;
    host.dispatchEvent(new Event("resize"));
    expect(properties.get("--visual-viewport-height")).toBe("900px");
    expect(properties.get("--visual-viewport-top")).toBe("0px");
    host.innerHeight = 700;
    host.dispatchEvent(new Event("pageshow"));
    expect(properties.get("--visual-viewport-height")).toBe("700px");
  });

  it("removes its properties and stops listening on cleanup", () => {
    const { properties, style, host, move } = harness({ visual: true });
    const stop = followVisualViewport(style, host);
    stop();
    expect(properties.size).toBe(0);
    move(500, 10);
    host.dispatchEvent(new Event("resize"));
    host.dispatchEvent(new Event("pageshow"));
    host.dispatchEvent(new Event("focus"));
    host.document.dispatchEvent(new Event("visibilitychange"));
    expect(properties.size).toBe(0);
  });
});
