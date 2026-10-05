import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { DetailContext } from "../components/DetailBody.tsx";
import { type ActivityHeadlineSource, HeadlineLimiter } from "./activity-headline.ts";
import { getActivityHeadline } from "./api.ts";

export const HeadlineSlots = createContext<HeadlineLimiter | null>(null);
type State = { key: string; text?: string; failed?: boolean };

export function useActivityHeadline(
  source: ActivityHeadlineSource | undefined,
  context: Pick<DetailContext, "orbId" | "sessionId">,
  fallback?: string,
) {
  const shared = useContext(HeadlineSlots);
  const local = useMemo(() => new HeadlineLimiter(), []);
  const slots = shared ?? local;
  const [header, headerRef] = useState<HTMLElement | null>(null);
  const request = useRef<{
    seen: boolean;
    begin: () => void;
  } | null>(null);
  const { orbId, sessionId } = context;
  const recordId = source?.recordId;
  const detailKey = source?.detailKey;
  const key =
    source && context.sessionId
      ? JSON.stringify([context.orbId, context.sessionId, source.recordId, source.detailKey])
      : "";
  const [state, setState] = useState<State>({ key: "" });
  const current = useRef(state);
  const qualified = useRef({ key: "", seen: false });
  const [attempt, setAttempt] = useState(0);
  const marker = source?.headline;

  // biome-ignore lint/correctness/useExhaustiveDependencies: Manual Retry starts a new request for the same source.
  useEffect(() => {
    if (qualified.current.key !== key) qualified.current = { key, seen: false };
    if (!key) return;
    if (current.current.key !== key) current.current = { key };
    if (typeof marker === "string") {
      current.current = { key, text: marker };
      setState(current.current);
      return;
    }
    if (marker !== null || current.current.text !== undefined || current.current.failed) return;
    if (!recordId || !detailKey || !sessionId) return;
    const controller = new AbortController();
    let removeQueued: (() => void) | undefined;
    const owned = {
      seen: false,
      begin: () => {
        if (owned.seen || controller.signal.aborted) return;
        owned.seen = true;
        qualified.current.seen = true;
        removeQueued = slots.enqueue((release) => {
          void getActivityHeadline(orbId, recordId, detailKey, sessionId, controller.signal).then(
            (result) => {
              release();
              if (controller.signal.aborted) return;
              current.current = result.isOk()
                ? { key, text: result.value.headline }
                : { key, failed: true };
              setState(current.current);
            },
          );
        });
      },
    };
    request.current = owned;
    if (qualified.current.seen) owned.begin();
    return () => {
      request.current = null;
      removeQueued?.();
      controller.abort();
    };
  }, [key, marker, attempt, slots, orbId, sessionId, recordId, detailKey]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: Retarget visibility independently of the source-owned request lifetime.
  useEffect(() => {
    const owned = request.current;
    if (!header || !owned || owned.seen) return;
    let observing = true;
    let observer: IntersectionObserver | null = null;
    const retarget = () => {
      observer?.disconnect();
      observer = null;
      if (!observing || owned.seen || document.visibilityState !== "visible") return;
      const fresh = new IntersectionObserver((entries) => {
        if (
          !observing ||
          observer !== fresh ||
          request.current !== owned ||
          document.visibilityState !== "visible"
        )
          return;
        if (
          !entries.some(
            (entry) =>
              entry.target === header &&
              entry.isIntersecting &&
              entry.intersectionRect.width > 0 &&
              entry.intersectionRect.height > 0,
          )
        )
          return;
        owned.begin();
        fresh.disconnect();
        observer = null;
        document.removeEventListener("visibilitychange", retarget);
      });
      observer = fresh;
      fresh.observe(header);
    };
    retarget();
    document.addEventListener("visibilitychange", retarget);
    return () => {
      observing = false;
      observer?.disconnect();
      observer = null;
      document.removeEventListener("visibilitychange", retarget);
    };
  }, [header, key, marker, attempt, slots]);

  const retry = () => {
    current.current = { key };
    setState(current.current);
    setAttempt((value) => value + 1);
  };
  const text = typeof marker === "string" ? marker : state.key === key ? state.text : undefined;
  const failed = state.key === key && state.failed === true;
  return {
    headerRef,
    headline: failed ? (
      <>
        <span>Summary unavailable.</span>{" "}
        <button
          type="button"
          className="text-action activity-headline-retry"
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            retry();
          }}
        >
          Retry
        </button>
      </>
    ) : (
      (text ?? fallback)
    ),
  };
}
