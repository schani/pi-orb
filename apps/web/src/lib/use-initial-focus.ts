import { type RefObject, useEffect } from "react";

/** Pass a stable useRef: focus on mount, never on changing callbacks or form state. */
export function useInitialFocus(target: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    target.current?.focus();
  }, [target]);
}
