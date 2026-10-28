import { useEffect, useRef, useState } from "react";
import {
  connectMcpOAuth,
  describeApiError,
  disconnectMcpOAuth,
  getMcpOAuthStatus,
} from "../lib/api.ts";
import { launchSafariAuth, safariAuthUrl } from "../lib/safari-links.ts";

/** One owner for the summary status and actions; stale reads cannot undo a mutation. */
export function useMcpAuthorization(
  projectId: string,
  id: string | undefined,
  setSaving: (value: boolean) => void,
) {
  const [status, setStatus] = useState("");
  const [error, setError] = useState<string | null>(null);
  const lifetime = useRef(0);
  const reads = useRef(0);
  useEffect(() => {
    const epoch = ++lifetime.current;
    setStatus("");
    setError(null);
    const refresh = () => {
      if (!id) return;
      const request = ++reads.current;
      void getMcpOAuthStatus(projectId, id).then((result) => {
        if (lifetime.current !== epoch || request !== reads.current) return;
        if (result.isOk()) {
          setStatus(result.value.status);
          setError(null);
        } else setError(describeApiError(result.error));
      });
    };
    const visible = () => {
      if (document.visibilityState === "visible") refresh();
    };
    refresh();
    document.addEventListener("visibilitychange", visible);
    window.addEventListener("focus", refresh);
    return () => {
      lifetime.current++;
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [projectId, id]);
  const act = async (operation: "connect" | "disconnect") => {
    if (!id) return;
    reads.current++;
    if (operation === "connect") {
      const safari = safariAuthUrl(`/projects/${encodeURIComponent(projectId)}/mcp`);
      if (safari !== null) {
        setSaving(false);
        const launched = launchSafariAuth(safari);
        setError(launched.isErr() ? "Could not open Safari. Try Connect again." : null);
        return;
      }
    }
    const epoch = lifetime.current;
    setSaving(true);
    setError(null);
    const result = await (operation === "connect"
      ? connectMcpOAuth(projectId, id)
      : disconnectMcpOAuth(projectId, id));
    if (lifetime.current !== epoch) {
      setSaving(false);
      return;
    }
    reads.current++;
    if (result.isOk() && "url" in result.value) {
      window.location.assign(result.value.url);
      return;
    }
    if (result.isOk() && "status" in result.value) setStatus(result.value.status);
    else if (result.isErr()) {
      setError(describeApiError(result.error));
      const request = ++reads.current;
      const current = await getMcpOAuthStatus(projectId, id);
      if (lifetime.current === epoch && request === reads.current && current.isOk())
        setStatus(current.value.status);
    }
    setSaving(false);
  };
  return { status, error, connect: () => act("connect"), disconnect: () => act("disconnect") };
}
