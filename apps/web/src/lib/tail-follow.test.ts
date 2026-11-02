import { describe, expect, it } from "vitest";
import { createTailFollowState, transitionTailFollow } from "./tail-follow.ts";

const bottom = { scrollY: 600, viewportHeight: 400, contentHeight: 1000 };
const grown = { ...bottom, contentHeight: 1800 };
const step = transitionTailFollow;

describe("OrbPage tail gesture ownership", () => {
  it.each(["pointerup", "pointercancel"] as const)(
    "retains stationary %s through growth before the observer, without requesting a pointer write",
    (reason) => {
      const pressed = step(createTailFollowState(bottom), { type: "pointerdown" }).state;
      const settled = step(pressed, { type: "pointerend", view: grown, reason });
      expect(settled.state.ownership).toEqual({ kind: "settled", following: true });
      expect(settled.writeTail).toBe(false);
      expect(step(settled.state, { type: "resize", view: grown }).writeTail).toBe(true);
    },
  );

  it("releases a moving pointer even when growth precedes settlement", () => {
    const pressed = step(createTailFollowState(bottom), { type: "pointerdown" }).state;
    const settled = step(pressed, {
      type: "pointerend",
      view: { ...grown, scrollY: 300 },
      reason: "pointerup",
    });
    expect(settled.state.ownership).toEqual({ kind: "settled", following: false });
    expect(step(settled.state, { type: "resize", view: grown }).writeTail).toBe(false);
  });

  it.each(["scroll", "resize"] as const)("resolves native pointer movement before %s", (type) => {
    const pressed = step(createTailFollowState(bottom), { type: "pointerdown" }).state;
    const moved = step(pressed, { type, view: { ...grown, scrollY: 300 } });
    expect(moved.state.ownership).toEqual({ kind: "pointer", following: false });
    expect(moved.writeTail).toBe(false);
  });

  it("keeps a pending own-write identity through press, stationary release, and resize until scroll acknowledgment", () => {
    let state = step(createTailFollowState(bottom), { type: "tail-write", view: bottom }).state;
    state = step(state, { type: "pointerdown" }).state;
    state = step(state, { type: "pointerend", view: grown, reason: "pointerup" }).state;
    expect(state.autoScrollY).toBe(600);
    state = step(state, { type: "resize", view: grown }).state;
    expect(state.autoScrollY).toBe(600);
    state = step(state, { type: "scroll", view: grown }).state;
    expect(state.ownership.following).toBe(true);
    expect(state.autoScrollY).toBeNull();
  });

  it("accepts a delayed own scroll while the pointer is down, but not a changed reader offset", () => {
    let state = step(createTailFollowState(bottom), { type: "tail-write", view: bottom }).state;
    state = step(state, { type: "pointerdown" }).state;
    expect(step(state, { type: "scroll", view: grown }).state.ownership.following).toBe(true);
    expect(
      step(state, { type: "scroll", view: { ...grown, scrollY: 300 } }).state.ownership.following,
    ).toBe(false);
  });

  it.each(["wheel", "touch", "key"] as const)(
    "releases on %s intent before momentum and growth",
    (reason) => {
      let state = step(createTailFollowState(bottom), { type: "pointerdown" }).state;
      state = step(state, { type: "pointerend", view: bottom, reason: "pointercancel" }).state;
      state = step(state, { type: "reader-intent", reason }).state;
      const momentum = { ...grown, scrollY: 300 };
      const decision = step(state, { type: "resize", view: momentum });
      expect(decision.state.ownership.following).toBe(false);
      expect(decision.writeTail).toBe(false);
    },
  );

  it.each(["scroll", "resize"] as const)("retains native clamping protection before %s", (type) => {
    const decision = step(createTailFollowState(bottom), {
      type,
      view: { ...grown, scrollY: 580 },
    });
    expect(decision.state.ownership.following).toBe(true);
  });

  it("resolves a reading viewport against its previous geometry on resize", () => {
    let state = step(createTailFollowState(bottom), {
      type: "reader-intent",
      reason: "touch",
    }).state;
    state = step(state, { type: "compensated", view: { ...bottom, scrollY: 300 } }).state;
    const decision = step(state, { type: "resize", view: { ...grown, scrollY: 600 } });
    expect(decision.state.ownership.following).toBe(true);
    // Resize resolves a reading viewport against its previous geometry, as before.
    // A viewport still off that previous tail must remain reading.
    expect(step(state, { type: "resize", view: { ...grown, scrollY: 350 } }).writeTail).toBe(false);
  });

  it("keeps no-op End resolution and keyup acknowledgment semantics", () => {
    let state = step(createTailFollowState(bottom), { type: "reader-intent", reason: "key" }).state;
    state = step(state, { type: "keyend", view: bottom }).state;
    expect(state.ownership.following).toBe(true);
    expect(state.autoScrollY).toBeNull();
    state = step(state, { type: "tail-write", view: bottom }).state;
    expect(step(state, { type: "keyend", view: bottom }).state.autoScrollY).toBeNull();
  });

  it.each(["pointerup", "pointercancel"] as const)(
    "discards an old own-write target after moved %s before later geometry returns to that offset",
    (reason) => {
      let state = step(createTailFollowState(bottom), { type: "tail-write", view: bottom }).state;
      state = step(state, { type: "pointerdown" }).state;
      const moved = step(state, { type: "pointerend", view: { ...grown, scrollY: 300 }, reason });
      expect(moved.state.ownership.following).toBe(false);
      const later = step(moved.state, {
        type: "resize",
        view: { ...grown, scrollY: 600, contentHeight: 2100 },
      });
      expect(later.state.ownership.following).toBe(false);
      expect(later.writeTail).toBe(false);
      expect(moved.state.autoScrollY).toBeNull();
    },
  );

  it("compensation advances geometry without changing pin or pending acknowledgment", () => {
    let state = step(createTailFollowState(bottom), { type: "tail-write", view: bottom }).state;
    state = step(state, { type: "compensated", view: grown }).state;
    expect(state.previousView).toEqual(grown);
    expect(state.ownership.following).toBe(true);
    expect(state.autoScrollY).toBe(600);
  });

  it("ignores window settlements without an owned pointer", () => {
    const state = createTailFollowState(bottom);
    expect(step(state, { type: "pointerend", view: grown, reason: "pointerup" }).state).toBe(state);
  });
});
