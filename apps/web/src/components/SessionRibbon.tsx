import { useEffect, useSyncExternalStore } from "react";
import { probeSession } from "../lib/api.ts";
import { readBrowserSession, subscribeToBrowserSession } from "../lib/session.ts";

export function SessionRibbon() {
  const session = useSyncExternalStore(
    subscribeToBrowserSession,
    readBrowserSession,
    readBrowserSession,
  );

  useEffect(() => {
    const probeAfterFocus = () => {
      void probeSession();
    };
    window.addEventListener("focus", probeAfterFocus);
    return () => window.removeEventListener("focus", probeAfterFocus);
  }, []);

  if (session.status !== "auth_required") return null;

  return (
    <div className="session-ribbon" role="alert">
      <span className="up">session expired</span>
      <button
        type="button"
        onClick={() => {
          // A top-level same-tab navigation lets IAP run its ordinary Google
          // login redirect. Fetching or opening an app copy in another tab
          // leaves this tab's failed session state behind.
          window.location.reload();
        }}
      >
        sign in again
      </button>
    </div>
  );
}
