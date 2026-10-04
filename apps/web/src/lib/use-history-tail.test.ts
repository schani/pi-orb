import { afterEach, describe, expect, it, vi } from "vitest";
import { isPinnedAfterScroll } from "./scroll-pin.ts";
import { attachHistoryTail } from "./use-history-tail.ts";

class KeyTarget {
  private readonly editable: boolean;
  constructor(editable = false) {
    this.editable = editable;
  }
  closest() {
    return this.editable ? this : null;
  }
}

function fixture(short = false, onCompensated?: () => void) {
  vi.stubGlobal("HTMLElement", KeyTarget);
  const listeners = new Map<string, (event: never) => void>();
  const viewport = {
    style: { overflowAnchor: "auto" },
    scrollTop: short ? 0 : 100,
    clientHeight: 300,
    scrollHeight: short ? 100 : 1000,
    getBoundingClientRect: () => ({ top: 0 }),
    addEventListener: (type: string, fn: (event: never) => void) => listeners.set(type, fn),
    removeEventListener: (type: string) => listeners.delete(type),
  };
  let rowTop = 100;
  const row = {
    isConnected: true,
    getBoundingClientRect: () => ({
      top: rowTop - viewport.scrollTop,
      bottom: rowTop + 100 - viewport.scrollTop,
    }),
  };
  const history = { querySelectorAll: () => [row] };
  let resized = () => {};
  let disconnected = false;
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        resized = callback;
      }
      observe() {}
      disconnect() {
        disconnected = true;
      }
    },
  );
  vi.stubGlobal("window", { addEventListener() {}, removeEventListener() {} });
  let first = 60;
  const revealed: number[] = [];
  const control = attachHistoryTail(
    viewport as unknown as HTMLDivElement,
    history as unknown as HTMLDivElement,
    () => first,
    (next) => {
      first = next;
      revealed.push(next);
    },
    onCompensated,
  );
  return {
    viewport,
    rowOffset: () => row.getBoundingClientRect().top,
    revealed,
    control,
    resized: () => resized(),
    grow: (height: number) => {
      rowTop += height;
      viewport.scrollHeight += height;
    },
    fire: (name: string, event = {}) => listeners.get(name)?.(event as never),
    disconnected: () => disconnected,
    listenerCount: () => listeners.size,
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("upward history reader", () => {
  it("advances the parent baseline before resize can mistake compensation for native tail movement", () => {
    const f = fixture(false, () => {
      previousView = view();
    });
    const view = () => ({
      scrollY: f.viewport.scrollTop,
      viewportHeight: f.viewport.clientHeight,
      contentHeight: f.viewport.scrollHeight,
    });
    let previousView = view();
    let pinned = false;
    f.fire("wheel", { deltaY: -1 });
    const offset = f.rowOffset();
    f.grow(800);
    f.control.restore();
    expect(f.viewport.scrollTop).toBe(900);
    // The parent resize observer runs before either native scroll acknowledgement.
    const current = view();
    if (Math.abs(current.scrollY - previousView.scrollY) > 1) {
      pinned = isPinnedAfterScroll({ ...previousView, scrollY: current.scrollY }, null);
    }
    if (pinned) f.viewport.scrollTop = f.viewport.scrollHeight - f.viewport.clientHeight;
    expect(f.rowOffset()).toBe(offset);
    expect(pinned).toBe(false);
    expect(previousView).toEqual({ scrollY: 900, viewportHeight: 300, contentHeight: 1800 });
    f.control.dispose();
  });
  it.each(["ArrowUp", "PageUp", "Home", " "])("recognizes %s outside editors", (key) => {
    const f = fixture();
    f.fire("keydown", { key, shiftKey: key === " ", target: new KeyTarget(true) });
    expect(f.revealed).toEqual([]);
    f.fire("keydown", { key, shiftKey: key === " ", target: new KeyTarget() });
    expect(f.revealed).toEqual([40]);
    f.grow(600);
    f.control.restore();
    expect(f.viewport.scrollTop).toBe(700);
    f.fire("keydown", { key: "End", target: new KeyTarget() });
    f.grow(80);
    f.resized();
    expect(f.viewport.scrollTop).toBe(780);
    f.control.dispose();
  });
  it("recognizes upward touch motion after native pointer cancellation", () => {
    const f = fixture();
    f.fire("pointerdown");
    f.fire("touchstart", { touches: [{ clientY: 200 }] });
    f.fire("pointercancel");
    f.fire("touchmove", { touches: [{ clientY: 250 }] });
    expect(f.revealed).toEqual([40]);
    f.grow(600);
    f.control.restore();
    expect(f.viewport.scrollTop).toBe(700);
    f.fire("scroll");
    f.grow(80);
    f.resized();
    expect(f.viewport.scrollTop).toBe(780);
    expect(f.revealed).toEqual([40]);
    f.fire("touchmove", { touches: [{ clientY: 225 }] });
    f.grow(80);
    f.resized();
    expect(f.viewport.scrollTop).toBe(860);
    f.control.dispose();
  });
  it("does not fill a short initial viewport on mount, resize or programmatic scroll", () => {
    const f = fixture(true);
    f.resized();
    f.fire("scroll");
    expect(f.revealed).toEqual([]);
    f.fire("wheel", { deltaY: -1 });
    expect(f.revealed).toEqual([40]);
    f.control.dispose();
    expect(f.viewport.style.overflowAnchor).toBe("auto");
    expect(f.disconnected()).toBe(true);
    expect(f.listenerCount()).toBe(0);
  });
  it("preserves the row pixel position on prepend and delayed image growth without another reveal", () => {
    const f = fixture();
    f.fire("wheel", { deltaY: -1 });
    expect(f.revealed).toEqual([40]);
    f.grow(600);
    f.control.restore();
    expect(f.viewport.scrollTop).toBe(700);
    f.fire("scroll");
    f.resized();
    expect(f.revealed).toEqual([40]);
    f.grow(80);
    f.resized();
    expect(f.viewport.scrollTop).toBe(780);
    f.fire("scroll");
    f.viewport.scrollTop = 100;
    f.fire("scroll");
    expect(f.revealed).toEqual([40, 20]);
    f.control.dispose();
  });
  it.each(["wheel", "key", "touch", "pointer"])(
    "preserves the settled off-tail row after downward %s movement and delayed growth",
    (input) => {
      const f = fixture();
      f.fire("wheel", { deltaY: -1 });
      f.grow(600);
      f.control.restore();
      f.fire("scroll");
      if (input === "wheel") f.fire("wheel", { deltaY: 1 });
      if (input === "key") f.fire("keydown", { key: "ArrowDown", target: new KeyTarget() });
      if (input === "touch") {
        f.fire("touchstart", { touches: [{ clientY: 250 }] });
        f.fire("touchmove", { touches: [{ clientY: 225 }] });
      }
      if (input === "pointer") f.fire("pointerdown");
      f.viewport.scrollTop += 25;
      f.fire("scroll");
      const settledOffset = f.rowOffset();
      expect(settledOffset).toBe(-25);
      expect(f.revealed).toEqual([40]);
      f.grow(80);
      f.resized();
      expect(f.rowOffset()).toBe(settledOffset);
      expect(f.viewport.scrollTop).toBe(805);
      expect(f.revealed).toEqual([40]);
      f.control.dispose();
    },
  );
  it.each(["wheel", "key", "touch", "pointer"])(
    "anchors the current off-tail row after %s input without movement",
    (input) => {
      const f = fixture();
      f.fire("wheel", { deltaY: -1 });
      f.grow(600);
      f.control.restore();
      f.fire("scroll");
      // Native movement may precede its scroll event; discard the old anchor.
      f.viewport.scrollTop += 25;
      if (input === "wheel") f.fire("wheel", { deltaY: 1 });
      if (input === "key") f.fire("keydown", { key: "ArrowDown", target: new KeyTarget() });
      if (input === "touch") {
        f.fire("touchstart", { touches: [{ clientY: 250 }] });
        f.fire("touchmove", { touches: [{ clientY: 225 }] });
      }
      if (input === "pointer") f.fire("pointerdown");
      const offset = f.rowOffset();
      f.grow(80);
      f.resized();
      expect(f.rowOffset()).toBe(offset);
      expect(f.revealed).toEqual([40]);
      f.control.dispose();
    },
  );
  it.each(["wheel", "key", "touch", "pointer"])(
    "yields at tail on %s input without a scroll event",
    (input) => {
      const f = fixture();
      f.fire("wheel", { deltaY: -1 });
      f.viewport.scrollTop = f.viewport.scrollHeight - f.viewport.clientHeight;
      if (input === "wheel") f.fire("wheel", { deltaY: 1 });
      if (input === "key") f.fire("keydown", { key: "ArrowDown", target: new KeyTarget() });
      if (input === "touch") {
        f.fire("touchstart", { touches: [{ clientY: 250 }] });
        f.fire("touchmove", { touches: [{ clientY: 225 }] });
      }
      if (input === "pointer") f.fire("pointerdown");
      f.grow(80);
      f.resized();
      expect(f.viewport.scrollTop).toBe(700);
      expect(f.revealed).toEqual([40]);
      f.control.dispose();
    },
  );
  it.each(["layout", "resize"])("does not undo pending native movement during %s", (phase) => {
    const f = fixture();
    f.fire("wheel", { deltaY: -1 });
    f.viewport.scrollTop = 700;
    f.grow(80);
    if (phase === "layout") f.control.restore();
    else f.resized();
    expect(f.viewport.scrollTop).toBe(700);
    expect(f.revealed).toEqual([40]);
    f.control.dispose();
  });
  it("yields to the parent's tail pin after downward movement reaches the tail", () => {
    const f = fixture();
    f.fire("wheel", { deltaY: -1 });
    f.fire("wheel", { deltaY: 1 });
    f.viewport.scrollTop = f.viewport.scrollHeight - f.viewport.clientHeight;
    f.fire("scroll");
    f.grow(80);
    f.resized();
    expect(f.viewport.scrollTop).toBe(700);
    expect(f.revealed).toEqual([40]);
    f.control.dispose();
  });
});
