import { Result } from "neverthrow";

/**
 * iOS home-screen apps open out-of-scope links in an in-app browser sheet with
 * its own cookie jar, where hosted-file Google sign-in never returns. The
 * undocumented `x-safari-` scheme hands the URL to Safari instead
 * (`docs/web-ui.md`).
 */
export function safariUrl(
  link: Pick<URL, "protocol" | "origin" | "href">,
  appOrigin: string,
): string | null {
  if (link.protocol !== "http:" && link.protocol !== "https:") return null;
  return link.origin === appOrigin ? null : `x-safari-${link.href}`;
}

export interface SafariLinkHost {
  /** `standalone` is Apple's non-standard home-screen flag. */
  readonly navigator: { readonly standalone?: unknown; readonly maxTouchPoints: number };
  readonly document: {
    addEventListener(type: "click", listener: (event: MouseEvent) => void, capture: true): void;
  };
  readonly location: { readonly origin: string; assign(url: string): void };
}

export function isIosStandalone(navigator: SafariLinkHost["navigator"]): boolean {
  return navigator.standalone === true && navigator.maxTouchPoints > 1;
}

/** Auth handoff also permits same-origin setup, before browser-bound cookies exist. */
export function safariAuthUrl(
  value: string,
  host: Pick<SafariLinkHost, "navigator" | "location"> = window,
): string | null {
  if (!isIosStandalone(host.navigator)) return null;
  let url: URL;
  try {
    url = new URL(value, host.location.origin);
  } catch {
    return null;
  }
  return safariUrl(url, "");
}

export function launchSafariAuth(
  url: string,
  host: Pick<SafariLinkHost, "location"> = window,
): Result<void, { type: "safari_launch_failed" }> {
  return Result.fromThrowable(
    () => host.location.assign(url),
    () => ({ type: "safari_launch_failed" as const }),
  )();
}

/**
 * Routes external link clicks to Safari, only in an iOS/iPadOS standalone app.
 * `maxTouchPoints` excludes macOS Safari web apps, which already open links in
 * the default browser.
 */
export function installSafariLinks(
  host: SafariLinkHost,
  navigate: (url: string) => void = (url) => host.location.assign(url),
): boolean {
  if (!isIosStandalone(host.navigator)) return false;
  const appOrigin = host.location.origin;
  host.document.addEventListener(
    "click",
    (event) => {
      if (event.defaultPrevented || event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const target = event.target as Partial<Pick<Element, "closest">> | null;
      const link = target?.closest?.<HTMLAnchorElement>("a[href]");
      const url = link ? safariUrl(link, appOrigin) : null;
      if (url === null) return;
      event.preventDefault();
      navigate(url);
    },
    true,
  );
  return true;
}
