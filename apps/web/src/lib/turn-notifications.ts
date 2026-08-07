const displayed = new Set<string>();

export type BrowserNotificationPermission = "default" | "denied" | "granted" | "unsupported";

export function notificationPermission(): BrowserNotificationPermission {
  return "Notification" in window ? Notification.permission : "unsupported";
}

export async function requestNotificationPermission(): Promise<BrowserNotificationPermission> {
  if (!("Notification" in window)) return "unsupported";
  try {
    return await Notification.requestPermission();
  } catch {
    return Notification.permission;
  }
}

export function shouldDisplayTurnNotification(options: {
  readonly permission: BrowserNotificationPermission;
  readonly visibility: DocumentVisibilityState;
  readonly focused: boolean;
  readonly alreadyDisplayed: boolean;
}): boolean {
  return (
    options.permission === "granted" &&
    !(options.visibility === "visible" && options.focused) &&
    !options.alreadyDisplayed
  );
}

/** Live-only, best-effort notification. The protocol intentionally never replays this event. */
export function showTurnNotification(options: {
  readonly orbId: string;
  readonly operationId: string;
  readonly summary: string;
}): void {
  if (!("Notification" in window)) return;
  const key = `${options.orbId}:${options.operationId}`;
  if (
    !shouldDisplayTurnNotification({
      permission: Notification.permission,
      visibility: document.visibilityState,
      focused: document.hasFocus(),
      alreadyDisplayed: displayed.has(key),
    })
  ) {
    return;
  }
  displayed.add(key);

  // Browsers replace same-origin notifications sharing a tag. This also suppresses duplicate
  // notifications when more than one open tab receives the runtime broadcast.
  try {
    const notification = new Notification(`Orb ${options.orbId} finished`, {
      body: options.summary,
      tag: key,
    });
    notification.onclick = () => {
      window.focus();
      window.location.hash = `#/orbs/${encodeURIComponent(options.orbId)}`;
      notification.close();
    };
  } catch {
    // Notification construction is best-effort even after permission was granted (for example,
    // some mobile browsers expose the API but require a service worker).
    displayed.delete(key);
  }
}
