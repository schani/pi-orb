import { useEffect, useState, useSyncExternalStore } from "react";
import { describeApiError, probeSession } from "../lib/api.ts";
import { signIn } from "../lib/auth-navigation.ts";
import { readBrowserSession, subscribeToBrowserSession } from "../lib/session.ts";

export function SessionRibbon() {
  const session = useSyncExternalStore(
    subscribeToBrowserSession,
    readBrowserSession,
    readBrowserSession,
  );

  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let latest = 0;
    const probeAfterFocus = async () => {
      const request = ++latest;
      const result = await probeSession();
      if (request !== latest) return;
      setError(
        result.isErr() && result.error.type !== "auth_required"
          ? describeApiError(result.error)
          : null,
      );
    };
    void probeAfterFocus();
    window.addEventListener("focus", probeAfterFocus);
    return () => {
      latest += 1;
      window.removeEventListener("focus", probeAfterFocus);
    };
  }, []);

  if (session.status !== "auth_required" && error === null) return null;

  return (
    <div className="session-ribbon" role="alert">
      <span className="up">{error ?? "sign in required"}</span>
      {session.status === "auth_required" && (
        <button type="button" onClick={signIn}>
          sign in
        </button>
      )}
    </div>
  );
}
