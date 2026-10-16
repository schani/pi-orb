import { expect, it, vi } from "vitest";
import { armNativeWheel } from "./native-wheel.ts";

function quietLayout(element: Pane): Promise<void> {
  return new Promise<void>((resolve) => {
    let previous = "";
    const frame = () => {
      const current = JSON.stringify([
        element.scrollTop,
        element.scrollHeight,
        [...element.querySelectorAll("[data-history-row]")].map((row) => [
          row.getAttribute("data-history-row"),
          row.getBoundingClientRect().top,
          row.getBoundingClientRect().height,
        ]),
      ]);
      if (current === previous) resolve();
      else {
        previous = current;
        element.ownerDocument.defaultView.requestAnimationFrame(frame);
      }
    };
    element.ownerDocument.defaultView.requestAnimationFrame(frame);
  });
}

class Pane extends EventTarget {
  scrollTop = 100;
  scrollHeight = 1000;
  frames: (() => void)[] = [];
  ownerDocument = {
    defaultView: { requestAnimationFrame: (frame: () => void) => this.frames.push(frame) },
  };
  querySelectorAll(_selector: string) {
    return [
      {
        getAttribute: (_name: string) => "row",
        getBoundingClientRect: () => ({ top: 0, height: 40 }),
      },
    ];
  }
  frame() {
    const frames = this.frames.splice(0);
    for (const frame of frames) frame();
  }
  emit(type: string) {
    this.dispatchEvent(new Event(type));
  }
}

it("does not acknowledge matching geometry or stale scrollend before wheel movement", async () => {
  const pane = new Pane();
  const removed = vi.spyOn(pane, "removeEventListener");
  armNativeWheel(pane);
  let finished = false;
  Reflect.get(pane, "wheelFinished").then(() => {
    finished = true;
  });
  pane.emit("scroll");
  pane.emit("scrollend");
  const quiet = quietLayout(pane);
  pane.frame();
  pane.frame();
  await quiet;
  expect(finished).toBe(false);
  pane.emit("wheel");
  pane.emit("scroll");
  pane.emit("scrollend");
  await Promise.resolve();
  expect(finished).toBe(false);
  pane.scrollTop = 50;
  pane.emit("scroll");
  await Promise.resolve();
  expect(finished).toBe(false);
  pane.emit("scrollend");
  await Reflect.get(pane, "wheelFinished");
  expect(finished).toBe(true);
  expect(removed.mock.calls.map(([type]) => type)).toEqual(["wheel", "scroll", "scrollend"]);
});

it("qualifies a prepend with restored scrollTop by its changed height after wheel input", async () => {
  const pane = new Pane();
  armNativeWheel(pane);
  let finished = false;
  Reflect.get(pane, "wheelFinished").then(() => {
    finished = true;
  });
  pane.scrollHeight = 2000;
  pane.emit("scroll");
  pane.emit("scrollend");
  await Promise.resolve();
  expect(finished).toBe(false);
  pane.emit("wheel");
  pane.emit("scroll");
  pane.emit("scrollend");
  await Promise.resolve();
  expect(finished).toBe(false);
  pane.scrollHeight = 3000;
  pane.emit("wheel");
  pane.emit("scroll");
  pane.emit("scrollend");
  await Reflect.get(pane, "wheelFinished");
  expect(pane.scrollTop).toBe(100);
  expect(finished).toBe(true);
});

it("registers a passive wheel observer without cancelling input", async () => {
  const pane = new Pane();
  const added = vi.spyOn(pane, "addEventListener");
  armNativeWheel(pane);
  expect(added.mock.calls.find(([type]) => type === "wheel")?.[2]).toEqual({ passive: true });
  const wheel = new Event("wheel", { cancelable: true });
  pane.dispatchEvent(wheel);
  expect(wheel.defaultPrevented).toBe(false);
  pane.scrollTop = 50;
  pane.emit("scroll");
  pane.emit("scrollend");
  await Reflect.get(pane, "wheelFinished");
});

it("qualifies an offset applied between arming and passive wheel delivery", async () => {
  const pane = new Pane();
  armNativeWheel(pane);
  let finished = false;
  Reflect.get(pane, "wheelFinished").then(() => {
    finished = true;
  });
  pane.scrollTop = 50;
  pane.emit("wheel");
  pane.emit("scroll");
  pane.emit("scrollend");
  await Promise.resolve();
  expect(finished).toBe(true);
});
