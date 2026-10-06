import type { ReactNode } from "react";

/** A lifecycle, auth, or error diagnostic. */
export function OrbNotice({ error = false, children }: { error?: boolean; children: ReactNode }) {
  return (
    <div className="rec rec-sys orb-notice">
      <div className={error ? "rec-bd notice notice-error" : "rec-bd notice"}>{children}</div>
    </div>
  );
}
