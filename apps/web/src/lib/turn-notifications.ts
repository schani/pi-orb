const displayed = new Set<string>();

export type BrowserNotificationPermission = "default" | "denied" | "granted" | "unsupported";

export type TurnNotificationResult =
  | { readonly type: "shown" }
  | {
      readonly type: "skipped";
      readonly reason: "unsupported" | "permission_default" | "permission_denied" | "duplicate";
    }
  | { readonly type: "failed"; readonly message: string };

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

export function notificationDecision(
  permission: BrowserNotificationPermission,
  alreadyDisplayed: boolean,
): TurnNotificationResult | null {
  if (permission === "unsupported") return { type: "skipped", reason: "unsupported" };
  if (permission === "default") return { type: "skipped", reason: "permission_default" };
  if (permission === "denied") return { type: "skipped", reason: "permission_denied" };
  if (alreadyDisplayed) return { type: "skipped", reason: "duplicate" };
  return null;
}

/** Live-only, best-effort notification. The protocol intentionally never replays this event. */
export function showTurnNotification(options: {
  readonly orbId: string;
  readonly operationId: string;
  readonly summary: string;
}): TurnNotificationResult {
  const permission = notificationPermission();
  const key = `${options.orbId}:${options.operationId}`;
  const decision = notificationDecision(permission, displayed.has(key));
  if (decision !== null) return decision;
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
    return { type: "shown" };
  } catch (cause) {
    // Notification construction is best-effort even after permission was granted (for example,
    // some mobile browsers expose the API but require a service worker).
    displayed.delete(key);
    return {
      type: "failed",
      message: cause instanceof Error ? cause.message : String(cause),
    };
  }
}

export function describeTurnNotificationResult(result: TurnNotificationResult): string {
  if (result.type === "shown") return "Desktop notification sent for this turn.";
  if (result.type === "failed") return `Desktop notification failed: ${result.message}`;
  switch (result.reason) {
    case "unsupported":
      return "Desktop notification unavailable: this page is not in a secure browser context.";
    case "permission_default":
      return "Desktop notification not sent: enable notifications in the orb header.";
    case "permission_denied":
      return "Desktop notification not sent: notifications are blocked in browser settings.";
    case "duplicate":
      return "Desktop notification already handled for this turn.";
  }
}
