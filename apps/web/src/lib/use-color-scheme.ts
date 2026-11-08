import { useSyncExternalStore } from "react";
import type { ColorScheme } from "./design-tokens.ts";

const DARK_QUERY = "(prefers-color-scheme: dark)";

function subscribe(onChange: () => void): () => void {
  const media = window.matchMedia(DARK_QUERY);
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}

/** For renderers the stylesheet cannot reach; everything else follows the CSS media query. */
export function useColorScheme(): ColorScheme {
  return useSyncExternalStore(
    subscribe,
    () => (window.matchMedia(DARK_QUERY).matches ? "dark" : "light"),
    () => "light",
  );
}
