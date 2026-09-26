import { useState, useSyncExternalStore } from "react";
import { describeApiError, logout } from "../lib/api.ts";
import { readLogoutAvailable, subscribeToBrowserSession } from "../lib/session.ts";

export function LogoutButton() {
  const available = useSyncExternalStore(
    subscribeToBrowserSession,
    readLogoutAvailable,
    readLogoutAvailable,
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!available) return null;
  const signOut = async () => {
    setPending(true);
    setError(null);
    const result = await logout();
    if (result.isErr()) {
      setError(describeApiError(result.error));
      setPending(false);
    }
  };
  return (
    <>
      <button type="button" disabled={pending} onClick={() => void signOut()}>
        Sign out
      </button>
      {error !== null && <span role="alert">{error}</span>}
    </>
  );
}
