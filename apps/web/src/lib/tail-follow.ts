import { isPinnedAfterScroll, type ScrollView } from "./scroll-pin.ts";

type TailOwnership =
  | { kind: "settled"; following: boolean }
  | { kind: "pointer"; following: boolean };

export interface TailFollowState {
  ownership: TailOwnership;
  previousView: ScrollView;
  autoScrollY: number | null;
}

export type TailFollowEvent =
  | { type: "pointerdown" }
  | { type: "reader-intent"; reason: "wheel" | "key" | "touch" }
  | { type: "pointerend"; view: ScrollView; reason: "pointerup" | "pointercancel" }
  | { type: "scroll" | "resize" | "keyend" | "compensated" | "tail-write"; view: ScrollView };

export function createTailFollowState(view: ScrollView): TailFollowState {
  return {
    ownership: { kind: "settled", following: true },
    previousView: view,
    autoScrollY: null,
  };
}

/** Only a geometry observer may act on writeTail; input handlers never write. */
export function transitionTailFollow(
  state: TailFollowState,
  event: TailFollowEvent,
): { state: TailFollowState; writeTail: boolean; reason: string } {
  const decision = (next: TailFollowState, reason: string = event.type, writeTail = false) => ({
    state: next,
    reason,
    writeTail,
  });
  switch (event.type) {
    case "pointerdown":
      return decision({
        ...state,
        ownership: { kind: "pointer", following: state.ownership.following },
      });
    case "reader-intent":
      return decision(
        {
          ...state,
          ownership: { ...state.ownership, following: false },
          autoScrollY: null,
        },
        event.reason,
      );
    case "compensated":
      return decision({ ...state, previousView: event.view });
    case "tail-write":
      return decision({ ...state, previousView: event.view, autoScrollY: event.view.scrollY });
    case "pointerend":
      if (state.ownership.kind !== "pointer") return decision(state);
  }

  const current = event.view;
  const moved = Math.abs(current.scrollY - state.previousView.scrollY) > 1;
  // A stationary release is not reader movement. Keep its pre-growth evidence
  // until the observer follows; a moving pointer must not inherit that protection.
  const protectGeometry =
    state.ownership.following &&
    (state.ownership.kind === "settled" || (event.type === "pointerend" && !moved));
  const following =
    event.type === "resize" && !moved
      ? state.ownership.following
      : isPinnedAfterScroll(
          event.type === "resize" && !state.ownership.following
            ? { ...state.previousView, scrollY: current.scrollY }
            : current,
          state.autoScrollY,
          protectGeometry ? state.previousView : undefined,
        );
  return decision(
    {
      ownership: {
        kind: event.type === "pointerend" ? "settled" : state.ownership.kind,
        following,
      },
      previousView: current,
      // A stationary pointer must not consume a delayed own-write event.
      autoScrollY:
        event.type === "scroll" || event.type === "keyend" || (event.type === "pointerend" && moved)
          ? null
          : state.autoScrollY,
    },
    event.type === "pointerend" ? event.reason : event.type === "keyend" ? "scroll" : event.type,
    event.type === "resize" && following,
  );
}
