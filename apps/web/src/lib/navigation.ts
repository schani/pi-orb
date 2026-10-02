import { Result } from "neverthrow";

const changed = "pi-orb:navigate";
type NavigationError = { type: "navigation_failed" };

export function isAppPath(path: string): boolean {
  return (
    !/^\/(?:api|assets|favicons|s|mcp|oauth|runtime|\.well-known)(?:\/|$)/.test(path) &&
    !/\.[^/]+$/.test(path)
  );
}

export function shouldNavigate(
  event: MouseEvent,
  anchor: Pick<HTMLAnchorElement, "href" | "target"> & { download: boolean },
  origin: string,
): boolean {
  if (
    event.defaultPrevented ||
    event.button !== 0 ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey ||
    (anchor.target && anchor.target !== "_self") ||
    anchor.download
  )
    return false;
  try {
    const url = new URL(anchor.href);
    return url.origin === origin && isAppPath(url.pathname);
  } catch {
    return false;
  }
}

export function navigate(path: string, replace = false): Result<void, NavigationError> {
  const update = Result.fromThrowable(
    () => {
      if (replace) window.history.replaceState(null, "", path);
      else window.history.pushState(null, "", path);
      window.dispatchEvent(new Event(changed));
    },
    (): NavigationError => ({ type: "navigation_failed" }),
  )();
  return update.isOk()
    ? update
    : Result.fromThrowable(
        () => (replace ? window.location.replace(path) : window.location.assign(path)),
        (): NavigationError => ({ type: "navigation_failed" }),
      )();
}

export function subscribeNavigation(onChange: () => void): () => void {
  const onClick = (event: MouseEvent) => {
    const target = event.target;
    const anchor = target instanceof Element ? target.closest<HTMLAnchorElement>("a[href]") : null;
    if (
      !anchor ||
      !shouldNavigate(
        event,
        { href: anchor.href, target: anchor.target, download: anchor.hasAttribute("download") },
        window.location.origin,
      )
    )
      return;
    const url = new URL(anchor.href);
    // Native fragment-only and query-only navigation retains its browser semantics.
    if (url.pathname === window.location.pathname) {
      if (url.search !== window.location.search || url.hash !== window.location.hash) return;
      event.preventDefault();
      return;
    }
    if (navigate(url.pathname + url.search + url.hash).isOk()) event.preventDefault();
  };
  window.addEventListener("click", onClick);
  window.addEventListener("popstate", onChange);
  window.addEventListener(changed, onChange);
  return () => {
    window.removeEventListener("click", onClick);
    window.removeEventListener("popstate", onChange);
    window.removeEventListener(changed, onChange);
  };
}

export function readPath(): string {
  return window.location.pathname;
}
