import { describe, expect, it } from "vitest";
import { followVisualViewport } from "./use-visual-viewport.ts";

function harness(options: { visual: boolean }) {
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
  const host = Object.assign(new EventTarget(), {
    innerHeight: 1024,
    visualViewport: options.visual ? viewport : null,
  });
  const move = (height: number, offsetTop: number, scale = 1, event = "resize") => {
    Object.assign(viewport, { height, offsetTop, scale });
    viewport.dispatchEvent(new Event(event));
  };
  return { properties, style, viewport, host, move };
}

describe("followVisualViewport", () => {
  it("pins the app box to the visual viewport through resize and pan edges", () => {
    const { properties, style, host, move } = harness({ visual: true });
    followVisualViewport(style, host);
    expect(Object.fromEntries(properties)).toEqual({
      "--visual-viewport-height": "1024px",
      "--visual-viewport-top": "0px",
    });
    // iPad input-assistant bar: Safari shrinks the visual viewport and pans it down.
    move(708, 316);
    expect(properties.get("--visual-viewport-height")).toBe("708px");
    expect(properties.get("--visual-viewport-top")).toBe("316px");
    move(708, 120, 1, "scroll");
    expect(properties.get("--visual-viewport-top")).toBe("120px");
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
  });

  it("removes its properties and stops listening on cleanup", () => {
    const { properties, style, host, move } = harness({ visual: true });
    const stop = followVisualViewport(style, host);
    stop();
    expect(properties.size).toBe(0);
    move(500, 10);
    host.dispatchEvent(new Event("resize"));
    expect(properties.size).toBe(0);
  });
});
